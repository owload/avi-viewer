import { parseAvi, type AviSample } from './avi';
import { FormatError, UnsupportedError, yieldToPage } from './bytes';
import { NAL_PPS, NAL_SLICE_IDR, NAL_SPS, buildAvcC, frameOrder, isAnnexB, nalType, parseSps, readAvcC, splitAnnexB, toLengthPrefixed } from './h264';
import { splitMp3, mp3SampleRate } from './mp3';
import { avc1, buildHead, mp4a, type Mp4Plan, type Mp4Sample, type Mp4Track } from './mp4';

export interface Remuxed {
  /** The MP4 file in pieces, to be put in a Blob. */
  parts: Uint8Array[];
  width: number;
  height: number;
  durationMs: number;
  /** Things the user should know: a sound that was left out. */
  notes: string[];
}

export interface RemuxOptions {
  /** Called now and then with how far the work has got, 0 to 1. */
  onProgress?: (fraction: number) => void;
}

const H264_CODECS = new Set(['h264', 'x264', 'avc1', 'davc', 'vssh']);
const AAC_TAGS = new Set([0xff, 0x1610]);
const MP3_TAG = 0x55;

/** The sample rates AAC streams are declared with, for building the AudioSpecificConfig when the file has none. */
const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

function audioSpecificConfig(sampleRate: number, channels: number): Uint8Array | null {
  const index = AAC_RATES.indexOf(sampleRate);
  if (index < 0) return null;
  const config = (2 << 11) | (index << 7) | (channels << 3); // AAC-LC
  return Uint8Array.of(config >> 8, config & 0xff);
}

function describeTag(tag: number): string {
  return `0x${tag.toString(16).toUpperCase()}`;
}

/**
 * Re-wraps the frames of an AVI file with H.264 video into an MP4, without decoding anything. Throws UnsupportedError
 * for a codec a browser could not play anyway and FormatError for a damaged file.
 */
