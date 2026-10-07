import type { EditorExtension } from '@owload/editor-sdk';

/**
 * The descriptor the host loads eagerly (owload-docs/decisions/0019, 0026). It is a plain object and only the type
 * comes from the SDK, so this package has no runtime dependency; the host validates it.
 * The viewer itself is a separate chunk, loaded when an .avi file is opened.
 */
export const extension = {
  apiVersion: 1,
  id: 'avi',
  label: 'AVI video',
  fileExtensions: ['avi'],
  // It only shows the file, and re-wraps it into an MP4 in memory (the frames are copied once more).
  viewOnly: true,
  // The host decrypts the whole file before opening it; beyond this size the page runs out of memory.
  maxFileBytes: 1024 * 1024 * 1024,
  load: () => import('./avi-viewer').then((m) => ({ default: m.AviViewer })),
  // The first key frame, drawn lazily; null where there is no WebCodecs or the codec is not supported.
  preview: (data: Uint8Array, options: { size: number }) =>
    import('./lib/preview').then((m) => m.renderAviPreview(data, options.size)),
} satisfies EditorExtension;
