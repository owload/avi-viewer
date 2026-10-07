# @owload/avi-viewer

A **view-only** AVI viewer for Owload, an extension that follows the contract of
[`@owload/editor-sdk`](https://github.com/owload/editor-sdk) (decision
[0026](https://github.com/owload/owload-docs/blob/main/decisions/0026-view-only-extensions-and-avi-viewer.md)).
Browsers cannot play the AVI container, so the viewer re-wraps the file into an MP4 in memory and plays that in a
`<video>` through a `blob:` URL. Nothing is decoded or re-encoded, and nothing leaves the page.

## What it plays

- Video: **H.264** (Annex B, as AVI muxers store it; length-prefixed streams with an `avcC` too). Frames stored in
  decoding order are put in the right order from the picture order counts of the slice headers (B-frames).
- Sound: **MP3** (cut into frames) and **AAC** (raw frames). Other sound (PCM, AC-3, WMA, ...) is dropped with a notice
  and the video still plays.
- Any other video codec (DivX/Xvid, MJPEG, WMV, ...) is reported by name, with a hint to download the file.
- Seeking and controls are the browser's own. Files up to 1 GiB (`maxFileBytes`).

`preview()` draws the first key frame with WebCodecs (`VideoDecoder`) on an `OffscreenCanvas`; it returns `null` where
that is not available.

## Layout

```
src/extension.ts      the descriptor (viewOnly, maxFileBytes, lazy load and preview)
src/avi-viewer.tsx    the viewer: title bar with Close, progress, the video, the messages
src/lib/avi.ts        RIFF/AVI reader: stream headers, idx1 index (or a scan of the movie)
src/lib/h264.ts       Annex B splitting, SPS reading, frame order, avcC
src/lib/mp3.ts        MP3 frame splitter
src/lib/mp4.ts        the MP4 writer (sample tables, edit list, avc1/mp4a descriptions)
src/lib/remux.ts      puts it together
src/lib/preview.ts    the thumbnail
test/                 synthetic AVI files (test/builders.ts), the structure of the MP4 written, the SDK conformance suite
```

## Development

```bash
npm install
npm test | npm run lint | npm run typecheck | npm run build
```

Needs Node 20 or newer (`.nvmrc` = 22).
