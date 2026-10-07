/**
 * What the re-wrapping needs to know about H.264: the NAL units of a frame, the parameter sets that go into the MP4
 * header, and the order in which frames are shown (the file stores them in the order they are decoded).
 */

/** The NAL units of a frame in the "Annex B" form (start codes between them), without the start codes. */
export function splitAnnexB(sample: Uint8Array): Uint8Array[] {
  const nals: Uint8Array[] = [];
  const n = sample.length;
  let start = -1;
  let i = 0;
  while (i + 2 < n) {
    if (sample[i] === 0 && sample[i + 1] === 0 && sample[i + 2] === 1) {
      if (start >= 0) {
        let end = i;
        while (end > start && sample[end - 1] === 0) end--; // the zero of a four-byte start code, and zero padding
        if (end > start) nals.push(sample.subarray(start, end));
      }
      start = i + 3;
      i += 3;
    } else {
      i++;
    }
  }
  if (start >= 0) {
    let end = n;
    while (end > start && sample[end - 1] === 0) end--;
    if (end > start) nals.push(sample.subarray(start, end));
  }
  return nals;
}

/** True if the frame starts with a start code, which is how the AVI stores it; false for length-prefixed data. */
export function isAnnexB(sample: Uint8Array): boolean {
  return (sample.length > 3 && sample[0] === 0 && sample[1] === 0 && sample[2] === 1)
    || (sample.length > 4 && sample[0] === 0 && sample[1] === 0 && sample[2] === 0 && sample[3] === 1);
}

export const nalType = (nal: Uint8Array) => nal[0] & 0x1f;
export const nalRefIdc = (nal: Uint8Array) => (nal[0] >> 5) & 3;
export const NAL_SLICE_IDR = 5;
export const NAL_SPS = 7;
export const NAL_PPS = 8;
export const NAL_AUD = 9;

/** The frame in the MP4 form: every NAL unit behind a four-byte length; parameter sets and delimiters are dropped. */
export function toLengthPrefixed(nals: Uint8Array[]): Uint8Array {
  const kept = nals.filter((n) => { const t = nalType(n); return t !== NAL_SPS && t !== NAL_PPS && t !== NAL_AUD; });
  let size = 0;
  for (const n of kept) size += 4 + n.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  for (const n of kept) {
    view.setUint32(at, n.length);
    out.set(n, at + 4);
    at += 4 + n.length;
  }
  return out;
}

/** Reads bits of a NAL unit, with the emulation prevention bytes (00 00 03) already taken out. */
class BitReader {
  private pos = 0;
  constructor(private readonly bytes: Uint8Array) {}
  bit(): number {
    const byte = this.bytes[this.pos >> 3];
    if (byte === undefined) throw new Error('out of data');
    const value = (byte >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return value;
  }
  bits(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++) value = value * 2 + this.bit();
    return value;
  }
  ue(): number {
    let zeros = 0;
    while (this.bit() === 0) {
      if (++zeros > 32) throw new Error('bad code');
    }
    return zeros === 0 ? 0 : 2 ** zeros - 1 + this.bits(zeros);
  }
  se(): number {
    const k = this.ue();
    return k % 2 === 1 ? (k + 1) / 2 : -(k / 2);
  }
}

function unescape(nal: Uint8Array): Uint8Array {
  const out: number[] = [];
  let zeros = 0;
  for (let i = 0; i < nal.length; i++) {
    const b = nal[i];
    if (zeros >= 2 && b === 3) { zeros = 0; continue; }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(out);
}

export interface SpsInfo {
  profile: number;
  compatibility: number;
  level: number;
  pocType: number;
  log2MaxFrameNum: number;
  log2MaxPocLsb: number;
  frameMbsOnly: boolean;
}

const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

function skipScalingList(r: BitReader, size: number) {
  let last = 8;
  let next = 8;
  for (let i = 0; i < size; i++) {
    if (next !== 0) next = (last + r.se() + 256) % 256;
    last = next === 0 ? last : next;
  }
}

/** The parts of a sequence parameter set that the MP4 header and the frame order need; null if it cannot be read. */
export function parseSps(nal: Uint8Array): SpsInfo | null {
  try {
    const r = new BitReader(unescape(nal.subarray(1)));
    const profile = r.bits(8);
    const compatibility = r.bits(8);
    const level = r.bits(8);
    r.ue(); // seq_parameter_set_id
    if (HIGH_PROFILES.has(profile)) {
      const chroma = r.ue();
      if (chroma === 3) r.bit();
      r.ue();
      r.ue();
      r.bit();
      if (r.bit()) {
        for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++) {
          if (r.bit()) skipScalingList(r, i < 6 ? 16 : 64);
        }
      }
    }
    const log2MaxFrameNum = r.ue() + 4;
    const pocType = r.ue();
    let log2MaxPocLsb = 0;
    if (pocType === 0) {
      log2MaxPocLsb = r.ue() + 4;
    } else if (pocType === 1) {
      r.bit();
      r.se();
      r.se();
      const cycle = r.ue();
      for (let i = 0; i < cycle; i++) r.se();
    }
    r.ue(); // max_num_ref_frames
    r.bit(); // gaps_in_frame_num_value_allowed_flag
    r.ue();
    r.ue();
    const frameMbsOnly = r.bit() === 1;
    return { profile, compatibility, level, pocType, log2MaxFrameNum, log2MaxPocLsb, frameMbsOnly };
  } catch {
    return null;
  }
}

