# Tasks

Living task journal. Phases reference `DEVELOPMENT_PLAN.md`.

## Phase 0 — audit & architecture
- [x] Environment audit (`ENVIRONMENT_AUDIT.md`)
- [x] Architecture / data model / AI pipeline / render pipeline / security docs
- [x] Decision records ADR-001…012
- [x] Journals: TASKS / BUGS / TEST_RESULTS / CHANGELOG

## Phase 1 — application shell
- [x] Scaffold: package.json, electron-vite, tsconfigs, vitest, electron-builder
- [x] App context (configurable workspace) + event bus
- [x] sql.js database adapter + migrations + repositories
- [x] Project service: create/list/get/rename/delete + project.json mirror
- [x] Electron bootstrap: window, custom protocol, IPC wiring
- [x] Preload bridge (explicit typed API) + renderer API client (IPC/HTTP+SSE)
- [x] UI shell: dark theme, nav, dashboard, settings skeleton, toasts
- [x] Logging service + first-run welcome/dependency check

## Phase 2 — media ingestion
- [x] FFmpeg/FFprobe locator (setting → PATH → bundled) + version probe
- [x] ffprobe inspection (duration/fps/resolution/codecs/audio/rotation)
- [x] Import local file (copy to workspace `source/`), validate, thumbnail
- [x] Video player w/ Range streaming + custom protocol
- [x] URL ingestion: `VideoSourceProvider` interface, direct-HTTP provider
      (content-type check, `.part` files, progress, cancel), yt-dlp adapter
      (detect-only in sandbox)
- [x] Honest errors for: no audio, unsupported codec, missing file

## Phase 3 — transcription
- [x] `TranscriptionProvider` abstraction + registry + availability probes
- [x] faster-whisper local adapter (Python subprocess, word timestamps)
- [x] OpenAI-compatible cloud adapter (multipart, JSON/verbose_json)
- [x] SRT / WebVTT / JSON / text import
- [x] Transcript persistence + synced viewer (click-seek, follow, search,
      copy, range select)
- [x] Cancellation + resume-safe task tracking

## Phase 4 — AI clip discovery
- [x] `AnalysisProvider` abstraction: openai-compatible, anthropic, heuristic
- [x] Prompt layer (`src/prompts/`): discovery, scoring, metadata
- [x] Segment-ID-constrained output + zod validation + repair/retry
- [x] Deduplication into moments/variations, ranking
- [x] Candidate cards UI (score, reason, excerpt, hook, actions)

## Phase 5 — performance audit
- [x] Scoring pass (8 dimensions + overall + explanation) w/ provider label
- [x] Score breakdown UI + "estimate, not guarantee" framing

## Phase 6 — vertical composition & captions
- [x] Crop modes (center/top/bottom/manual focus + zoom), 1080×1920 math
- [x] Caption engine: segmentation, word timing, 6 styles, emphasis
- [x] ASS generation (+fontsdir) + SRT export
- [x] Clip thumbnails

## Phase 7 — clip editor
- [x] Timeline (playhead, in/out handles, live duration), keyboard shortcuts
- [x] Live caption overlay + crop guide in preview
- [x] Caption text editing, style controls, crop controls
- [x] Metadata editing (title/description/hashtags/CTA)
- [x] Save without re-analysis/re-transcription

## Phase 8 — render engine
- [x] FFmpeg pipeline w/ stages, `-progress` parsing, atomic finalize
- [x] Render queue (configurable concurrency), retry, cancel, reveal
- [x] Failure reports (what/why/hint + technical details)
- [x] Interrupted-job recovery on launch

## Phase 9 — content packaging
- [x] Metadata generation (AI + editable) + platform presets
- [x] Export bundles (mp4 + txt + json), filename sanitization, clipboard copy

## Phase 10 — polish & hardening
- [x] Error surfaces everywhere (what/why/what-now)
- [x] Storage panel (sizes, free space, cleanup w/ confirmation)
- [x] Diagnostics export (no secrets)
- [x] Accessibility: focus states, labels, keyboard nav, tooltips
- [x] Edge cases per QA checklist (`docs/TEST_RESULTS.md`)

