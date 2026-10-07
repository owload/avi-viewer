/** Builds small AVI files and H.264-shaped data for the tests, and reads back the MP4 the viewer writes. */

class BitWriter {
  private bits: number[] = [];
  bit(v: number) { this.bits.push(v & 1); return this; }
  u(count: number, value: number) { for (let i = count - 1; i >= 0; i--) this.bit(Math.floor(value / 2 ** i)); return this; }
  ue(value: number) {
    const v = value + 1;
    const length = Math.floor(Math.log2(v));
    this.u(length, 0);
    this.u(length + 1, v);
    return this;
  }
  bytes(): Uint8Array {
    const bits = [...this.bits, 1];
    while (bits.length % 8) bits.push(0);
    const out = new Uint8Array(bits.length / 8);
    bits.forEach((b, i) => { out[i >> 3] |= b << (7 - (i & 7)); });
    return out;
  }
}

const START = [0, 0, 0, 1];

export function sps(): Uint8Array {
  const w = new BitWriter();
  w.u(8, 66).u(8, 0xc0).u(8, 30); // baseline, level 3.0
  w.ue(0); // sps id
  w.ue(0); // log2_max_frame_num - 4  -> 4 bits
  w.ue(0); // poc type 0
  w.ue(4); // log2_max_poc_lsb - 4    -> 8 bits
  w.ue(1); // max_num_ref_frames
  w.bit(0); // gaps
  w.ue(19); // width in macroblocks - 1  (320 px)
  w.ue(14); // height in map units - 1   (240 px)
  w.bit(1); // frame_mbs_only
  w.bit(1).bit(0).bit(0); // direct_8x8, cropping, vui
  return Uint8Array.from([0x67, ...w.bytes()]);
}

export function pps(): Uint8Array {
  return Uint8Array.from([0x68, 0xce, 0x3c, 0x80]);
}

/** A slice NAL unit: `idr` frames get type 5, others type 1 (`ref` false makes it a non-reference frame, like a B-frame). */
export function slice(options: { idr?: boolean; poc: number; frameNum?: number; ref?: boolean; fill?: number }): Uint8Array {
  const { idr = false, poc, frameNum = 0, ref = true, fill = 0xab } = options;
  const w = new BitWriter();
  w.ue(0).ue(idr ? 7 : 5).ue(0); // first_mb, slice_type, pps id
  w.u(4, frameNum);
  if (idr) w.ue(0);
  w.u(8, poc & 0xff);
  const header = idr ? 0x65 : ref ? 0x41 : 0x01;
  return Uint8Array.from([header, ...w.bytes(), fill, fill, fill]);
}

export function annexB(...nals: Uint8Array[]): Uint8Array {
  return Uint8Array.from(nals.flatMap((n) => [...START, ...n]));
}

export interface AviSpec {
  codec?: string;
  width?: number;
  height?: number;
  /** Frame rate as rate/scale. */
  scale?: number;
  rate?: number;
  /** Each frame as stored in the file. */
  frames: Uint8Array[];
  audio?: { formatTag: number; channels?: number; sampleRate?: number; extra?: number[]; chunks: Uint8Array[] };
  /** Leave the index out. */
  noIndex?: boolean;
}

const le32 = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
const le16 = (v: number) => [v & 255, (v >> 8) & 255];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

function chunk(id: string, payload: number[] | Uint8Array): number[] {
  const body = [...payload];
  const out = [...ascii(id), ...le32(body.length), ...body];
  if (body.length & 1) out.push(0);
  return out;
}

const list = (type: string, ...children: number[][]) => chunk('LIST', [...ascii(type), ...children.flat()]);

export function buildAvi(spec: AviSpec): Uint8Array {
  const { codec = 'H264', width = 320, height = 240, scale = 1, rate = 25 } = spec;
  const videoHeader = [...ascii('vids'), ...ascii(codec), ...le32(0), ...le16(0), ...le16(0), ...le32(0), ...le32(scale), ...le32(rate), ...le32(0), ...le32(spec.frames.length), ...le32(0), ...le32(0), ...le32(0), ...le32(0), ...le32(0)];
  const videoFormat = [...le32(40), ...le32(width), ...le32(height), ...le16(1), ...le16(24), ...ascii(codec), ...le32(0), ...le32(0), ...le32(0), ...le32(0), ...le32(0)];
  const strls = [list('strl', chunk('strh', videoHeader), chunk('strf', videoFormat))];
  if (spec.audio) {
    const a = spec.audio;
    const extra = a.extra ?? [];
    const audioHeader = [...ascii('auds'), ...le32(0), ...le32(0), ...le16(0), ...le16(0), ...le32(0), ...le32(1), ...le32(a.sampleRate ?? 44100), ...le32(0), ...le32(a.chunks.length), ...le32(0), ...le32(0), ...le32(0), ...le32(0), ...le32(0)];
    const audioFormat = [...le16(a.formatTag), ...le16(a.channels ?? 2), ...le32(a.sampleRate ?? 44100), ...le32(16000), ...le16(1), ...le16(16), ...le16(extra.length), ...extra];
    strls.push(list('strl', chunk('strh', audioHeader), chunk('strf', audioFormat)));
  }
  const avih = chunk('avih', [...le32(40000), ...le32(0), ...le32(0), ...le32(0x10), ...le32(spec.frames.length), ...le32(0), ...le32(strls.length), ...le32(0), ...le32(width), ...le32(height), ...le32(0), ...le32(0), ...le32(0), ...le32(0)]);
  const hdrl = list('hdrl', avih, ...strls);

  // The movie: frames and sound interleaved, one audio chunk after every frame while there are any.
  const entries: { id: string; payload: Uint8Array; key: boolean }[] = [];
  spec.frames.forEach((f, i) => {
    entries.push({ id: '00dc', payload: f, key: annexBHasIdr(f) });
    const a = spec.audio?.chunks[i];
    if (a) entries.push({ id: '01wb', payload: a, key: true });
  });
  const moviChildren: number[][] = [];
  const index: number[] = [];
  let offset = 4; // after the "movi" letters
  for (const e of entries) {
    const c = chunk(e.id, e.payload);
    moviChildren.push(c);
    index.push(...ascii(e.id), ...le32(e.key ? 0x10 : 0), ...le32(offset), ...le32(e.payload.length));
    offset += c.length;
  }
  const movi = list('movi', ...moviChildren);
  const body = [...ascii('AVI '), ...hdrl, ...movi, ...(spec.noIndex ? [] : chunk('idx1', index))];
  return Uint8Array.from([...ascii('RIFF'), ...le32(body.length), ...body]);
}

