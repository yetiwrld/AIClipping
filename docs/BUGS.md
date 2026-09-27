# Bugs & Fixes

Format: symptom → cause → fix → regression test.

## B-001 — `@vitejs/plugin-react` version incompatibility
- **Symptom**: initial scaffold planned `@vitejs/plugin-react@6`, which peers
  with `vite@^8`, while `electron-vite@5` supports `vite@^5–7`.
- **Cause**: latest-of-each package is not a compatible set.
- **Fix**: pinned `vite ^7.3.6` + `@vitejs/plugin-react ^5.2.0` (peers
  `vite ^4–8`). Verified with `npm view` before install.
- **Regression**: `npm run typecheck` + build would fail loudly on peer
  mismatch at install time.

## B-002 — sandbox cannot download FFmpeg/Whisper models (environment)
- **Symptom**: `ffmpeg` missing; `apt-get` index fetch fails; HuggingFace and
  GitHub release assets unreachable.
- **Cause**: filtered egress (see `ENVIRONMENT_AUDIT.md`).
- **Fix**: npm-tarball FFmpeg binaries (ADR-002); local Whisper provider
  reports unavailability honestly; tests use import-file + mock AI server.
- **Regression**: provider availability probes return correct status; no
  feature silently pretends to work.

## B-003 — vitest 5 requires @types/node >= 22 peer
- **Symptom**: peer warning risk with older @types/node.
- **Fix**: pinned `@types/node ^22`.

## B-004 — cancelled renders recorded as failed
- **Symptom**: aborting a render left the job `failed` instead of `cancelled`.
- **Cause**: `runProcess` rejects with code `PROCESS_CANCELLED` on abort, but
  the queue only recognized `RENDER_CANCELLED`.
- **Fix**: queue treats signal.aborted / either code as cancellation
  (render + task rows → `cancelled`).
- **Regression**: pipeline integration test "cancel" asserts the settled
  state and absence of leftover temp files.

## B-005 — missing-source renders misattributed as FONT_ERROR
- **Symptom**: deleting a project's source before rendering reported a font
  problem.
- **Cause**: libass/fontconfig chatter appears in stderr even when the real
  error is "No such file or directory"; the font pattern was checked first.
- **Fix**: `mapFfmpegFailure` checks missing-file before font patterns →
  `SOURCE_MISSING` with a re-import hint.
- **Regression**: forced-failure pipeline test expects `SOURCE_MISSING`.

## B-006 — segmentToWords crashed on malformed word timings
- **Symptom**: a segment whose `words` array lacked `word`/timing fields
  threw `Cannot read properties of undefined (reading 'trim')`.
- **Fix**: defensive checks; falls back to segment bounds per token.
- **Regression**: unit test feeds broken timings and asserts fallback.

## B-007 — small shared-utility defects found by unit tests
- `formatClock` did not roll hours (`3600 → "60:00"`); now `1:00:00`.
- `sanitizeFilename` did not strip DEL (0x7f); now treated as illegal.
- Both covered by unit tests.

## B-008 — deleting a project mid-import crashed the backend
- **Symptom**: `projects.delete` while a `media.importFile` task was still in
  flight killed the process: `TypeError: Cannot read properties of null
  (reading 'id')` at `writeProjectJson` (repositories.ts) — the re-fetch after
  the long copy returned null for the deleted project. Found while exercising
  the redesigned dashboard's new row context menu (delete) via the preview API.
- **Root cause (two layers)**:
  1. `importMediaFile`/`importMediaUrl` cast the post-copy `projectsRepo.get`
     result to `Project` without re-checking existence.
  2. The IPC layer dispatches background tasks fire-and-forget
     (`void tasks.run(...)`); `TaskManager.run` records the failure then
     **rethrows**, producing an unhandled promise rejection that terminates
     the host. Any failing background task could crash the app this way.
- **Fix**: (1) both import paths now re-check the project and fail with a
  structured `PROJECT_DELETED` AppError; (2) `backend.ts` dispatches through a
  `runTask()` helper that swallows the rethrow — task failure state is already
  persisted on the task row and emitted via events. `TaskManager.resume()`
  still awaits `run()` directly, so user-initiated retries keep their errors.