## Backlog (post-MVP, architecture already accommodates)
- [ ] Semantic transcript search (embeddings) — `analysis/` cache + segments table ready
- [ ] Speaker diarization UI — `speakers` table exists
- [ ] Face-aware / speaker-tracking crop — `crop_mode` is an open enum
- [ ] B-roll suggestions — candidate JSON carries `clip_type`
- [ ] Batch "generate N clips" — queue + moments model designed for it
- [ ] Learning loop (accepted/rejected feedback capture)

## Phase 11 — verification & packaging (this milestone)
- [x] Renderer complete: queue page (recovery: Run again / Discard), settings
      (7 sections incl. AI provider forms, secret storage hints, connection
      test, privacy statement, diagnostics export, dependency status)
- [x] Shared upload helper for browser preview (deduplicated from 3 files)
- [x] Preview server `server/preview.ts` (Express + SSE + Range media +
      upload), smoke-tested over HTTP incl. workspace-escape guard
- [x] Fixture generator (`npm run fixtures`): deterministic 60s video +
      word-timed transcript at realistic pace
- [x] Unit suite (96): time, filenames, parsers, captions/ASS, candidates,
      heuristic, crop, schemas
- [x] Integration suite (38): database (state machines, cascades, settings,
      recovery), AI adapters (mock localhost server), full pipeline with
      real FFmpeg render + cancel + forced failure + export
- [x] Typechecks green (`tsconfig.node.json`, `tsconfig.web.json`) and
      `electron-vite build` clean
- [x] Journal updated: TEST_RESULTS / BUGS (B-004..B-007) / DECISIONS
      (ADR-013) / CHANGELOG
- [ ] Windows 11 manual run book (docs/TEST_RESULTS.md §Manual) — requires a
      real Windows machine; script and checklist are ready


## Phase 12 — Professional UI redesign (session 2) — DONE
- [x] Design-system rewrite of `global.css` (tokens, components, legacy aliases)
- [x] Shell/sidebar, dashboard rows + context menu, project workspace tabs/stepper
- [x] Moments analytical list, clips asset rows, editor workspace (stage/inspector/timeline/transport), grouped queue, settings sections
- [x] Consistency pass: no sparkles/gradients/glow/emoji; icon-only buttons labeled; loading states name real operations
- [x] B-008 fix (delete-during-import crash + fire-and-forget task containment)
- [x] Docs: ADR-014, B-008/B-009, CHANGELOG, TEST_RESULTS
- [ ] Windows manual visual pass (fold into the existing run book §Manual)


## Phase 13 — Final QA, button audit & provider hardening — DONE
- [x] Full code review (main/preload/renderer/shared/prompts/tests/scripts/docs/server)
- [x] Button audit: 76/76 wired, ordering + accessibility verified
- [x] IPC surface audit: 46/46 contract↔handler↔schema consistency
- [x] B-010 fix: two-level settings merge (provider form saves)
- [x] Provider hardening: authStyle, strict validation, real test button, 422 fallback, URL schema
- [x] 26 new provider tests → 160/160 total; typecheck + build clean
- [x] Live E2E: provider matrix, AI workflow via mock gateway, editor round-trip, restart persistence, key-leak audit
- [x] Docs: RUNNING_WINDOWS / API_SETUP / QA_REPORT / RELEASE_CHECKLIST
- [ ] Windows machine: `npm run dist:win` + packaged smoke test (release checklist §2–4)
- [ ] GonkaRouter live request (user enters key → Test connection)

## Phase 14 — Whisper detection & URL import fixes — DONE
- [x] B-011: multi-candidate Python probe + exact-path message + Re-check button
- [x] B-012: task-failure toasts, URL pre-flight (media.checkUrl), fail-fast importUrl, placeholder cleanup
- [x] 166/166 tests; typecheck + build clean; live verification of both flows
- [ ] User: install faster-whisper on Windows + Re-check (docs/RUNNING_WINDOWS.md §Transcription)
