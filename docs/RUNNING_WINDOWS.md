# Running Clipwright Studio

Exact commands, verified in this repository (see `docs/QA_REPORT.md` for what
was executed and what remains to be verified on a real Windows machine).

## Prerequisites

| Requirement | Notes |
| --- | --- |
| **Node.js 22+** | The repo was built and tested with Node 22. `npm` comes with it. |
| **npm 10+** | Package manager used by the repository (`package-lock.json` present). |
| **Windows 10/11 x64** | Primary target for the packaged app. macOS/Linux work for development. |

That's all — FFmpeg and FFprobe are npm dependencies (`@ffmpeg-installer` /
`@ffprobe-installer`) and ship inside the app. Caption fonts are bundled in
`resources/fonts`. No Python is required unless you enable local Whisper
transcription (the helper script is bundled; the Whisper model downloads on
first use).

## Install

```text
npm install
```

Verified: completes with `0 vulnerabilities` (Node 22, npm 10).

> The Electron binary download runs as part of `npm install` (postinstall).
> Corporate proxies that intercept TLS may need `NODE_EXTRA_CA_CERTS` set.

## Test fixtures (optional, needed for `npm test`)

```text
npm run fixtures
```

Generates `tests/fixtures/media/sample.mp4` (60s, 1280×720) and
`tests/fixtures/transcript.json` with real FFmpeg. The files are gitignored.

## Type checking

```text
npm run typecheck
```

Verified: clean for both the Node (main/preload) and Web (renderer) projects.

## Tests

```text
npm test
```

Verified: **160/160 passing** (96 unit + 64 integration). Also available
separately, both verified:

```text
npm run test:unit
npm run test:integration
```

## Development (desktop app)

```text
npm run dev
```

This is the standard command for this repository (`electron-vite dev`): starts
the Vite dev server with hot reload and launches the Electron app.

> Not executable inside this QA sandbox (headless Linux, no display, blocked
> Electron binary CDN) — run it on your Windows machine. The identical build
> pipeline (`electron-vite build`) plus the full backend and renderer ARE
> verified here via `npm run preview:web` and 160 automated tests.

## Browser preview (no Electron, same backend)

```text
npm run preview:web
```

Verified: serves the built renderer at `http://localhost:8787` with the real
backend services (SQLite + FFmpeg) behind an HTTP bridge. File picking,
folder reveal and clipboard fall back to browser alternatives.

## Production build (compile only)

```text
npm run build
```

Verified: clean — main 194 kB, preload 0.5 kB, renderer bundle produced.

## Windows installer / portable build

```text
npm run dist:win
```

Produces (per `electron-builder.yml`):

```text
dist/Clipwright Studio-0.1.0-setup-x64.exe    NSIS installer
dist/win-unpacked/                            unpacked app directory
```

> Status in this QA: the packaging pipeline starts correctly (native rebuild
> for win32/x64 completed, `dist/win-unpacked` packaging began) but could not
> finish inside the sandbox because the Windows Electron binary download is
> blocked by the sandbox's filtered network (`unable to verify the first
> certificate` fetching the Electron release CDN). **Run `npm run dist:win` on
> a machine with normal internet access** — no project changes are expected to
> be needed. This is documented as NOT TESTED-to-completion in
> `docs/QA_REPORT.md`.

## First run

On first launch the app checks FFmpeg/FFprobe and shows the environment
check. Then: **Projects → create → import a video → transcript → moments →
clip → editor → render → export.** AI providers are optional — the local
heuristic analyzer works fully offline (see `docs/API_SETUP.md`).

## Where your data lives

Workspace root (configurable, default under the OS user-data directory as
`ClipwrightStudio`): per-project folders (`source/`, `renders/`, `thumbnails/`,
`analysis/`), `exports/`, `logs/`, `secrets.json` (API keys, mode 0600, OS
keychain-encrypted where available). Nothing is uploaded anywhere unless you
configure an AI provider (transcript text only — never video files).
