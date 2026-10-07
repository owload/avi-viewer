import { describe, expect, it } from 'vitest';
import { FormatError, UnsupportedError } from '../src/lib/bytes';
import { parseAvi } from '../src/lib/avi';
import { remuxAviToMp4 } from '../src/lib/remux';
import { renderAviPreview } from '../src/lib/preview';
import { annexB, buildAvi, mp3Frame, pps, slice, sps } from './builders';

/** A small deterministic random generator, so a failure can be repeated. */
function random(seed: number) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x / 2 ** 32;
  };
}

const valid = () => buildAvi({
  frames: [
    annexB(sps(), pps(), slice({ idr: true, poc: 0 })),
    annexB(slice({ poc: 6, frameNum: 1 })),
    annexB(slice({ poc: 2, frameNum: 2, ref: false })),
    annexB(slice({ poc: 4, frameNum: 2, ref: false })),
  ],
  audio: { formatTag: 0x55, chunks: [mp3Frame(), mp3Frame(), mp3Frame(), mp3Frame()] },
});

const acceptable = (e: unknown) => e instanceof FormatError || e instanceof UnsupportedError;

describe('damaged files (an AVI is untrusted input)', () => {
  it('ends in a FormatError or an UnsupportedError, never in another error, for random damage', async () => {
    const rnd = random(12345);
    const source = valid();
    for (let round = 0; round < 600; round++) {
      const data = Uint8Array.from(source);
      const hits = 1 + Math.floor(rnd() * 8);
      for (let i = 0; i < hits; i++) data[Math.floor(rnd() * data.length)] = Math.floor(rnd() * 256);
      try {
        await remuxAviToMp4(data);
      } catch (e) {
        expect(acceptable(e), `round ${round}: ${String(e)}`).toBe(true);
      }
    }
  });

  it('survives every cut of the file', async () => {
    const source = valid();
    for (let length = 0; length < source.length; length += 3) {
      try {
        await remuxAviToMp4(source.subarray(0, length));
      } catch (e) {
        expect(acceptable(e), `cut at ${length}: ${String(e)}`).toBe(true);
      }
    }
  });

  it('survives huge sizes in headers and an index that points far away', () => {
    const data = valid();
    const view = new DataView(data.buffer);
    for (let at = 12; at + 4 < data.length; at += 4) {
      const copy = Uint8Array.from(data);
      new DataView(copy.buffer).setUint32(at, 0xffffffff, true);
      try { parseAvi(copy); } catch (e) { expect(acceptable(e), `at ${at}: ${String(e)}`).toBe(true); }
    }
    void view;
  });

  it('does not loop for ever or recurse without end on nested lists', () => {
    // LIST inside LIST inside LIST ... in the movie: the reader has to stop.
    const depth = 20000;
    const file = new Uint8Array(12 + 12 + depth * 12);
    const view = new DataView(file.buffer);
    const put = (at: number, text: string) => { for (let i = 0; i < 4; i++) file[at + i] = text.charCodeAt(i); };
    put(0, 'RIFF'); view.setUint32(4, file.length - 8, true); put(8, 'AVI ');
    put(12, 'LIST'); view.setUint32(16, file.length - 20, true); put(20, 'movi');
    for (let i = 0; i < depth; i++) {
      const at = 24 + i * 12;
      put(at, 'LIST'); view.setUint32(at + 4, file.length - at - 8, true); put(at + 8, 'rec ');
    }
    expect(() => parseAvi(file)).toThrow(FormatError);
  });

  it('gives no preview for garbage and does not throw', async () => {
    expect(await renderAviPreview(new Uint8Array([1, 2, 3, 4]), 64)).toBeNull();
    expect(await renderAviPreview(valid().subarray(0, 40), 64)).toBeNull();
  });
});
