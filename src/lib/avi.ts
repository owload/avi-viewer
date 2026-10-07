import { FormatError, fourcc, i32, u16, u32 } from './bytes';

export interface AviVideoStream {
  index: number;
  /** The codec, as the four letters the file gives it ("H264"). */
  codec: string;
  width: number;
  height: number;
  /** Frame duration is `scale / rate` seconds. */
  scale: number;
  rate: number;
  /** What follows the BITMAPINFOHEADER in the stream format (for H.264 sometimes an `avcC` or parameter sets). */
  extra: Uint8Array;
}

export interface AviAudioStream {
  index: number;
  formatTag: number;
  channels: number;
  sampleRate: number;
  extra: Uint8Array;
}

export interface AviSample {
  stream: number;
  /** Where the payload starts in the file. */
  offset: number;
  size: number;
  /** As the index says; for H.264 the viewer looks at the data instead. */
  keyframe: boolean;
}

export interface AviFile {
  data: Uint8Array;
  video: AviVideoStream | null;
  audio: AviAudioStream | null;
  /** Every sample of the movie, in the order of the file. */
  samples: AviSample[];
}

/** A movie has `rec ` lists inside `movi` at most; deeper nesting is a damaged or hostile file. */
const MAX_LIST_DEPTH = 4;

interface Chunk {
  id: string;
  /** Start of the payload. */
  start: number;
  size: number;
  /** For a LIST: its type ("hdrl"). */
  listType?: string;
}

/** Reads the chunks between `from` and `to` (RIFF: a four-letter id, a size, the payload padded to an even length). */
function* chunks(data: Uint8Array, from: number, to: number): Generator<Chunk> {
  let at = from;
  while (at + 8 <= to) {
    const id = fourcc(data, at);
    const size = u32(data, at + 4);
    const start = at + 8;
    if (start + size > data.length) throw new FormatError('A chunk is longer than the file; the file is cut or damaged.');
    if (id === 'LIST' || id === 'RIFF') yield { id, start: start + 4, size: size - 4, listType: fourcc(data, start) };
    else yield { id, start, size };
    at = start + size + (size & 1);
  }
}

/**
 * Reads an AVI file: the stream headers and the list of samples. The samples come from the `idx1` index; a file
 * without one is scanned chunk by chunk. Throws FormatError for anything that is not a readable AVI.
 */
export function parseAvi(data: Uint8Array): AviFile {
  if (data.length < 12 || fourcc(data, 0) !== 'RIFF' || fourcc(data, 8) !== 'AVI ') throw new FormatError('This is not an AVI file.');
  const riffEnd = Math.min(data.length, 8 + u32(data, 4));

  const streams: ({ type: string; handler: string; scale: number; rate: number; format: Uint8Array } | null)[] = [];
  let moviStart = -1;
  let moviEnd = -1;
  let idx1: Chunk | null = null;

  for (const top of chunks(data, 12, riffEnd)) {
    if (top.id === 'LIST' && top.listType === 'hdrl') {
      for (const h of chunks(data, top.start + 0, top.start + top.size)) {
        if (h.id !== 'LIST' || h.listType !== 'strl') continue;
        let strh: Chunk | null = null;
        let strf: Chunk | null = null;
        for (const s of chunks(data, h.start, h.start + h.size)) {
          if (s.id === 'strh') strh = s;
          else if (s.id === 'strf') strf = s;
        }
        if (!strh || !strf || strh.size < 36) {
          streams.push(null);
          continue;
        }
        streams.push({
          type: fourcc(data, strh.start),
          handler: fourcc(data, strh.start + 4),
          scale: u32(data, strh.start + 20),
          rate: u32(data, strh.start + 24),
          format: data.subarray(strf.start, strf.start + strf.size),
        });
      }
    } else if (top.id === 'LIST' && top.listType === 'movi') {
      moviStart = top.start; // the position right after the "movi" letters
      moviEnd = top.start + top.size;
    } else if (top.id === 'idx1') {
      idx1 = top;
    }
  }
  if (moviStart < 0) throw new FormatError('The file has no movie data.');

  let video: AviVideoStream | null = null;
  let audio: AviAudioStream | null = null;
  streams.forEach((s, index) => {
    if (!s) return;
    if (s.type === 'vids' && !video && s.format.length >= 40) {
      const compression = fourcc(s.format, 16);
      const codec = (compression.trim() && compression !== '\0\0\0\0' ? compression : s.handler).replace(/\0/g, '');
      video = {
        index,
        codec,
        width: Math.abs(i32(s.format, 4)),
        height: Math.abs(i32(s.format, 8)),
        scale: s.scale || 1,
        rate: s.rate || 25,
        extra: s.format.subarray(u32(s.format, 0)),
      };
    } else if (s.type === 'auds' && !audio && s.format.length >= 16) {
      const cbSize = s.format.length >= 18 ? u16(s.format, 16) : 0;
      audio = {
        index,
        formatTag: u16(s.format, 0),
        channels: u16(s.format, 2),
        sampleRate: u32(s.format, 4),
        extra: s.format.subarray(18, 18 + cbSize),
      };
    }
  });
  if (!video) throw new FormatError('The file has no video stream.');

  const wanted = new Set<number>([(video as AviVideoStream).index]);
  if (audio) wanted.add((audio as AviAudioStream).index);
  const samples = idx1 ? readIndex(data, idx1, moviStart, moviEnd, wanted) : scanMovie(data, moviStart, moviEnd, wanted);
  if (samples.length === 0) throw new FormatError('The file has no frames.');
  return { data, video, audio, samples };
}

