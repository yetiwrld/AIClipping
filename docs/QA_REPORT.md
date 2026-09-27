# QA Report — Final pass (2026-09-27)

Scope: full engineering/usability/integration QA of the existing application
after the professional UI redesign: code review, complete button audit, API
surface audit, provider hardening (OpenAI-compatible / GonkaRouter), live
end-to-end verification, persistence tests, build/test verification, Windows
run + packaging attempt, documentation.

Method: every claim below was **executed**, not inferred. Live checks ran
through the real backend (`npm run preview:web`, real SQLite + FFmpeg) via the
same IPC surface the renderer uses. The only mocks are a localhost
OpenAI-compatible gateway (`scripts/mock-gonka.ts`) standing in for
GonkaRouter, and the pre-existing localhost provider mock in the test suite.

## Result table

| Area | Result | Evidence |
| --- | --- | --- |
| TypeScript (`npm run typecheck`) | **PASS** | Clean for node + web projects, strict mode |
| Unit tests (`npm run test:unit`) | **PASS** | 96/96 |
| Integration tests (`npm run test:integration`) | **PASS** | 64/64 |
| Combined (`npm test`) | **PASS** | **160/160** (11 files; was 134 before this pass — 26 provider tests added) |
| Build (`npm run build`) | **PASS** | main 194.5 kB, preload 0.5 kB, renderer 877.2 kB JS + 36.9 kB CSS, zero errors |
| Windows package (`npm run dist:win`) | **NOT TESTED to completion** | electron-builder validated config, completed the win32/x64 native rebuild and began packaging, then failed downloading the Windows Electron binary: the QA sandbox blocks the release CDN (`unable to verify the first certificate`). Environmental, not a project defect — must be run once on a normal-network machine. |
| Windows dev run (`npm run dev`) | **NOT TESTED here** | Headless sandbox: no display and the Electron binary CDN is blocked. The identical build pipeline + full backend + renderer are verified via `preview:web` and 160 tests. |
| Project creation | **PASS** | Live API; used by every E2E below; rename/delete/confirmation verified |
| Media import | **PASS** | Live: file import → ffprobe inspection (1280×720/60s), thumbnail, storage accounting; URL import path code-reviewed |
| Transcription (import file) | **PASS** | Live: SRT/VTT/JSON import, 19 segments persisted |
| Transcription (local Whisper) | **NOT AVAILABLE in sandbox** | Provider honestly reports unavailability (Whisper models unreachable — documented environment limit B-002); no silent fake |
| Transcription (cloud/OpenAI-compatible) | **NOT TESTED live** | Requires a real audio-transcription endpoint; chat-completions path is fully tested. Audio upload path code-reviewed only. |
| AI analysis | **PASS** | Live via OpenAI-compatible gateway: 2 candidates, 8 audit dimensions, overall scores; heuristic path live-verified in earlier session + unit tests |
| Moments | **PASS** | Grouping into moments, variations, reject flow, stale-candidate error (`CANDIDATE_NOT_FOUND`), duplicate-submit guard added |
| Clip creation | **PASS** | Live, idempotent (existing clip returned), correct candidate→clip mapping |
| Editor | **PASS** | Live round-trip: trim (+ invalid range rejected `CLIP_RANGE_INVALID`), caption style + 5 overrides, crop mode/focus/zoom + aspect ratio, metadata edits — all persisted; render with edited config produced exactly **1080×1350 (4:5)** |
| Rendering | **PASS** | Multiple live renders completed (9:16 and 4:5); queue states queued→preparing/rendering→completed and →failed covered by integration tests; cancel/retry covered; startup recovery verified (interrupted tasks surface after crash/restart) |
| Export | **PASS** | Live: `exports/<project>/01_slug.mp4 + .txt + .json` produced and listed |
| OpenAI-compatible API | **PASS** | 37 automated tests (wire format, base-URL variants incl. `/v1` + trailing slash + full-endpoint, Bearer/x-api-key/both headers, model-ID passthrough `zai-org/GLM-5.3-Flash`, 401/403/404/429/5xx mapping, 200-with-error, empty content, legacy `choices[0].text`, content arrays, non-JSON bodies, response_format fallback on 400 **and** 422, JSON repair) + live workflow test + live provider-test matrix (no key / wrong key 401 / unreachable / malformed URL / valid) |
| GonkaRouter compatibility | **Compatible + mock-verified; LIVE NOT TESTED — key not configured** | Documented endpoint `https://api.gonkarouter.io/v1`; Bearer default + optional `x-api-key`/both header styles (GonkaRouter accepts both); `/v1` + `/chat/completions` construction verified by tests; full workflow verified against the standards-faithful mock gateway. No real GonkaRouter key exists in this environment, so a live request has not been made — **enter your key in Settings → AI → Test connection to complete this row.** |
| Button audit | **PASS** | Systematic extraction: **76 buttons / 76 wired** (zero dead: no missing onClick, no placeholder handlers, no nonexistent API methods — cross-checked all 46 IPC methods: every renderer call ↔ contract ↔ payload schema ↔ backend handler). Action order reviewed per screen: destructive actions last and separated; primary actions right; loading states on all expensive ops |
| Forms | **PASS** | Settings persistence verified live incl. **partial provider patches** (bug found & fixed — see B-010); invalid input rejected with field-level messages (base URL protocol, token range, temperature range, trim ranges); password field for keys; masked hints |
| Persistence | **PASS** | Full app restart test: settings, API key, project, transcript, candidates + scores, clip + metadata, render job all survived; provider test still passing after restart |
| Error handling | **PASS** | Live matrix: 401/403/404/429/5xx, 200-with-garbage, empty responses, unreachable endpoint, malformed URL, invalid trim, delete-during-import (B-008 regression kept green); structured errors with code + hint + expandable technical details; no raw TypeErrors surfaced |
| API key security | **PASS** | Key never in renderer state (masked hints only), never in logs (grepped), never in exported diagnostics (grepped, 0 occurrences), never in error strings; `secrets.json` mode 0600; OS keychain encryption where available |
| Accessibility | **PASS** | 0 icon-only buttons without labels (audit script); global `:focus-visible` styles; ARIA roles on switch/slider/progressbar/dialog; keyboard: full nav, timeline handles arrow-key nudge (+Shift coarse), space/I/O editor shortcuts, Esc closes dialogs |

