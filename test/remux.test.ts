import { describe, expect, it } from 'vitest';
import { FormatError, UnsupportedError } from '../src/lib/bytes';
import { parseAvi } from '../src/lib/avi';
import { remuxAviToMp4 } from '../src/lib/remux';
import { frameOrder, parseSps, splitAnnexB, toLengthPrefixed } from '../src/lib/h264';
import { splitMp3 } from '../src/lib/mp3';
import { annexB, boxes, buildAvi, joinParts, mp3Frame, pps, readTracks, slice, sps } from './builders';

const idrFrame = () => annexB(sps(), pps(), slice({ idr: true, poc: 0 }));
// Decoding order I0 P6 B2 B4 P12 B8 B10: shown in the order of the counts.
const gop = () => [
  idrFrame(),
  annexB(slice({ poc: 6, frameNum: 1 })),
  annexB(slice({ poc: 2, frameNum: 2, ref: false })),
  annexB(slice({ poc: 4, frameNum: 2, ref: false })),
  annexB(slice({ poc: 12, frameNum: 2 })),
  annexB(slice({ poc: 8, frameNum: 3, ref: false })),
  annexB(slice({ poc: 10, frameNum: 3, ref: false })),
];

describe('AVI reading', () => {
  it('reads the streams and the samples', () => {
    const avi = parseAvi(buildAvi({ frames: gop(), scale: 1001, rate: 30000 }));
    expect(avi.video).toMatchObject({ codec: 'H264', width: 320, height: 240, scale: 1001, rate: 30000 });
    expect(avi.audio).toBeNull();
    expect(avi.samples).toHaveLength(7);
    expect(avi.samples[0].keyframe).toBe(true);
    expect(avi.samples[1].keyframe).toBe(false);
  });

  it('scans the movie when there is no index', () => {
    const avi = parseAvi(buildAvi({ frames: gop(), noIndex: true }));
    expect(avi.samples).toHaveLength(7);
  });

  it('rejects what is not an AVI', () => {
    expect(() => parseAvi(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]))).toThrow(FormatError);
    expect(() => parseAvi(buildAvi({ frames: gop() }).subarray(0, 100))).toThrow(FormatError);
  });
});

describe('H.264 helpers', () => {
  it('splits Annex B data and rewrites it with lengths', () => {
    const nals = splitAnnexB(idrFrame());
    expect(nals.map((n) => n[0] & 0x1f)).toEqual([7, 8, 5]);
    const out = toLengthPrefixed(nals); // the parameter sets stay in the header, not in the frame
    expect(new DataView(out.buffer).getUint32(0)).toBe(nals[2].length);
    expect(out.length).toBe(4 + nals[2].length);
  });

  it('reads the sequence parameter set', () => {
    expect(parseSps(sps())).toMatchObject({ profile: 66, level: 30, pocType: 0, log2MaxPocLsb: 8, log2MaxFrameNum: 4, frameMbsOnly: true });
    expect(parseSps(new Uint8Array([0x67, 1]))).toBeNull();
  });

  it('orders the frames by picture order count', () => {
    const frames = splitFirstSlices(gop());
    const order = frameOrder(frames, parseSps(sps()));
    // decode order 0..6 -> shown at: 0 I, 3 P6, 1 B2, 2 B4, 6 P12, 4 B8, 5 B10
    expect(order.shift.map((s, i) => i + s)).toEqual([0, 3, 1, 2, 6, 4, 5]);
    expect(order.maxEarly).toBe(1);
  });

  it('keeps the order when there is no reordering', () => {
    const plain = [idrFrame(), annexB(slice({ poc: 2 })), annexB(slice({ poc: 4 }))];
    const order = frameOrder(splitFirstSlices(plain), parseSps(sps()));
    expect(order.shift).toEqual([0, 0, 0]);
    expect(order.maxEarly).toBe(0);
  });
});

