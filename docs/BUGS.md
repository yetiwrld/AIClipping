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