/** The picture order count (the lowest 16 or so bits of it) of the first slice of a frame, or null. */
function sliceLsb(nal: Uint8Array, sps: SpsInfo): number | null {
  try {
    const r = new BitReader(unescape(nal.subarray(1)));
    r.ue(); // first_mb_in_slice
    r.ue(); // slice_type
    r.ue(); // pps id
    r.bits(sps.log2MaxFrameNum);
    if (!sps.frameMbsOnly) {
      if (r.bit()) r.bit(); // field_pic_flag, bottom_field_flag
    }
    if (nalType(nal) === NAL_SLICE_IDR) r.ue(); // idr_pic_id
    return r.bits(sps.log2MaxPocLsb);
  } catch {
    return null;
  }
}

export interface FrameOrder {
  /** For every frame in decoding order: how many frames later (or earlier, if negative) it is shown than decoded. */
  shift: number[];
  /** The most any frame is shown earlier than decoded (>= 0): everything is delayed by this much. */
  maxEarly: number;
}

/**
 * Works out the order in which the frames are shown. `frames` holds, for every frame in decoding order, the NAL units
 * of its first slice and whether it begins a new sequence. With picture order count type 0 the order within a
 * sequence is the order of the counts; with any other type, or where a count cannot be read, the order of decoding is
 * the order of showing.
 */
export function frameOrder(frames: { slice: Uint8Array | null; idr: boolean }[], sps: SpsInfo | null): FrameOrder {
  const n = frames.length;
  const plain: FrameOrder = { shift: new Array<number>(n).fill(0), maxEarly: 0 };
  if (!sps || sps.pocType !== 0 || sps.log2MaxPocLsb === 0) return plain;

  const maxLsb = 2 ** sps.log2MaxPocLsb;
  const poc: number[] = new Array<number>(n).fill(0);
  let prevMsb = 0;
  let prevLsb = 0;
  for (let i = 0; i < n; i++) {
    const { slice, idr } = frames[i];
    if (!slice) return plain;
    const lsb = sliceLsb(slice, sps);
    if (lsb === null) return plain;
    if (idr) { prevMsb = 0; prevLsb = 0; }
    let msb = prevMsb;
    if (lsb < prevLsb && prevLsb - lsb >= maxLsb / 2) msb = prevMsb + maxLsb;
    else if (lsb > prevLsb && lsb - prevLsb > maxLsb / 2) msb = prevMsb - maxLsb;
    poc[i] = msb + lsb;
    if (nalRefIdc(slice) !== 0) { prevMsb = msb; prevLsb = lsb; }
  }

  // A sequence runs from one IDR frame to the next; its frames are shown in the order of their counts.
  const shift: number[] = new Array<number>(n).fill(0);
  let maxEarly = 0;
  let from = 0;
  for (let i = 1; i <= n; i++) {
    if (i < n && !frames[i].idr) continue;
    const order = Array.from({ length: i - from }, (_, k) => from + k).sort((a, b) => poc[a] - poc[b]);
    order.forEach((frame, rank) => {
      shift[frame] = from + rank - frame;
      if (-shift[frame] > maxEarly) maxEarly = -shift[frame];
    });
    from = i;
  }
  return { shift, maxEarly };
}

/** The `avcC` box content: the parameter sets as the MP4 header holds them. */
export function buildAvcC(sps: Uint8Array[], pps: Uint8Array[]): Uint8Array {
  let size = 7;
  for (const s of sps) size += 2 + s.length;
  for (const p of pps) size += 2 + p.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out[0] = 1;
  out[1] = sps[0][1];
  out[2] = sps[0][2];
  out[3] = sps[0][3];
  out[4] = 0xff; // four-byte lengths
  out[5] = 0xe0 | sps.length;
  let at = 6;
  for (const s of sps) { view.setUint16(at, s.length); out.set(s, at + 2); at += 2 + s.length; }
  out[at++] = pps.length;
  for (const p of pps) { view.setUint16(at, p.length); out.set(p, at + 2); at += 2 + p.length; }
  return out;
}

/** The SPS and PPS of an `avcC` (as written by buildAvcC or by an encoder), or null. */
export function readAvcC(avcC: Uint8Array): { sps: Uint8Array[]; pps: Uint8Array[] } | null {
  try {
    if (avcC.length < 7 || avcC[0] !== 1) return null;
    const view = new DataView(avcC.buffer, avcC.byteOffset, avcC.byteLength);
    let at = 6;
    const sps: Uint8Array[] = [];
    for (let i = 0; i < (avcC[5] & 0x1f); i++) {
      const len = view.getUint16(at);
      sps.push(avcC.subarray(at + 2, at + 2 + len));
      at += 2 + len;
    }
    const pps: Uint8Array[] = [];
    const count = avcC[at++];
    for (let i = 0; i < count; i++) {
      const len = view.getUint16(at);
      pps.push(avcC.subarray(at + 2, at + 2 + len));
      at += 2 + len;
    }
    return sps.length && pps.length ? { sps, pps } : null;
  } catch {
    return null;
  }
}

/** The codec string a browser wants for this stream: `avc1.64001F`. */
export function codecString(sps: Uint8Array): string {
  const hex = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
  return `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`;
}
