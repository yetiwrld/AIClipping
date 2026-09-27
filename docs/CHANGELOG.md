# Changelog

All notable changes to Clipwright Studio. Format loosely follows
Keep a Changelog; versioning follows the app package version.

## Unreleased — professional UI redesign

### Changed
- Complete visual redesign per the professional-UI brief: neutral graphite
  design system with a single muted-orange accent, 4/6/8 px radii, flat
  panels and dividers instead of card stacks, no gradients/glow/blur/sparkle
  iconography, Lucide icons at standardized 1.75 stroke.
- Dashboard: dense project rows (thumbnail, duration, clip/moment counts,
  edited-when, status dot) with a context menu (open / rename / delete with
  confirmation) and inline active-task lines; no hero, no KPI cards.
- Moments: analytical list — CLIP NN index, mono timecodes, compact
  `NN / 100` performance-audit value, per-dimension bar rows, why-selected
  explanation, heuristic-vs-AI provider labeling; variations as a segmented
  control.
- Clips: media-asset rows with thumbnail, timecodes, caption style, status,
  live render progress, per-row Edit/Render/Export/Reveal/Copy/Delete.
- Editor: real workspace — top bar (inline title, save state, Render), stage
  with aspect-correct preview that mirrors the render plan, collapsible
  inspector sections (Trim / Captions / Crop / Metadata), professional
  timeline (labeled ruler, trim handles, playhead, caption-timing strip) and
  a compact transport with timecode.
- Render queue: grouped Rendering / Queued / Completed / Failed task monitor
  with live progress, retry, cancel, reveal; recent-operations table.
- Settings: left nav + rule-divided sections, aligned controls, status dots
  instead of text glyphs.
- Sidebar: identity block, workspace nav with live render count, settings at
  the bottom, 2 px accent indicator on the active item.

### Fixed
- B-008: deleting a project while its import task was running crashed the
  backend; background task failures can no longer kill the process, and the
  import fails with a structured `PROJECT_DELETED` error instead.
- Test fixtures: `transcript.json` segment text was regenerated (an older
  generation pass had written "undefined …" text fields).

## 0.1.0 — MVP (2026-09-27)

### Added
- Phase 0: environment audit + full architecture documentation set
  (`ENVIRONMENT_AUDIT`, `ARCHITECTURE`, `DEVELOPMENT_PLAN`, `DATA_MODEL`,
  `AI_PIPELINE`, `RENDER_PIPELINE`, `SECURITY`, `DECISIONS`).
- Application shell: Electron + React 19 + TypeScript (strict), dark themed
  desktop UI, navigation, dashboard, settings, toasts, first-run dependency
  check.
- Local-first storage: SQLite (sql.js) with forward-only migrations,
  per-project directory structure, atomic persistence, `project.json` mirror.
- Media ingestion: local file import, ffprobe inspection, thumbnails,
  Range-streamed playback (custom protocol), URL import via provider
  adapters (direct HTTP; yt-dlp when installed), honest no-audio/unsupported
  errors.
- Transcription: provider abstraction — faster-whisper (local Python),
  OpenAI-compatible cloud, SRT/VTT/JSON/text import; synced transcript
  viewer (click-to-seek, follow playback, search, copy).
- AI analysis: OpenAI-compatible + Anthropic providers, prompt template
  layer, segment-ID-constrained JSON, zod validation with repair/retry,
  moment deduplication, offline heuristic analyzer fallback.
- Performance Audit: 8 scoring dimensions + overall estimate + explanations,
  always labeled as an estimate and attributed to its provider.
- Caption engine: shared segmentation + word timing, 6 built-in styles,
  emphasis, ASS burn-in with bundled OFL font, SRT export.
- Clip editor: timeline with draggable in/out, live caption/crop preview,
  caption text editing, style + crop controls, metadata editing,
  keyboard shortcuts.
- Render engine: staged FFmpeg pipeline, streaming progress, atomic output,
  queue with configurable concurrency, cancel/retry, failure attribution,
  interrupted-job recovery on launch.
- Content packaging: AI metadata (title/description/hashtags/CTA) — editable,
  platform presets, export bundles, clipboard copy.
- Browser preview server (dev tool) running the same backend services over
  HTTP+SSE.
- Test suite: unit + integration (real FFmpeg renders, mock AI server,
  fixture generator).
- Diagnostics export, storage management panel, structured logging with
  secret redaction.

### Notes
- Whisper model weights cannot be downloaded inside the development sandbox
  (filtered egress); the local provider reports availability honestly and
  works on user machines with normal internet access.
- No telemetry of any kind. External AI calls happen only when a provider is
  configured and selected, and send transcript text only — never media.

## 0.1.0 — MVP code complete (Phase 1–10)

- Full renderer: dashboard, first-run experience, project pipeline tabs
  (source/transcript/moments/clips/renders), clip editor (timeline, caption
  preview, crop guide, metadata), global render queue with interrupted-task
  recovery UI, settings (AI providers with key storage + connection test,
  transcription, video, captions, export, storage/privacy, advanced with
  dependency status).
- Browser preview server (`npm run preview:web`) serving the real backend
  over HTTP + SSE (ADR-007), with upload + media-range streaming.
- Test suite: 134 tests (96 unit / 38 integration) — includes real FFmpeg
  end-to-end render (1080×1920 + burned captions), mock-server AI adapter
  verification, DB state machines, recovery paths, export bundles.
- Fixes surfaced by testing: render-cancel attribution (B-004),
  missing-source attribution (B-005), malformed word timings (B-006),
  formatClock/sanitizeFilename defects (B-007).
- IPC contract tightened: every `ClipwrightApi` method returns a Promise;
  `tasks.cancel` payload schema added; renderer global `window.clipwright`
  typed via `declare global` in `@shared/ipc`.
