# Architecture

## Product

**Clipwright Studio** — a local-first desktop application that turns long-form
video into polished short-form vertical clips:

```
long video → transcribe → analyze → discover clips → audit scores
           → vertical reframe → captions → edit → render → export + metadata
```

Target platform: **Windows 11** (portable to macOS/Linux; all app code is
cross-platform Node/Chromium). The application is a desktop app, not a web
site: the renderer never talks to the network except through main-process
services the user configures.

## Process topology

```
┌────────────────────────────────────────────────────────────────────────┐
│ Electron main process (Node.js)                                        │
│                                                                        │
│  ┌──────────┐   ┌───────────────────────────────────────────────────┐ │
│  │ IPC layer│◄──┤ Services (plain Node modules — no Electron APIs)   │ │
│  │ (zod-    │   │                                                   │ │
│  │ validated)│   │  ProjectService   MediaService (ffprobe/thumbs)  │ │
│  └──────────┘   │  TranscriptService (providers)                    │ │
│        ▲         │  AnalysisService  (AI + heuristic providers)      │ │
│        │ events  │  RenderService    (ffmpeg pipeline + queue)       │ │
│        │ (bus)   │  SettingsService  SecretStore   DiagnosticsService│ │
│        │         │  Database (sql.js SQLite + migrations)            │ │
│        │         └───────────────────────────────────────────────────┘ │
│        │                        │ spawns                              │
│        │                        ▼                                     │
│  ┌──────────┐         FFmpeg / FFprobe / python (faster-whisper) /     │
│  │EventBus  │         curl-style HTTP (AI providers, direct downloads) │
│  └──────────┘                                                         │
└────────────────────────────────────────────────────────────────────────┘
        ▲ IPC (contextBridge: window.clipwright)          ▲ same services
        │                                                 │ imported by
┌───────┴──────────────┐                    ┌─────────────┴─────────────┐
│ Renderer (React 19)  │                    │ Browser preview server    │
│ pages/features/stores│                    │ (Express, dev tool):      │
│ api client ──────────┼────────────────────► same API over HTTP + SSE  │
└──────────────────────┘                    └───────────────────────────┘
```

Key rules:

1. **All privileged work lives in the main process.** The renderer has no
   Node integration (`contextIsolation: true`, `nodeIntegration: false`) and
   reaches the backend only through the preload bridge, where every channel
   and payload is validated with zod schemas.
2. **Services are plain TypeScript Node modules** with zero `electron`
   imports. They receive paths/config through an `AppContext` object. This is
   what lets the exact same backend run under Electron, under the Express
   preview server, and under Vitest integration tests.
3. **Heavy operations are subprocesses, not threads**: FFmpeg/FFprobe are
   spawned (`-progress pipe:1` for streaming progress); local transcription
   spawns Python; AI calls are `fetch`. The Node event loop (and therefore the
   UI) never blocks. Cancellation = killing the subprocess + cleaning
   temp files; the source media is never touched.
4. **One typed event bus** (`task:update`, `render:progress`,
   `project:update`) fans out to the Electron renderer via `webContents.send`
   and to the preview server via SSE. The UI subscribes through a single
   transport-agnostic client.

## Workspace layout (on-disk, per machine)

Root is configurable in Settings (default named after the app; not
hard-coded in code paths):

```
<workspaceRoot>/                     (default: <userData>/ClipwrightStudio)
├── database/app.db                  SQLite (sql.js, atomic whole-file persist)
├── secrets.json                     provider API keys (0600; Electron safeStorage
│                                    encrypted when available; NEVER sent to renderer)
├── models/                          local model storage (faster-whisper)
├── exports/                         exported clip bundles (mp4 + txt + json)
├── projects/<project-id>/
│   ├── project.json                 human-readable project snapshot
│   ├── source/source.<ext>          imported media (copied/linked read-only)
│   ├── transcription/transcript.json
│   ├── analysis/analysis.json       raw provider output (cache)
│   ├── clips/                       clip configuration artifacts
│   ├── renders/<render-id>.mp4      rendered output (final + temp siblings)
│   ├── thumbnails/                  source + clip thumbnails
│   ├── cache/                       per-project derived media
│   └── logs/<date>.log              per-project operation logs
└── logs/app-<date>.log              application log
```

