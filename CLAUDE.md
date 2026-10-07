# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

`@owload/avi-viewer` — the AVI viewer of Owload, a **view-only extension** that follows the contract of
`@owload/editor-sdk` (`owload-docs/decisions/0019-editor-extensions.md` and `0026-view-only-extensions-and-avi-viewer.md`).
It re-wraps H.264 AVI files into an MP4 in memory and plays them. The host (`owload-front`) is separate; never edit it
from here. See `README.md`.

## Rules

- **Do not commit or push unless the owner explicitly asks** (each time; a past instruction does not carry over).
  Leave the work uncommitted and report.
- **English only** in code, comments, UI strings, docs and commit messages.
- Commit identity is `Owload <info@owload.com>` only — no `Co-Authored-By` or generated-by lines; pass it per
  commit: `git -c user.name=Owload -c user.email=info@owload.com commit ...`.
- **Before every push check the diff:** no sensitive data (secrets, tokens, keys, `.env` values, real hostnames or
  IPs, personal data, machine paths), and security does not get worse. The viewer sees the plaintext of the user's
  files, and the AVI is untrusted input: every read is bounds-checked (`src/lib/bytes.ts`), a damaged file ends in
  a `FormatError`, never in a hang or an out-of-range access.
- **Security comes first:** no runtime dependencies (`@owload/editor-sdk` is a dev dependency and is used for types
  only in `src/`); no network access, no storage, no logging of content; the only thing the viewer creates is a
  `blob:` URL for its own `<video>`, revoked on unmount; the contract's rules are checked by the SDK's conformance
  suite in `test/conformance.test.tsx` and must keep passing.
- It is view-only: never dirty, never calls `onSave`. It has a close control in its own bar (`aria-label="Close"`,
  calls `onClose`).
- Keep it self-contained: no imports from the host app, no global CSS; every class is prefixed `av-` and every
  selector is scoped under `.av`.
- The SDK is pinned to an exact commit like in the other extensions; a bump is deliberate and its diff is reviewed.

## Commands

```bash
npm test | npm run lint | npm run typecheck | npm run build
```

Use Node >= 20 (`.nvmrc` = 22). The default `node` on this machine may be older; `/opt/homebrew/bin/node` is newer.

## Layout

```
src/extension.ts     the descriptor (plain object, type-only import from the SDK); load() and preview() are lazy chunks
src/avi-viewer.tsx   the component; src/avi-viewer.css its scoped styles
src/lib/             avi.ts (reader), h264.ts, mp3.ts, mp4.ts (writer), remux.ts, preview.ts, bytes.ts
test/                builders.ts (synthetic AVI files, an MP4 reader), remux tests and the SDK conformance suite
```
