# Test Results

Running record per phase. Commands: `npm test` (all),
`npm run test:unit`, `npm run test:integration`.

Fixtures are generated locally (gitignored): `npm run fixtures` →
`tests/fixtures/media/sample.mp4` (60s 1280×720, deterministic testsrc2) +
`tests/fixtures/transcript.json` (149 words / 19 segments, 2.48 wps,
word-level timings on each segment).

## Current status — full suite green

```
npm test
Test Files  11 passed (11)
Tests       134 passed (134)
```

- `npm run typecheck` → `tsc -p tsconfig.node.json` + `tsc -p tsconfig.web.json` both clean.
- `npx electron-vite build` → main 189 kB, preload 0.5 kB, renderer 861 kB — clean.
- Preview server (`npm run preview:web`) smoke-tested over HTTP:
  invoke envelope (ok/error), SSE headers, static index, media Range
  streaming, workspace-escape guard (404), upload endpoint.

## Phase 0 — acceptance

| Criterion | Status |
|---|---|
| Architecture documented | PASS (`ARCHITECTURE.md`) |
| Dependencies identified | PASS (`ENVIRONMENT_AUDIT.md`, `DECISIONS.md`) |
| Missing dependencies known | PASS — FFmpeg (bundled fallback), Whisper models (unavailable in sandbox, honest status), GPU (none, CPU path) |
| Security boundaries documented | PASS (`SECURITY.md`) |
| Media pipeline understood | PASS (`RENDER_PIPELINE.md`) |
| Development phases defined | PASS (`DEVELOPMENT_PLAN.md`) |
| No hidden major unknown dependency | PASS |

## Unit tests (`tests/unit/`) — 96 tests

- `time.test.ts` (11) — timestamp formatting/parsing round-trips, SRT/VTT/ASS
  formats, `isValidRange`, `overlapRatio` (dedupe primitive).
- `filenames.test.ts` (16) — Windows-safe sanitization (illegal chars,
  control chars incl. 0x7f, reserved device names, trailing dots, length),
  slugify, collision suffixes, export filename templates.
- `parsers.test.ts` (9) — SRT/VTT/timestamped-text/JSON transcript parsers:
  malformed blocks skipped, CRLF, micro-cue merging, whisper-style JSON,
  unknown extensions rejected.
- `captions.test.ts` (19) — segmentation (word timing alignment, malformed
  timing fallback, cue clamping to trim windows, user text edits), ASS output
  (PlayRes, karaoke `\kf`, BorderStyle box vs outline, BGR colors, font-size
  scaling, positioning), SRT output, style catalog.
- `candidates.test.ts` (16) — candidate validation (segment anchoring,
  reversed/missing ids, duration gates per preset, source bounds, near-empty
  speech), scoring (weights sum to 1, weighted mean, clamping), dedupe into
  moments (>55% overlap), rank assignment, excerpts.
- `heuristic.test.ts` (8) — local analyzer: deterministic, duration bounds,
  valid segment ids, scores 0–100 matching shared weights, timeline spread,
  empty transcript → no candidates, honest self-labeling.
- `crop.test.ts` (7) — shared crop math: vertical slice, even dimensions,
  in-bounds guarantees across all modes/cropX/zoom, zoom clamping 1–3,
  top/bottom on portrait, no-op when aspects match.
- `schemas.test.ts` (10) — AI output schemas (bad clip types, score ranges),
  exhaustive IPC payload schema list, `projects.delete` confirm semantics,
  app settings validation (complete object, out-of-range rejection).

## Integration tests (`tests/integration/`) — 38 tests

### `database.test.ts` (13) — real SQLite (sql.js), throwaway workspaces
- Projects: create/read/list/update, full documented status machine
  (`created→…→analyzed` + `*_failed` with messages), delete cascades to
  segments/clips/renders/candidates/tasks, persistence across context
  restart (atomic save).
- Segments: replace-atomically, word-timing JSON round-trip.
- Candidates: replace keeps `converted`, deletes only `discovered`;
  rank/score ordering.
- Renders/tasks: lifecycle fields, `findInterrupted`,
  `markInterruptedOnLaunch` (completed tasks untouched).
- Settings: defaults when empty, per-section merge, corrupt JSON → safe
  fallback to defaults.

### `ai-provider.test.ts` (11) — localhost mock HTTP server, never the internet
- OpenAI wire format (Bearer auth, model, response_format, messages).
- 400-on-response_format → automatic retry without it.
- Error mapping: 401/403→AI_UNAUTHORIZED, 404→AI_NOT_FOUND,
  429→AI_RATE_LIMITED, 500→AI_HTTP_ERROR.
- Unconfigured provider / missing key → AI_NOT_CONFIGURED / AI_NO_KEY
  (never a fake success).
