/** A small MP4 writer: the sample tables of one video and at most one audio track, and the order of the data. */

export interface Mp4Sample {
  size: number;
  /** In the track's timescale. */
  duration: number;
  /** How much later than its decoding time the sample is shown, in the track's timescale (>= 0). */
  offset: number;
  sync: boolean;
}

export interface Mp4Track {
  kind: 'video' | 'audio';
  timescale: number;
  samples: Mp4Sample[];
  /** The sample description box (`avc1` or `mp4a`), complete with its header. */
  description: Uint8Array;
  width: number;
  height: number;
  /** The start of the track is cut by this much (in the timescale): the delay that frame reordering needs. */
  skip: number;
}

const encoder = new TextEncoder();

function concat(parts: Uint8Array[]): Uint8Array {
  let size = 0;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export const box = (type: string, ...content: Uint8Array[]): Uint8Array => {
  const body = concat(content);
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(encoder.encode(type), 4);
  out.set(body, 8);
  return out;
};

/** Numbers as big-endian bytes: u(4, 1, 2) is 00000001 0002. */
export function bytes(...fields: [width: number, value: number][]): Uint8Array {
  const out: number[] = [];
  for (const [width, value] of fields) {
    for (let i = width - 1; i >= 0; i--) out.push(Math.floor(value / 2 ** (8 * i)) & 0xff);
  }
  return Uint8Array.from(out);
}

const u32 = (v: number) => bytes([4, v]);
const u16 = (v: number) => bytes([2, v]);
const zeros = (n: number) => new Uint8Array(n);
const fullBox = (type: string, version: number, flags: number, ...content: Uint8Array[]) => box(type, bytes([1, version], [1, (flags >> 16) & 0xff], [1, (flags >> 8) & 0xff], [1, flags & 0xff]), ...content);
const MATRIX = concat([0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].map(u32));

function stts(samples: Mp4Sample[]): Uint8Array {
  const runs: [number, number][] = [];
  for (const s of samples) {
    const last = runs[runs.length - 1];
    if (last && last[1] === s.duration) last[0]++;
    else runs.push([1, s.duration]);
  }
  return fullBox('stts', 0, 0, u32(runs.length), ...runs.map(([count, delta]) => concat([u32(count), u32(delta)])));
}

function ctts(samples: Mp4Sample[]): Uint8Array | null {
  if (samples.every((s) => s.offset === 0)) return null;
  const runs: [number, number][] = [];
  for (const s of samples) {
    const last = runs[runs.length - 1];
    if (last && last[1] === s.offset) last[0]++;
    else runs.push([1, s.offset]);
  }
  return fullBox('ctts', 0, 0, u32(runs.length), ...runs.map(([count, offset]) => concat([u32(count), u32(offset)])));
}

function stss(samples: Mp4Sample[]): Uint8Array | null {
  if (samples.every((s) => s.sync)) return null;
  const numbers: number[] = [];
  samples.forEach((s, i) => { if (s.sync) numbers.push(i + 1); });
  return fullBox('stss', 0, 0, u32(numbers.length), ...numbers.map(u32));
}

function track(t: Mp4Track, id: number, movieTimescale: number, offsets: number[]): Uint8Array {
  const trackDuration = t.samples.reduce((sum, s) => sum + s.duration, 0) - t.skip;
  const movieDuration = Math.round(trackDuration * movieTimescale / t.timescale);
  const video = t.kind === 'video';
  const tkhd = fullBox('tkhd', 0, 7, u32(0), u32(0), u32(id), u32(0), u32(movieDuration), zeros(8), u16(0), u16(0), u16(video ? 0 : 0x0100), u16(0), MATRIX, u32(t.width * 65536), u32(t.height * 65536));
  const edts = box('edts', fullBox('elst', 0, 0, u32(1), u32(movieDuration), u32(t.skip), u32(0x00010000)));
  const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(t.timescale), u32(trackDuration + t.skip), u16(0x55c4), u16(0));
  const hdlr = fullBox('hdlr', 0, 0, u32(0), encoder.encode(video ? 'vide' : 'soun'), zeros(12), encoder.encode(video ? 'Video\0' : 'Audio\0'));
  const mediaHeader = video
    ? fullBox('vmhd', 0, 1, zeros(8))
    : fullBox('smhd', 0, 0, zeros(4));
  const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
  const stsd = fullBox('stsd', 0, 0, u32(1), t.description);
  const stsc = fullBox('stsc', 0, 0, u32(1), u32(1), u32(1), u32(1)); // every sample is a chunk of its own
  const stsz = fullBox('stsz', 0, 0, u32(0), u32(t.samples.length), ...t.samples.map((s) => u32(s.size)));
  const stco = fullBox('stco', 0, 0, u32(offsets.length), ...offsets.map(u32));
  const table = [stsd, stts(t.samples), ctts(t.samples), stss(t.samples), stsc, stsz, stco].filter((b): b is Uint8Array => b !== null);
  const minf = box('minf', mediaHeader, dinf, box('stbl', ...table));
  return box('trak', tkhd, edts, box('mdia', mdhd, hdlr, minf));
}