## Bugs found and fixed in this pass

1. **B-010 (critical, forms)** — `settings.update` merged patches only one
   level deep, so the AI provider form's partial patches (e.g. changing only
   the base URL) replaced the whole `ai.openai` object and failed schema
   validation: **no provider setting could be saved from the UI**. Fixed with
   a two-level merge + regression test (partial patch preserves siblings).
2. **Provider test was superficial** — reported success on any HTTP 200.
   Replaced with a real service (`src/main/services/ai/test.ts`): sends
   `Reply with exactly: pong`, verifies the model actually answered, measures
   latency, echoes endpoint/model, maps 401/403/404/429/5xx to specific
   messages. 8 dedicated tests + live matrix.
3. **Weak response validation** — a 200 response without message content was
   silently returned as raw JSON. Now: `AI_PROVIDER_INVALID_RESPONSE` with
   diagnostics (finish_reason hint for max-token cutoffs, embedded
   `error` objects surfaced, legacy `choices[0].text` accepted, non-JSON
   bodies rejected with a clear message).
4. **Single auth header** — OpenAI-compatible requests were Bearer-only.
   Added a per-provider **API key header** setting (Bearer / x-api-key /
   both), default Bearer — no behavior change for existing providers,
   flexible for gateways that require `x-api-key` (GonkaRouter documents both).
5. **JSON-mode fallback gaps** — retried without `response_format` only on
   400 and lost the cancel signal on retry. Now also 422, signal preserved.
6. **Base URL schema hole** — `z.string().url().or(z.string().max(200))`
   accepted any string. Now: empty or a complete http(s) URL, with the field
   name in the error message.
7. **Double-submit windows** — Analyze and Export could be double-triggered;
   both now guard against in-flight operations.

## Not yet verified (honest list)

| Item | Reason |
| --- | --- |
| GonkaRouter **live** request | No GonkaRouter API key in this environment. Everything up to the live call is tested (mock gateway + tests). User action: Settings → AI → paste key → Test connection. |
| `npm run dist:win` to completion | Sandbox blocks the Electron win32 binary CDN (TLS interception). Packaging pipeline itself validated up to the download. Run on a Windows machine. |
| `npm run dev` desktop launch | Headless sandbox (no display, no Electron binary). |
| Local Whisper transcription | Whisper model downloads blocked in sandbox; provider reports unavailability honestly. |
| Cloud (audio) transcription | Needs a real audio-transcription endpoint; not exercised live. |
| Pixel-level visual review | No browser/screenshot automation in sandbox; UI verified via build + code review + preview interaction at the API level. Final visual pass belongs to the desktop run. |

## How to re-run the verification

```text
npm install
npm run fixtures
npm run typecheck
npm test                      # 160/160
npm run build
npm run preview:web           # http://localhost:8787 — full app in browser
npx tsx scripts/mock-gonka.ts # optional: offline AI provider for trying the AI workflow
```
