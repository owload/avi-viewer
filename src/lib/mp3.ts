/** Splits an MP3 stream into its frames: MP4 wants one frame per sample, the AVI chunks hold several. */

const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] } as const;

export interface Mp3Frame {
  data: Uint8Array;
  /** How many PCM samples the frame decodes to (1152, or 576 for the lower sample rates). */
  samples: number;
}

/** The size and length of the frame that starts at `at`, or null if there is no valid frame header. */
function readHeader(b: Uint8Array, at: number): { size: number; samples: number; sampleRate: number } | null {
  if (at + 4 > b.length || b[at] !== 0xff || (b[at + 1] & 0xe0) !== 0xe0) return null;
  const version = (b[at + 1] >> 3) & 3; // 3 = MPEG 1, 2 = MPEG 2, 0 = MPEG 2.5
  const layer = (b[at + 1] >> 1) & 3; // 1 = layer III
  if (version === 1 || layer !== 1) return null;
  const bitrateIndex = b[at + 2] >> 4;
  const rateIndex = (b[at + 2] >> 2) & 3;
  if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const padding = (b[at + 2] >> 1) & 1;
  const sampleRate = RATES[version as 0 | 2 | 3][rateIndex];
  const bitrate = (version === 3 ? BITRATES_V1 : BITRATES_V2)[bitrateIndex] * 1000;
  const samples = version === 3 ? 1152 : 576;
  const size = Math.floor((samples / 8) * bitrate / sampleRate) + padding;
  return { size, samples, sampleRate };
}

/** The sample rate and layer of the first frame, or null if the data does not start with an MP3 frame. */
export function mp3SampleRate(data: Uint8Array): number | null {
  for (let i = 0; i + 4 <= Math.min(data.length, 4096); i++) {
    const h = readHeader(data, i);
    if (h) return h.sampleRate;
  }
  return null;
}

/** Cuts the stream into frames, skipping bytes that are not a frame (tags, padding, damage). */
export function splitMp3(data: Uint8Array): Mp3Frame[] {
  const frames: Mp3Frame[] = [];
  let at = 0;
  while (at + 4 <= data.length) {
    const h = readHeader(data, at);
    if (!h || at + h.size > data.length) {
      if (h) break; // the last frame is cut
      at++;
      continue;
    }
    frames.push({ data: data.subarray(at, at + h.size), samples: h.samples });
    at += h.size;
  }
  return frames;
}
