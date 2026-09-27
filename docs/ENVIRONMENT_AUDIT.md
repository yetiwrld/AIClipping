# Environment Audit (Phase 0)

Date: 2026-09-27 · Auditor: development agent · Recorded honestly, including gaps.

## Host environment (development sandbox)

| Check | Result | Impact |
|---|---|---|
| OS | Debian GNU/Linux 12 (bookworm), x86_64 | Dev/test host only. **Target platform is Windows 11**; code must stay portable (Node APIs + path joins, no POSIX-only assumptions in app code). |
| CPU / RAM | 2 cores, 3.8 GiB | Restricts heavy parallel work; render queue concurrency defaults to 1. CPU-only render path must work (it does). |
| Disk | ~20 GB free | Enough for fixtures + tests; large-media manual QA happens on target machines. |
| Node.js | v22.22.3 ✓ | >= 20 required. |
| npm | 10.9.8 ✓ | Package manager of record (no lockfiles for yarn/pnpm existed; repo was empty). |
| pnpm / yarn | not installed / 1.22 | Not used. |
| Git | 2.39.5 ✓ | Work happens on branch `arena/01a0e298-aiclipping`. |
| Python | 3.11.2 + pip 23.0.1 ✓ | Local transcription adapter (faster-whisper) is implementable and shippable. |
| FFmpeg / FFprobe | **NOT on PATH** | Resolved by shipping `@ffmpeg-installer/ffmpeg` + `@ffprobe-installer/ffprobe` as bundled fallbacks (binaries ship inside npm tarballs). System FFmpeg is still preferred when detected. |
| GPU | none (`nvidia-smi` absent) | No hardware encoder path in dev. GPU detection is implemented in-app (encoder probe + `nvidia-smi` when present) with CPU fallback. |
| Env vars | No AI provider keys present (names only inspected) | AI features must degrade to the offline heuristic analyzer; cloud providers are configured by the user later. |

## Network reachability (sandbox egress is filtered)

| Host | Reachable | Consequence |
|---|---|---|
| registry.npmjs.org | ✓ | npm dependencies install normally. |
| github.com | ✓ | Repository git operations work. |
| deb.debian.org, security.debian.org | ✗ | `apt-get` unusable → FFmpeg/Xvfb cannot be installed from apt. |
| objects.githubusercontent.com | ✗ | GitHub release-asset downloads (e.g. `ffmpeg-static` postinstall) fail → npm-tarball binaries (`@ffmpeg-installer/*`) chosen instead. |
| huggingface.co | ✗ | Whisper model weights **cannot be downloaded in this sandbox**. The faster-whisper local provider is fully implemented but will honestly report "model not available" here; it downloads on real user machines. Tests cover the adapter contract, SRT/VTT import, and cloud adapters (against a local mock server). |
| Xvfb / display server | unavailable (no apt) | Headless Electron screenshots are not possible in this sandbox. GUI is verified by (a) the browser preview server that runs the **real** backend services, and (b) manual test scripts for Windows. |

## Existing project analysis

- Repository `yetiwrld/AIClipping` contained a single `README.md` (13 bytes) and one commit. **Clean project** — nothing to preserve or migrate.
- No existing framework, package manager lockfile, or CI to adapt to.

## Consequences for the build (see DECISIONS.md for detail)

1. **FFmpeg strategy**: settings override → system PATH → bundled `@ffmpeg-installer` build (ffmpeg 4.1: verified sufficient for trim/scale/crop/subtitles(ass)/aac/loudnorm/faststart). Feature-detection reports the active binary + version in Settings → Advanced.
2. **SQLite via `sql.js` (WASM)** instead of `better-sqlite3`: the environment must run the same database layer inside Electron, inside plain Node (browser preview server), and under Vitest. One native module cannot serve three ABIs without painful rebuilds; sql.js is byte-identical everywhere at the cost of whole-file persistence (acceptable at our data sizes — see DECISIONS ADR-003).
3. **Local transcription**: `faster-whisper` (Python) adapter ships with an availability probe (`python3 -c "import faster_whisper"`). Sandbox cannot fetch models → provider correctly reports unavailable; SRT/VTT/JSON transcript import and OpenAI-compatible cloud transcription are the working alternatives here.
4. **No fake functionality**: features that depend on unreachable external resources report their real status in the UI rather than being stubbed with fake success.
