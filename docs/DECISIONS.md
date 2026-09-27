# Decision Records

Chronological. Format: context → decision → consequences.

## ADR-001 — Package manager: npm
**Context**: empty repo; sandbox has npm 10 + yarn 1.22, no pnpm.
**Decision**: npm with `package-lock.json` committed.
**Consequences**: single lockfile; `npm ci` reproducible installs.

## ADR-002 — FFmpeg sourcing: detect → PATH → bundled `@ffmpeg-installer`
**Context**: FFmpeg absent in dev sandbox; apt blocked; GitHub release assets
blocked; app must work on clean Windows machines.
**Decision**: resolution order = user setting → system PATH →
`@ffmpeg-installer/ffmpeg` + `@ffprobe-installer/ffprobe` (npm-tarball
binaries, unpacked from asar). Bundled build is ffmpeg 4.1 — verified to
support trim/scale/crop/lanczos/subtitles(ass)/aac/loudnorm/faststart.
**Consequences**: works out-of-the-box everywhere we can test; users with
newer system FFmpeg get it automatically. `subtitles` filter availability is
probed at runtime; SRT sidecar + explicit error if a build lacks libass.
Accepted: 4.1 lacks some modern filters (we don't use them).

## ADR-003 — SQLite via `sql.js` (WASM), not `better-sqlite3`
**Context**: the same backend must run inside Electron, plain Node
(browser preview server), and Vitest. `better-sqlite3` is a V8-ABI native
module → needs different rebuilds per runtime; a single checkout cannot
serve all three without forked installs.
**Decision**: `sql.js` behind a small `Database` adapter
(`open/exec/run/all/transaction/persist`), whole-file atomic persistence
(`db.export()` → temp file → rename), debounced + flushed on every write
transaction and at shutdown.
**Consequences**: zero native builds, identical behavior everywhere,
crash-safe atomic writes. Trade-off: DB is memory-resident (fine: our DB is
metadata-scale, MBs — sources/renders are files, not blobs) and writes are
whole-file (fast at this size). Adapter keeps a future swap to
`better-sqlite3` local.

## ADR-004 — Workers = subprocesses, not utility processes
**Context**: spec requires isolated background workers; heavy work is
FFmpeg/Python/HTTP.
**Decision**: FFmpeg & Python run as spawned subprocesses with streamed
progress; AI calls are async `fetch`; no `child_process.fork` workers needed.
**Consequences**: process isolation exactly where it matters (CPU/media),
zero worker bundling complexity, cancellation = subprocess kill, and the
preview server / tests reuse everything unchanged.

## ADR-005 — Timestamps from segment IDs, never raw numbers from the model
**Context**: LLMs invent plausible-looking timestamps.
**Decision**: discovery prompts require `startSegmentId/endSegmentId`
referencing the numbered transcript; times are derived by the app.
**Consequences**: hallucinated timestamps are structurally impossible;
validation only needs to check range sanity. Model never sees or produces raw
seconds (except optional display hints).

## ADR-006 — Offline heuristic analyzer is a first-class provider
**Context**: spec forbids fake AI and requires graceful degradation; dev
sandbox has no AI keys.
**Decision**: `heuristic-local` analysis provider computes candidates and the
same audit dimensions from transparent signals (cue phrases, questions,
superlatives, numbers, sentence completeness, duration fit), labeled
"Local heuristic — not an AI model" everywhere it surfaces.
**Consequences**: the full product workflow is demonstrable and useful with
zero configuration; scores are honest about their origin. Cloud AI strictly
improves quality when configured.

## ADR-007 — Dual transport API client (Electron IPC + HTTP/SSE)
**Context**: sandbox cannot display Electron windows (no X server); the user
should still be able to use the real app.
**Decision**: services import no Electron APIs; `server/preview.ts` (Express)
exposes the same service calls over HTTP + SSE and serves the built renderer.
The renderer's API client auto-detects `window.clipwright` vs browser.
**Consequences**: browser preview runs the **real** backend (real DB, real
FFmpeg, real providers). One extra transport (~300 LOC). Desktop remains the
primary target; preview is labeled "browser preview" in its UI chrome.

## ADR-008 — Bundled OFL font for captions
**Context**: burned-in captions need deterministic fonts across machines;
sandbox has none installed; Windows font sets vary.
**Decision**: ship Inter (SIL OFL) TTFs in `resources/fonts` (sourced from the
`@expo-google-fonts/inter` npm package), pass via ASS `fontsdir`.
**Consequences**: identical render output everywhere; license file shipped;
system-font fallback if files are missing.

## ADR-009 — Caption preview ≈ output via shared segmentation module
**Context**: DOM caption preview can't be pixel-identical to libass.
**Decision**: one pure module (`src/shared/captions`) performs segmentation +
word timing for both the DOM overlay and the ASS generator.
**Consequences**: identical text/timing/emphasis logic; only rasterization
differs (documented in UI as preview approximation).

## ADR-010 — Custom media protocol, not `webSecurity: false`
**Context**: `<video>` needs local file access with Range support.
**Decision**: privileged `clipwright-media://` protocol handler with
workspace-containment check (Electron); `/api/media/stream` with same check
(preview server).
**Consequences**: no disabled security flags; no arbitrary file reads.

## ADR-011 — Whole-file atomic persistence pattern everywhere
**Context**: crash safety for DB, `project.json`, analysis caches, secrets.
**Decision**: every persisted artifact is written to `*.tmp` then renamed.
**Consequences**: no torn writes; interrupted launches recover cleanly via
the `interrupted` task state.

## ADR-012 — Name & identity
**Context**: spec demands original branding; product name configurable, not
hard-coded into paths.
**Decision**: product "Clipwright Studio" (`com.clipwright.studio`); workspace
directory name is a setting (default `ClipwrightStudio` under OS userData);
env override `CLIPWRIGHT_WORKSPACE` for dev/tests.
**Consequences**: renames don't break storage paths.

## ADR-013 — Test strategy: real pipeline, mock only the network edge
**Context**: tests must prove the shipped pipeline works without sending
anything to real AI providers or needing Whisper models.
**Decision**: unit tests cover shared pure logic; integration tests run the
real service stack (real SQLite via sql.js, real bundled FFmpeg, real
renders) against throwaway workspaces; the only mocks are a localhost HTTP
server impersonating an OpenAI-compatible/Anthropic endpoint and generated
deterministic media fixtures (`npm run fixtures`, gitignored).
**Consequences**: renders/exports/DB behavior are proven, not simulated;
provider error mapping is verified without keys or egress; suite runs ~55s.

## ADR-014 — Professional UI redesign: one design system, zero decoration
**Context**: the MVP UI read as generic "AI SaaS" (purple accent, gradients,
glow, glass blur, sparkle iconography, score rings, card soup). The redesign
brief demands professional desktop video-production software: neutral,
dense, tool-like.
**Decision**: full rewrite of `global.css` as the single source of truth —
graphite palette (`#101010`–`#2a2a2a`), ONE muted orange accent `#d9833c`
(active nav, primary action, progress, selected controls, links), semantic
success/warn/danger, radii 4/6/8 px, 30 px control height, no gradients, no
backdrop blur, no glow, no score rings. Legacy CSS variables (`.card`,
`--bg-*`) are aliased to the new tokens so untouched code keeps rendering.
Screens rebuilt on top: sidebar shell (identity + nav + settings, 2 px accent
indicator), dashboard (dense project rows + context menu: open/rename/delete),
project workspace (tabs + compact stepper), moments (analytical list: CLIP NN,
timecodes, `86 / 100` audit value, dimension bar rows, why-selected, provider
honesty), clips (media asset rows), editor (top bar / stage + collapsible
inspector / ruler timeline with caption strip + transport), queue (grouped
Rendering/Queued/Completed/Failed), settings (nav + rule-divided sections).
**Editor correctness**: the preview frame now mirrors `buildRenderPlan`
exactly — frame sized in JS from the stage + the *selected* aspect-ratio
target (`ASPECT_RATIOS`), crop math uses the same target, so preview ==
render for 9:16/4:5/1:1/16:9.
**Consequences**: no functional changes; all 134 tests, typecheck, build and
the live E2E smoke (import → transcript → analyze → clip → render) pass; the
only behavioral additions are dashboard rename/delete affordances calling the
existing validated IPC methods.