export interface Mp4Plan {
  tracks: Mp4Track[];
  /** The order of the data in the file: which track, which sample of it. */
  order: [track: number, sample: number][];
}

/**
 * Builds everything of the MP4 but the sample data: the header with the sample tables (`head`) and the size of the data
 * that follows it. The data is `order` of the samples, written one after another after a `mdat` header of 8 bytes,
 * which `head` already ends with.
 */
export function buildHead(plan: Mp4Plan): { head: Uint8Array; dataSize: number } {
  const ftyp = box('ftyp', encoder.encode('isom'), u32(512), encoder.encode('isomiso2avc1mp41'));
  const movieTimescale = 1000;
  const duration = Math.max(...plan.tracks.map((t) => Math.round((t.samples.reduce((s, x) => s + x.duration, 0) - t.skip) * movieTimescale / t.timescale)));
  let dataSize = 0;
  for (const [t, s] of plan.order) dataSize += plan.tracks[t].samples[s].size;

  const build = (dataStart: number) => {
    const offsets: number[][] = plan.tracks.map((t) => new Array<number>(t.samples.length).fill(0));
    let at = dataStart;
    for (const [t, s] of plan.order) {
      offsets[t][s] = at;
      at += plan.tracks[t].samples[s].size;
    }
    const mvhd = fullBox('mvhd', 0, 0, u32(0), u32(0), u32(movieTimescale), u32(duration), u32(0x00010000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(plan.tracks.length + 1));
    return box('moov', mvhd, ...plan.tracks.map((t, i) => track(t, i + 1, movieTimescale, offsets[i])));
  };

  // The size of the header does not depend on the offsets in it, so one pass finds it and a second one fills it in.
  const moovSize = build(0).length;
  const dataStart = ftyp.length + moovSize + 8;
  const moov = build(dataStart);
  const mdatHeader = new Uint8Array(8);
  new DataView(mdatHeader.buffer).setUint32(0, 8 + dataSize);
  mdatHeader.set(encoder.encode('mdat'), 4);
  return { head: concat([ftyp, moov, mdatHeader]), dataSize };
}

/** `avc1` sample description with its `avcC`. */
export function avc1(width: number, height: number, avcC: Uint8Array): Uint8Array {
  return box('avc1', zeros(6), u16(1), zeros(16), u16(width), u16(height), u32(0x00480000), u32(0x00480000), u32(0), u16(1), zeros(32), u16(0x0018), u16(0xffff), box('avcC', avcC));
}

const descriptor = (tag: number, ...content: Uint8Array[]) => {
  const body = concat(content);
  return concat([Uint8Array.of(tag, body.length), body]);
};

/** `mp4a` sample description; `objectType` 0x40 is AAC (with `config` the AudioSpecificConfig), 0x6B is MP3. */
export function mp4a(channels: number, sampleRate: number, objectType: number, config: Uint8Array | null): Uint8Array {
  const decoderSpecific = config ? descriptor(0x05, config) : new Uint8Array(0);
  const esds = fullBox(
    'esds', 0, 0,
    descriptor(
      0x03, u16(0), Uint8Array.of(0),
      descriptor(0x04, Uint8Array.of(objectType, 0x15), bytes([3, 0]), u32(0), u32(0), decoderSpecific),
      descriptor(0x06, Uint8Array.of(2)),
    ),
  );
  return box('mp4a', zeros(6), u16(1), zeros(8), u16(channels), u16(16), u16(0), u16(0), u32(Math.min(sampleRate, 65535) * 65536), esds);
}
