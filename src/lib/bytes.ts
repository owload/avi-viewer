/** Little-endian reading of a byte array, with bounds checks that report a broken file instead of throwing a RangeError. */
export class FormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormatError';
  }
}

/** The file is fine, but this viewer cannot play it (an unsupported codec). `codec` names what was found. */
export class UnsupportedError extends Error {
  readonly codec: string;
  constructor(message: string, codec: string) {
    super(message);
    this.name = 'UnsupportedError';
    this.codec = codec;
  }
}

export function u16(data: Uint8Array, at: number): number {
  if (at < 0 || at + 2 > data.length) throw new FormatError('The file ends in the middle of a header.');
  return data[at] | (data[at + 1] << 8);
}

export function u32(data: Uint8Array, at: number): number {
  if (at < 0 || at + 4 > data.length) throw new FormatError('The file ends in the middle of a header.');
  return (data[at] | (data[at + 1] << 8) | (data[at + 2] << 16) | (data[at + 3] << 24)) >>> 0;
}

export function i32(data: Uint8Array, at: number): number {
  return u32(data, at) | 0;
}

export function fourcc(data: Uint8Array, at: number): string {
  if (at < 0 || at + 4 > data.length) throw new FormatError('The file ends in the middle of a header.');
  return String.fromCharCode(data[at], data[at + 1], data[at + 2], data[at + 3]);
}

/** Lets a long loop give the page a chance to paint and handle input. */
export const yieldToPage = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