function splitFirstSlices(frames: Uint8Array[]) {
  return frames.map((f) => {
    const nals = splitAnnexB(f);
    const first = nals.find((n) => (n[0] & 0x1f) >= 1 && (n[0] & 0x1f) <= 5)!;
    return { slice: first, idr: nals.some((n) => (n[0] & 0x1f) === 5) };
  });
}

describe('re-wrapping into MP4', () => {
  it('writes sample tables that match the data', async () => {
    const result = await remuxAviToMp4(buildAvi({ frames: gop(), scale: 1, rate: 25 }));
    const mp4 = joinParts(result.parts);
    expect(boxes(mp4).map((b) => b.type)).toEqual(['ftyp', 'moov', 'mdat']);
    const [video] = readTracks(mp4);
    expect(video.handler).toBe('vide');
    expect(video.timescale).toBe(25);
    expect(video.sampleSizes).toHaveLength(7);
    expect(video.durations).toEqual(new Array(7).fill(1));
    expect(video.syncSamples).toEqual([1]);
    // frames shown at 0 3 1 2 6 4 5, delayed by one frame: offset = shown - decoded + 1
    expect(video.compositionOffsets).toEqual([1, 3, 0, 0, 3, 0, 0]);
    expect(video.editMediaTime).toBe(1);
    // every offset points at the bytes of its own frame
    const expected = gop().map((f) => toLengthPrefixed(splitAnnexB(f)));
    video.offsets.forEach((offset, i) => {
      expect([...mp4.subarray(offset, offset + video.sampleSizes[i])]).toEqual([...expected[i]]);
    });
    expect(result.width).toBe(320);
    expect(result.durationMs).toBe(240);
  });

  it('carries MP3 sound, one frame per sample', async () => {
    const frames = [idrFrame(), annexB(slice({ poc: 2 })), annexB(slice({ poc: 4 }))];
    const chunk = Uint8Array.from([...mp3Frame(), ...mp3Frame(1)]); // two frames in one chunk
    const result = await remuxAviToMp4(buildAvi({ frames, audio: { formatTag: 0x55, chunks: [chunk, chunk, chunk] } }));
    const mp4 = joinParts(result.parts);
    const [, audio] = readTracks(mp4);
    expect(audio.handler).toBe('soun');
    expect(audio.timescale).toBe(44100);
    expect(audio.sampleSizes).toEqual([417, 418, 417, 418, 417, 418]);
    expect(audio.durations).toEqual(new Array(6).fill(1152));
    expect(result.notes).toEqual([]);
  });

  it('leaves out sound it cannot carry and says so', async () => {
    const frames = [idrFrame(), annexB(slice({ poc: 2 }))];
    const result = await remuxAviToMp4(buildAvi({ frames, audio: { formatTag: 1, chunks: [new Uint8Array(100), new Uint8Array(100)] } }));
    expect(readTracks(joinParts(result.parts))).toHaveLength(1);
    expect(result.notes[0]).toMatch(/0x1/);
  });

  it('refuses a codec a browser cannot play, naming it', async () => {
    const error = await remuxAviToMp4(buildAvi({ codec: 'XVID', frames: [new Uint8Array(50)] })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnsupportedError);
    expect((error as UnsupportedError).codec).toBe('XVID');
  });

  it('rejects video without parameter sets', async () => {
    await expect(remuxAviToMp4(buildAvi({ frames: [annexB(slice({ idr: true, poc: 0 }))] }))).rejects.toThrow(FormatError);
  });

  it('reports progress and finishes at 1', async () => {
    const seen: number[] = [];
    await remuxAviToMp4(buildAvi({ frames: gop() }), { onProgress: (p) => seen.push(p) });
    expect(seen[seen.length - 1]).toBe(1);
  });
});

describe('MP3', () => {
  it('skips bytes that are not a frame', () => {
    const data = Uint8Array.from([0, 0, 0, ...mp3Frame(), 7, ...mp3Frame()]);
    expect(splitMp3(data).map((f) => f.data.length)).toEqual([417, 417]);
  });
});