export async function remuxAviToMp4(data: Uint8Array, options: RemuxOptions = {}): Promise<Remuxed> {
  const avi = parseAvi(data);
  const video = avi.video!;
  if (!H264_CODECS.has(video.codec.toLowerCase())) {
    throw new UnsupportedError(`The video of this file is coded as ${video.codec}, which a browser cannot play.`, video.codec);
  }
  const notes: string[] = [];

  const videoSamples = avi.samples.filter((s) => s.stream === video.index);
  const audioSamples = avi.audio ? avi.samples.filter((s) => s.stream === avi.audio!.index) : [];

  // The video frames.
  const bytesOf = (s: AviSample) => data.subarray(s.offset, s.offset + s.size);
  const annexB = videoSamples.length > 0 && isAnnexB(bytesOf(videoSamples.find((s) => s.size > 0) ?? videoSamples[0]));
  const frames: { nals: Uint8Array[]; sync: boolean }[] = [];
  const spsList: Uint8Array[] = [];
  const ppsList: Uint8Array[] = [];
  const report = options.onProgress ?? (() => undefined);

  // Parameter sets given in the stream header (an avcC, or Annex B).
  const fromHeader = readAvcC(video.extra);
  if (fromHeader) { spsList.push(...fromHeader.sps); ppsList.push(...fromHeader.pps); }
  else if (isAnnexB(video.extra)) {
    for (const nal of splitAnnexB(video.extra)) {
      if (nalType(nal) === NAL_SPS) spsList.push(nal);
      else if (nalType(nal) === NAL_PPS) ppsList.push(nal);
    }
  }

  for (let i = 0; i < videoSamples.length; i++) {
    const sample = bytesOf(videoSamples[i]);
    if (!annexB) {
      // Already length-prefixed (a stream with an avcC): read the lengths.
      const nals: Uint8Array[] = [];
      let at = 0;
      while (at + 4 <= sample.length) {
        const len = ((sample[at] << 24) | (sample[at + 1] << 16) | (sample[at + 2] << 8) | sample[at + 3]) >>> 0;
        if (len === 0 || at + 4 + len > sample.length) break;
        nals.push(sample.subarray(at + 4, at + 4 + len));
        at += 4 + len;
      }
      frames.push({ nals, sync: nals.some((n) => nalType(n) === NAL_SLICE_IDR) });
    } else {
      const nals = splitAnnexB(sample);
      for (const nal of nals) {
        const t = nalType(nal);
        if (t === NAL_SPS && !spsList.some((s) => s.length === nal.length && s.every((b, k) => b === nal[k]))) spsList.push(nal);
        else if (t === NAL_PPS && !ppsList.some((p) => p.length === nal.length && p.every((b, k) => b === nal[k]))) ppsList.push(nal);
      }
      frames.push({ nals, sync: nals.some((n) => nalType(n) === NAL_SLICE_IDR) });
    }
    if (i % 2000 === 1999) { report(0.5 * i / videoSamples.length); await yieldToPage(); }
  }
  if (spsList.length === 0 || ppsList.length === 0) throw new FormatError('The video has no parameter sets, so it cannot be played.');
  // Only the parameter sets of the first picture size go into the header; a stream that changes size is rare and not handled.
  const sps = spsList.slice(0, 1);
  const pps = ppsList.slice(0, 4);
  const spsInfo = parseSps(sps[0]);
  if (!frames.some((f) => f.sync)) frames[0].sync = true; // a stream without an IDR frame is played from its first frame

  // The order in which the frames are shown.
  const firstSlices = frames.map((f) => ({
    slice: f.nals.find((n) => { const t = nalType(n); return t >= 1 && t <= 5; }) ?? null,
    idr: f.sync,
  }));
  const order = frameOrder(firstSlices, spsInfo);

  const frameTicks = video.scale; // the timescale is `rate`, so a frame lasts `scale` ticks
  const videoTrackSamples: Mp4Sample[] = [];
  const videoPayloads: Uint8Array[] = [];
  frames.forEach((f, i) => {
    const payload = toLengthPrefixed(f.nals);
    videoPayloads.push(payload);
    videoTrackSamples.push({ size: payload.length, duration: frameTicks, offset: (order.shift[i] + order.maxEarly) * frameTicks, sync: f.sync });
  });
  report(0.6);

  const width = video.width || 0;
  const height = video.height || 0;
  const tracks: Mp4Track[] = [{
    kind: 'video',
    timescale: video.rate,
    samples: videoTrackSamples,
    description: avc1(width, height, buildAvcC(sps, pps)),
    width,
    height,
    skip: order.maxEarly * frameTicks,
  }];

  // The audio.
  const audioPayloads: Uint8Array[] = [];
  const audio = avi.audio;
  let audioTrack: Mp4Track | null = null;
  if (audio && audioSamples.length > 0) {
    if (audio.formatTag === MP3_TAG) {
      const joined = joinSamples(data, audioSamples);
      const parsed = splitMp3(joined);
      const rate = mp3SampleRate(joined) ?? audio.sampleRate;
      if (parsed.length > 0) {
        audioPayloads.push(...parsed.map((f) => f.data));
        audioTrack = {
          kind: 'audio', timescale: rate, width: 0, height: 0, skip: 0,
          samples: parsed.map((f) => ({ size: f.data.length, duration: f.samples, offset: 0, sync: true })),
          description: mp4a(audio.channels || 2, rate, 0x6b, null),
        };
      }
    } else if (AAC_TAGS.has(audio.formatTag)) {
      const config = audio.extra.length >= 2 ? audio.extra : audioSpecificConfig(audio.sampleRate, audio.channels || 2);
      if (config) {
        const real = audioSamples.filter((s) => s.size > 0);
        audioPayloads.push(...real.map(bytesOf));
        audioTrack = {
          kind: 'audio', timescale: audio.sampleRate, width: 0, height: 0, skip: 0,
          samples: real.map((s) => ({ size: s.size, duration: 1024, offset: 0, sync: true })),
          description: mp4a(audio.channels || 2, audio.sampleRate, 0x40, config),
        };
      }
    }
    if (!audioTrack) notes.push(`The sound of this file (format ${describeTag(audio.formatTag)}) cannot be played in a browser, so the video plays without it.`);
  }
  if (audioTrack) tracks.push(audioTrack);

  // The data goes into the file in the order of the AVI, as the frames and the sound were interleaved there.
  const plan: Mp4Plan = { tracks, order: interleave(avi.video!.rate / avi.video!.scale, videoPayloads.length, audioPayloads.length) };
  const { head } = buildHead(plan);
  const payloads = [videoPayloads, audioPayloads];
  const parts: Uint8Array[] = [head];
  for (const [t, s] of plan.order) parts.push(payloads[t][s]);
  report(1);

  const videoDurationMs = Math.round(videoTrackSamples.reduce((sum, s) => sum + s.duration, 0) * 1000 / video.rate - (order.maxEarly * frameTicks * 1000) / video.rate);
  return { parts, width, height, durationMs: videoDurationMs, notes };
}

function joinSamples(data: Uint8Array, samples: AviSample[]): Uint8Array {
  let size = 0;
  for (const s of samples) size += s.size;
  const out = new Uint8Array(size);
  let at = 0;
  for (const s of samples) { out.set(data.subarray(s.offset, s.offset + s.size), at); at += s.size; }
  return out;
}

/**
 * The order of the samples in the output. Video frames and sound are placed the way the AVI interleaves them; the
 * sound frames (which are re-cut from the chunks) are spread by time among the video frames.
 */
function interleave(fps: number, videoCount: number, audioCount: number): [number, number][] {
  const order: [number, number][] = [];
  if (audioCount === 0) {
    for (let i = 0; i < videoCount; i++) order.push([0, i]);
    return order;
  }
  // Put a block of sound after every second of video: simple, keeps both streams close together.
  const perSecond = Math.max(1, Math.round(fps));
  const audioPerVideo = audioCount / Math.max(1, videoCount);
  let audioDone = 0;
  for (let i = 0; i < videoCount; i++) {
    order.push([0, i]);
    if ((i + 1) % perSecond === 0 || i === videoCount - 1) {
      const target = i === videoCount - 1 ? audioCount : Math.min(audioCount, Math.round((i + 1) * audioPerVideo));
      while (audioDone < target) order.push([1, audioDone++]);
    }
  }
  return order;
}
