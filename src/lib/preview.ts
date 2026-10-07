import { parseAvi } from './avi';
import { NAL_PPS, NAL_SLICE_IDR, NAL_SPS, buildAvcC, codecString, isAnnexB, nalType, splitAnnexB, toLengthPrefixed } from './h264';

const TIMEOUT_MS = 8000;

/**
 * The first key frame of the video as a PNG (owload-docs/decisions/0020), decoded by the browser (WebCodecs) and drawn
 * on an OffscreenCanvas. Returns null where there is no WebCodecs or canvas, the codec is not H.264 or not supported,
 * or the file cannot be read; it never throws for a bad file.
 */
export async function renderAviPreview(data: Uint8Array, size: number): Promise<Uint8Array | null> {
  if (typeof VideoDecoder === 'undefined' || typeof EncodedVideoChunk === 'undefined' || typeof OffscreenCanvas === 'undefined') return null;
  try {
    const avi = parseAvi(data);
    const video = avi.video!;
    if (!['h264', 'x264', 'avc1', 'davc', 'vssh'].includes(video.codec.toLowerCase())) return null;

    let sps: Uint8Array | null = null;
    const pps: Uint8Array[] = [];
    let key: Uint8Array | null = null;
    for (const sample of avi.samples) {
      if (sample.stream !== video.index || sample.size === 0) continue;
      const bytes = data.subarray(sample.offset, sample.offset + sample.size);
      if (!isAnnexB(bytes)) return null; // a length-prefixed stream: not handled for previews
      const nals = splitAnnexB(bytes);
      for (const nal of nals) {
        if (nalType(nal) === NAL_SPS && !sps) sps = nal;
        else if (nalType(nal) === NAL_PPS && pps.length < 4) pps.push(nal);
      }
      if (nals.some((n) => nalType(n) === NAL_SLICE_IDR)) { key = toLengthPrefixed(nals); break; }
    }
    if (!sps || pps.length === 0 || !key) return null;

    const description = buildAvcC([sps], pps);
    const config: VideoDecoderConfig = { codec: codecString(sps), description, codedWidth: video.width, codedHeight: video.height };
    if (!(await VideoDecoder.isConfigSupported(config)).supported) return null;

    const frame = await decodeFirstFrame(config, key);
    if (!frame) return null;
    try {
      const scale = Math.min(1, size / Math.max(frame.displayWidth, frame.displayHeight));
      const width = Math.max(1, Math.round(frame.displayWidth * scale));
      const height = Math.max(1, Math.round(frame.displayHeight * scale));
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d');
      if (!context) return null;
      context.drawImage(frame, 0, 0, width, height);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      return new Uint8Array(await blob.arrayBuffer());
    } finally {
      frame.close();
    }
  } catch {
    return null;
  }
}

function decodeFirstFrame(config: VideoDecoderConfig, key: Uint8Array): Promise<VideoFrame | null> {
  return new Promise((resolve) => {
    let frame: VideoFrame | null = null;
    let done = false;
    const decoder = new VideoDecoder({
      output: (f) => { if (frame) f.close(); else frame = f; },
      error: () => finish(),
    });
    const timer = setTimeout(() => finish(), TIMEOUT_MS);
    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { if (decoder.state !== 'closed') decoder.close(); } catch { /* already closed */ }
      resolve(frame);
    }
    try {
      decoder.configure(config);
      decoder.decode(new EncodedVideoChunk({ type: 'key', timestamp: 0, data: key }));
      decoder.flush().then(finish, finish);
    } catch {
      finish();
    }
  });
}
