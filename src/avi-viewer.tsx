import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { EditorProps } from '@owload/editor-sdk';
import { remuxAviToMp4 } from './lib/remux';
import { UnsupportedError } from './lib/bytes';
import './avi-viewer.css';

type State =
  | { kind: 'loading'; progress: number }
  | { kind: 'ready'; url: string; notes: string[] }
  | { kind: 'empty' }
  | { kind: 'unsupported'; message: string }
  | { kind: 'broken'; message: string }
  | { kind: 'unplayable' };

const DOWNLOAD_HINT = 'Download the file to open it in a video player.';

/**
 * A view-only viewer (owload-docs/decisions/0026): it re-wraps the AVI into an MP4 in memory and plays that in a
 * <video> through a blob: URL. It never edits, is never dirty and never saves.
 */
export function AviViewer({ data, fileName, onError, onClose, className, ref }: EditorProps) {
  // `data` is read once, when the viewer opens.
  const [bytes] = useState(data);
  const [state, setState] = useState<State>(bytes && bytes.byteLength > 0 ? { kind: 'loading', progress: 0 } : { kind: 'empty' });
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useImperativeHandle(ref, () => ({ save: async () => undefined, isDirty: () => false }), []);

  useEffect(() => {
    if (!bytes || bytes.byteLength === 0) return;
    let cancelled = false;
    let url: string | null = null;
    (async () => {
      try {
        const result = await remuxAviToMp4(bytes, {
          onProgress: (progress) => { if (!cancelled) setState({ kind: 'loading', progress }); },
        });
        if (cancelled) return;
        url = URL.createObjectURL(new Blob(result.parts as BlobPart[], { type: 'video/mp4' }));
        setState({ kind: 'ready', url, notes: result.notes });
      } catch (e) {
        if (cancelled) return;
        if (e instanceof UnsupportedError) {
          setState({ kind: 'unsupported', message: e.message });
        } else {
          const error = e instanceof Error ? e : new Error(String(e));
          setState({ kind: 'broken', message: error.message });
          onErrorRef.current?.(error);
        }
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [bytes]);

  return (
    <div className={`av${className ? ` ${className}` : ''}`}>
      <div className="av-bar">
        <span className="av-name" title={fileName}>{fileName}</span>
        <button className="av-close" aria-label="Close" title="Close" onClick={onClose}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      <div className="av-body">
        {state.kind === 'loading' && (
          <div className="av-state" role="status">
            <progress className="av-progress" max={1} value={state.progress} />
            <p>Preparing the video…</p>
          </div>
        )}
        {state.kind === 'ready' && (
          <>
            <video
              className="av-video"
              src={state.url}
              controls
              playsInline
              onError={() => setState({ kind: 'unplayable' })}
            />
            {state.notes.map((note) => <p key={note} className="av-note">{note}</p>)}
          </>
        )}
        {state.kind === 'empty' && <p className="av-state">There is no video in this file.</p>}
        {state.kind === 'unsupported' && (
          <p role="alert" className="av-state">{state.message} {DOWNLOAD_HINT}</p>
        )}
        {state.kind === 'broken' && (
          <p role="alert" className="av-state av-error">This file cannot be opened: {state.message} {DOWNLOAD_HINT}</p>
        )}
        {state.kind === 'unplayable' && (
          <p role="alert" className="av-state av-error">The browser cannot play this video. {DOWNLOAD_HINT}</p>
        )}
      </div>
    </div>
  );
}
