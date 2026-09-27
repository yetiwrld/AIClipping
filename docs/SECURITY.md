# Security

## Trust model

- The **renderer is untrusted**. It runs with `contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true`, and no remote content.
- The **main process is trusted** and is the only component with filesystem,
  network, and subprocess capabilities.
- **AI/provider endpoints are semi-trusted**: the app sends them only the
  minimum data for the requested operation, and tells the user what will be
  sent before sending it.

## Electron hardening

- Explicit preload bridge (`window.clipwright.*`) — an allow-listed, typed API
  surface. No `ipcRenderer.send` passthrough of arbitrary channels.
- Every IPC handler validates its payload with a zod schema before touching
  services; malformed payloads are rejected with a validation error, never
  coerced.
- No `webSecurity: false`, no remote URLs loaded into the window (renderer is
  always local), `NavigationController` blocks navigation away from the app
  origin; external links open in the system browser via `shell.openExternal`.
- Custom `clipwright-media://` protocol only serves files inside the
  workspace root (realpath containment check) and supports Range requests;
  it cannot read arbitrary user files.
- `shell.showItemInFolder` / `shell.openPath` are exposed only for paths that
  pass the same workspace containment check.

## Secrets

- API keys are stored in `<workspace>/secrets.json`, mode `0600`. When
  Electron `safeStorage` is available (Windows DPAPI), values are encrypted
  at rest; otherwise a plain-but-protected file is used and the UI says so.
- Keys are **never**: written to logs, included in diagnostics, sent to the
  renderer (the renderer receives at most a masked hint like `sk-…4f2a`),
  included in error reports, or passed to subprocesses other than the
  provider HTTP call in the main process.

## Destructive-action policy

The app freely operates inside its workspace. Anything else asks first:

- Deleting anything outside the workspace: explicit confirmation dialog.
- Storage cleanup deletes only `cache/`, `renders/*.tmp*`, and thumbnails the
  user selected — project sources, transcripts, and completed renders are
  never removed without a per-item confirmation.
- No system-wide dependency installation is ever performed silently. Optional
  external tools (yt-dlp, faster-whisper, FFmpeg) are detected, not installed,
  by the app; the UI explains how the user can install them themselves.
- No downloaded binary is ever executed unless it is the app's own bundled,
  npm-integrity-checked dependency.

## Data leaving the machine (exact list)

| Operation | Leaves the machine? | Payload |
|---|---|---|
| Import/inspect/thumbnail | No | — |
| Local transcription (faster-whisper) | No | — |
| Cloud transcription | **Yes — only if user configures + selects it** | extracted audio track file |
| AI analysis / scoring / metadata | **Yes — only if user configures + selects it** | transcript text + clip metadata (never video/audio) |
| URL ingestion | Yes, to the host the user pasted | the media file itself (downloaded by the user's own action) |
| Telemetry / analytics | **Never** | the app contains no telemetry of any kind |

The privacy panel and every external call surface state this plainly; the app
never claims blanket "100% privacy".

## Input validation

- All IPC payloads and all AI/subtitle parse results pass zod schemas.
- Media inspection validates: file exists, has a video stream, codec
  decodability note, duration > 0; missing audio blocks transcription with an
  explanatory error (not a crash).
- Downloaded URLs: scheme allow-list (http/https), size guard, content-type
  check before writing to disk; partial downloads go to `*.part` files.
- Filenames for exports are sanitized (Windows-illegal characters, reserved
  names, length, collision-safe numbering).

## Logging

Structured logs (`timestamp · subsystem · operation · status · code`) to
workspace `logs/` and a rotating app log. Redaction filter guarantees no API
keys/secrets are ever written. Debug mode increases verbosity for support.