Originals are never modified: ingestion copies into `source/`; every later
stage (clip → render → export) is a transformation described by data, not an
edit of the source file.

## Media access from the renderer

- **Electron**: a privileged custom protocol `clipwright-media://` streams
  files with HTTP Range support. The handler only serves paths inside the
  workspace — no arbitrary filesystem reads.
- **Preview server**: `GET /api/media/stream?path=…` with the same
  workspace-confinement check.

## AI / transcription provider abstraction

Two independent provider registries (see `AI_PIPELINE.md`):

- `TranscriptionProvider`: `faster-whisper-local` (Python subprocess),
  `openai-compatible` (cloud), `import-file` (SRT/VTT/JSON/TXT).
- `AnalysisProvider`: `openai-compatible` (any OpenAI-style chat endpoint:
  OpenAI, OpenRouter, Groq, LM Studio, Ollama…), `anthropic`, and
  `heuristic-local` (built-in, offline, clearly labeled as non-AI).

Availability is probed and displayed (Settings + first-run): FFmpeg, FFprobe,
Python+faster-whisper, configured AI providers, disk space. Missing pieces
show a `[Fix]` explanation instead of failing silently.

## State machine

Every project operation runs through explicit, persisted states:

```
created → importing → ready → transcribing → (transcribed)
        → analyzing → analyzed → rendering? → ready
```

Long jobs are also tracked in a `tasks` table (`queued | running | completed |
failed | cancelled`, plus `interrupted` assigned on next launch for jobs that
were mid-flight when the app closed). Recovery UI offers
Resume / Restart / Discard — never silent auto-restart of expensive work.

## Rendering (summary — full detail in RENDER_PIPELINE.md)

FFmpeg filter graph per clip: `trim (‑ss/‑to)` → `scale/crop to 1080×1920 with
smooth focus point` → `subtitles (ASS, burned-in, word-level emphasis)` →
`audio (aac, optional loudnorm)` → `h264 yuv420p + faststart`, written to a
`*.tmp.mp4` and atomically renamed only on success.

## Module layout

```
src/
├── main/
│   ├── index.ts               Electron bootstrap (app, window, protocol, IPC wiring)
│   ├── ipc/                   channel handlers (zod-validated)
│   └── services/
│       ├── app-context.ts     paths/config injection (no electron imports below this)
│       ├── events.ts          typed event bus
│       ├── database/          sql.js wrapper, migrations, repositories
│       ├── projects/          project lifecycle + on-disk structure
│       ├── media/             ffmpeg locator, ffprobe inspect, thumbnails, url providers
│       ├── transcription/     providers + transcript import
│       ├── ai/                chat providers, analysis orchestration, metadata gen
│       ├── rendering/         caption ASS build, ffmpeg pipeline, render queue
│       ├── settings/          app settings + secrets store
│       └── diagnostics/       dependency probes, diagnostic export, logging
├── preload/index.ts           contextBridge → window.clipwright (explicit methods)
├── renderer/
│   ├── components/            UI primitives (Button, Modal, Progress, Toast…)
│   ├── features/              dashboard / project / transcript / clips / editor /
│   │                          render-queue / settings
│   ├── stores/                zustand stores (nav, projects, tasks, settings, editor)
│   ├── api/client.ts          transport-agnostic API client (IPC or HTTP+SSE)
│   └── styles/                design tokens + global styles
├── shared/                    types, zod schemas, constants (caption styles,
│                              platform presets), pure domain logic used by BOTH
│                              sides: time utils, filename sanitization, caption
│                              segmentation, candidate validation/dedup
├── prompts/                   prompt/template layer (main-process only)
server/preview.ts              browser preview (same services over HTTP+SSE)
scripts/                       fixtures generator, python transcriber
tests/                         unit + integration suites
```

Nothing in `src/renderer` imports from `src/main`; everything crosses the
bridge through `shared` contracts.