- Anthropic wire format (x-api-key, anthropic-version, system split).
- `extractJson` repair: plain, fenced, embedded, trailing commas, null on
  garbage.

### `pipeline.test.ts` (14) — **real FFmpeg end-to-end**, no mocks
- Project create → per-project folder.
- Media import: probe (60.0s, 1280×720, audio), stream-copy into project,
  re-inspect, thumbnail.
- Transcript import → 19 segments persisted with word timings, project
  `transcribed`.
- Heuristic analysis → validated candidates, moment grouping, scores,
  project `analyzed`; re-analysis replaces `discovered`, keeps `converted`.
- Clip creation idempotent per candidate; non-destructive updates persist
  (style, overrides, crop, title).
- Render: queued → preparing → rendering (progress events via SSE bus) →
  completed; output probed as **1080×1920 h264 + aac**, duration within
  tolerance, no temp files left, task row `completed`.
- Cancel: running render aborted → `cancelled` state, no leftover temp.
- Forced failure (source deleted): `failed` with `SOURCE_MISSING`,
  stage recorded, no final artifact.
- Export: mp4 + `.txt` + `.json` sidecars inside exports dir, metadata
  content verified; un-rendered clip → `CLIP_NOT_RENDERED`.
- Startup recovery marks in-flight renders failed + cleans temps.
- Project delete: refuses without confirm, removes folder with it.

## Bugs found by the test pass (fixed, see BUGS.md)

- Cancelled renders were recorded as `failed` (PROCESS_CANCELLED vs
  RENDER_CANCELLED code mismatch).
- Missing-source renders misattributed as FONT_ERROR (fontconfig noise).
- `segmentToWords` crashed on malformed word timings instead of falling back.
- `formatClock` did not roll hours; `sanitizeFilename` missed 0x7f.

## Manual run book (Windows 11 primary target — to execute on a real machine)

1. `npm install && npm run fixtures && npm test` — suite must be green.
2. `npm run dev` — first-run modal appears; dependency check shows FFmpeg
   (bundled), Python/faster-whisper status honestly.
3. Create project → import a real long video → verify preview + info.
4. Import an SRT → transcript tab lists segments; click seeks the player.
5. Analyze with heuristic → moments with Performance Audit breakdown
   (labeled as an estimate, not a prediction).
6. Create clip → editor: trim/captions/crop/metadata; autosave indicator.
7. Render → queue page shows live progress → completed 1080×1920 MP4.
8. Export → files + sidecars in exports folder; reveal works.
9. Kill the app mid-render → relaunch → interrupted job surfaced with
   Run again / Discard.
10. Settings: set a mock AI endpoint (e.g. local LM Studio) → test
    connection; keys stored; diagnostics export contains no secrets.

## Environment notes

- All integration tests use real FFmpeg (bundled installer binary) — they
  exercise the exact pipeline shipped to users.
- Mock AI server binds an ephemeral localhost port; tests never reach the
  real internet.
- Each test gets a throwaway workspace under `/tmp` (real SQLite file,
  atomic persistence, real project folders) and removes it afterwards.
- Local Whisper cannot be exercised in the sandbox (model downloads
  blocked); its provider availability probe reports this honestly and the
  import-file + cloud paths are covered instead.


---

## Redesign verification (2026-09-27, session 2)

**Scope**: full renderer redesign (design system + all screens) plus two
backend robustness fixes found during live verification. No test-suite
behavioral coverage existed for visuals, so verification = typecheck + build +
134-test suite + live preview-server exercise of every API the new UI calls.

| Check | Result |
| --- | --- |
| `npm run typecheck` (node + web, strict) | clean |
| `npx electron-vite build` | clean (renderer 1921 modules, CSS 36.9 kB) |
| `npx vitest run` | **134/134** (96 unit + 38 integration) |
| CSS class audit | every class referenced in TSX resolves in `global.css` |
| Decoration audit | zero `Sparkles`, gradients, backdrop-filter, glow, emoji, purple remnants in `src/renderer` |
| Live E2E via preview bridge | create → import (1280×720) → transcript (19 seg) → heuristic analyze (3 candidates, real titles) → clip → **render completed** → delete; workspace left clean |
| B-008 repro (delete during import) | process survives; task `failed / PROJECT_DELETED`; recovery-on-restart unaffected |
| Fixture regeneration | `npm run fixtures` — 149 words / 19 segments, segment text now real (was `"undefined …"`) |

**Known**: B-009 (rare unhandled rejection in parallel test teardown, infra
race, non-blocking). **Not automatable here**: pixel-level screenshots (no
browser binaries in sandbox) — final visual sign-off happens in the Windows
run book alongside the existing manual checks.