function annexBHasIdr(frame: Uint8Array): boolean {
  for (let i = 0; i + 4 < frame.length; i++) {
    if (frame[i] === 0 && frame[i + 1] === 0 && frame[i + 2] === 1 && (frame[i + 3] & 0x1f) === 5) return true;
  }
  return false;
}

/** An MP3 frame of MPEG 1 layer III at 128 kbit/s and 44.1 kHz: 417 bytes, or 418 with padding. */
export function mp3Frame(padding = 0): Uint8Array {
  const size = 417 + padding;
  const frame = new Uint8Array(size);
  frame.set([0xff, 0xfb, 0x90 | (padding << 1), 0x00]);
  return frame;
}

// --- Reading back the MP4 ---------------------------------------------------------------------------------------

export interface Box { type: string; start: number; end: number; }

export function boxes(data: Uint8Array, from = 0, to = data.length): Box[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    const size = view.getUint32(at);
    const type = String.fromCharCode(...data.subarray(at + 4, at + 8));
    if (size < 8 || at + size > to) throw new Error(`Bad box ${type} at ${at}`);
    out.push({ type, start: at, end: at + size });
    at += size;
  }
  if (at !== to) throw new Error('Trailing bytes after the last box.');
  return out;
}

export function find(data: Uint8Array, path: string[], from = 0, to = data.length): Box | null {
  const [head, ...rest] = path;
  const found = boxes(data, from, to).find((b) => b.type === head);
  if (!found) return null;
  if (rest.length === 0) return found;
  const inner = found.type === 'stsd' ? found.start + 16 : found.start + 8;
  return find(data, rest, inner, found.end);
}

export interface TrackInfo {
  handler: string;
  timescale: number;
  sampleSizes: number[];
  offsets: number[];
  durations: number[];
  compositionOffsets: number[];
  syncSamples: number[] | null;
  editMediaTime: number;
}

export function readTracks(mp4: Uint8Array): TrackInfo[] {
  const view = new DataView(mp4.buffer, mp4.byteOffset, mp4.byteLength);
  const moov = find(mp4, ['moov'])!;
  return boxes(mp4, moov.start + 8, moov.end).filter((b) => b.type === 'trak').map((trak) => {
    const get = (path: string[]) => find(mp4, path, trak.start + 8, trak.end);
    const hdlr = get(['mdia', 'hdlr'])!;
    const mdhd = get(['mdia', 'mdhd'])!;
    const stbl = ['mdia', 'minf', 'stbl'];
    const stsz = get([...stbl, 'stsz'])!;
    const stco = get([...stbl, 'stco'])!;
    const stts = get([...stbl, 'stts'])!;
    const ctts = get([...stbl, 'ctts']);
    const stss = get([...stbl, 'stss']);
    const elst = get(['edts', 'elst'])!;
    const count = view.getUint32(stsz.start + 16);
    const sampleSizes = Array.from({ length: count }, (_, i) => view.getUint32(stsz.start + 20 + 4 * i));
    const offsets = Array.from({ length: view.getUint32(stco.start + 12) }, (_, i) => view.getUint32(stco.start + 16 + 4 * i));
    const runs = (box: Box) => Array.from({ length: view.getUint32(box.start + 12) }, (_, i) => [view.getUint32(box.start + 16 + 8 * i), view.getUint32(box.start + 20 + 8 * i)]);
    const expand = (box: Box | null, fallback: number) => (box ? runs(box).flatMap(([n, v]) => new Array<number>(n).fill(v)) : new Array<number>(count).fill(fallback));
    return {
      handler: String.fromCharCode(...mp4.subarray(hdlr.start + 16, hdlr.start + 20)),
      timescale: view.getUint32(mdhd.start + 20),
      sampleSizes,
      offsets,
      durations: expand(stts, 0),
      compositionOffsets: expand(ctts, 0),
      syncSamples: stss ? Array.from({ length: view.getUint32(stss.start + 12) }, (_, i) => view.getUint32(stss.start + 16 + 4 * i)) : null,
      editMediaTime: view.getUint32(elst.start + 20),
    };
  });
}

export function joinParts(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