/** `00dc`, `01wb`: two digits of the stream number and two letters of the kind of data. */
function streamOf(id: string): number {
  const a = id.charCodeAt(0) - 48;
  const b = id.charCodeAt(1) - 48;
  if (a < 0 || a > 9 || b < 0 || b > 9) return -1;
  const kind = id.slice(2);
  return kind === 'dc' || kind === 'db' || kind === 'wb' ? a * 10 + b : -1;
}

function readIndex(data: Uint8Array, idx1: Chunk, moviStart: number, moviEnd: number, wanted: Set<number>): AviSample[] {
  const count = Math.floor(idx1.size / 16);
  if (count === 0) return scanMovie(data, moviStart, moviEnd, wanted);
  // The offsets are counted from the "movi" letters, but some muxers count from the start of the file.
  const first = idx1.start;
  const viaMovi = moviStart - 4 + u32(data, first + 8);
  const relative = viaMovi + 8 <= data.length && fourcc(data, viaMovi) === fourcc(data, first);
  const base = relative ? moviStart - 4 : 0;

  const samples: AviSample[] = [];
  for (let i = 0; i < count; i++) {
    const at = idx1.start + i * 16;
    const stream = streamOf(fourcc(data, at));
    if (stream < 0 || !wanted.has(stream)) continue;
    const flags = u32(data, at + 4);
    const chunkAt = base + u32(data, at + 8);
    const size = u32(data, at + 12);
    const offset = chunkAt + 8;
    if (offset + size > data.length) throw new FormatError('The index points beyond the end of the file.');
    samples.push({ stream, offset, size, keyframe: (flags & 0x10) !== 0 });
  }
  return samples;
}

/** The fallback for a file with no index: walk the chunks of the movie (and of its `rec ` lists). */
function scanMovie(data: Uint8Array, from: number, to: number, wanted: Set<number>): AviSample[] {
  const samples: AviSample[] = [];
  const walk = (start: number, end: number, depth: number) => {
    if (depth > MAX_LIST_DEPTH) throw new FormatError('The lists in the movie are nested too deeply.');
    for (const c of chunks(data, start, end)) {
      if (c.id === 'LIST') {
        walk(c.start, c.start + c.size, depth + 1);
        continue;
      }
      const stream = streamOf(c.id);
      if (stream >= 0 && wanted.has(stream)) samples.push({ stream, offset: c.start, size: c.size, keyframe: false });
    }
  };
  walk(from, to, 0);
  return samples;
}