- **Verified**: exact repro (create → queue import → delete immediately)
  against the live preview server: process stays alive, task row records
  `failed / PROJECT_DELETED / "This project was deleted during import."`,
  recovery-on-restart unaffected. Full suite remains 134/134.

## B-009 — intermittent unhandled rejection in test teardown (open, infra-only)
- **Symptom**: rarely, a full parallel `vitest run` reports one unhandled
  rejection: `ENOENT mkdir /tmp/clipwright-test-*/database` from
  `AppDatabase.persistNow`, attributed to `ai-provider.test.ts`.
- **Cause**: the DB's unref'd 250 ms flush timer can fire while the worker's
  temp workspace is being removed; `cleanup()` awaits `ctx.shutdown()` first,
  so this is a narrow scheduling race under load, not app logic (the real
  shutdown path logs `database persisted` reliably).
- **Status**: open, non-blocking (tests 134/134, exit code 0). Revisit if it
  flakes CI.

## B-010 — provider settings could not be saved from the UI (critical)
- **Symptom**: changing any field in Settings → AI providers (base URL,
  model, temperature…) failed with "The settings update failed validation."
  Found in the final QA button/form audit — the provider form had never been
  exercised end-to-end through the real IPC path before.
- **Cause**: `updateSettings` merged patches one level deep
  (`{...currentSection, ...patchSection}`), so the form's partial patch
  `{ ai: { openai: { baseUrl } } }` replaced the entire `ai.openai` object;
  the now-missing required fields (temperature, maxTokens, jsonMode,
  supportsAudio) failed the schema.
- **Fix**: two-level merge (section → provider/field) in
  `src/main/services/settings/index.ts`, preserving flat sections unchanged.
  Regression test: partial patch preserves sibling fields and persists.
- **Verified**: live through the preview API — partial save keeps
  temperature/maxTokens/jsonMode and survives restart.

## B-011 — local-Whisper detection gave up after the first Python
- **Symptom**: user installed faster-whisper but the app kept reporting
  "Python found (python) but the 'faster-whisper' package is not installed."
- **Cause**: `detectLocalWhisper` returned on the FIRST Python found on PATH
  (Windows: `python`) without ever probing `py`/`python3`. Windows machines
  routinely have several interpreters (python.org, Microsoft Store alias, the
  py launcher) and the package may be in any of them. Also: dependency
  results were probed once at startup with no way to re-check without a
  restart.
- **Fix**: probe EVERY candidate (deduped by resolved path); prefer the first
  that imports faster_whisper; when none do, the message names the exact
  interpreter path(s) and the exact command to run
  (`"<path>" -m pip install faster-whisper`). Settings → Transcription now
  has a **Re-check** button (`app.refreshDependencies`) — no restart needed.
- **Regression**: `tests/unit/whisper-detect.test.ts` (6 tests: next-candidate
  fallback, same-binary dedupe, exact-path message, broken-stub tolerance).

## B-012 — background task failures were silent (URL import "did nothing")
- **Symptom**: importing a page URL (YouTube etc. without yt-dlp) created a
  project and failed in the background task with no toast and no visible
  reason — the user only saw a row stuck at "Empty"/"Import failed".
- **Cause (three layers)**: (1) task failures only updated the task row, the
  renderer never toasted them; (2) the provider check ran inside the
  fire-and-forget task, so the import call itself returned success; (3) the
  dashboard had no pre-flight check, so it created a placeholder project
  even for URLs no provider could handle.
- **Fix**: (1) `task:update` with `state: failed` now toasts the structured
  error; (2) `media.importUrl` fails fast via a shared `checkUrlProviders()`
  check before creating the task, and the dashboard removes the placeholder
  project on that rejection; (3) new `media.checkUrl` IPC powers a live
  hint under the URL field ("Importable via Direct media URL" / the exact
  reason it is not). URL imports also now name the project after the file
  instead of "URL import".
- **Verified live**: direct .mp4 over HTTP imports end-to-end (ready,
  1280×720); YouTube URL rejected with the yt-dlp explanation; a real
  mid-download failure still toasts via the task path.
