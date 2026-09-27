# 83-Section Overhaul — Interim Report (Phases A + B)

**Commit:** `f86e2b9` on `arena/01a0e298-aiclipping` (pushed)
**Scope this round:** §1–14 source playback, §22/§29 bar passthrough, §2 analysis gate, §24–28 smart crop, §58–60 codec/export controls, §13–14 relink.
**Status:** All three reproduced root causes are FIXED and verified live on the running preview backend. Suite: **222/222** (was 203).

---

## 1. The three root causes — fix + live evidence

### Bug #1 — Source page was a dead black box (`SourceTab.tsx`)
**Before:** a bare `<video controls>` in a hardcoded 16:9 box — no error handling, no proxy workflow, no relink, wrong aspect for portrait sources.
**Now (§1–14, §76):**
- Aspect-correct player (uses the real source geometry, e.g. 1080×1920 shows as 9:16).
- Real controls: play/pause, ±10s, scrub, time, mute, speed — all functional.
- Playback compatibility verdict before playback (`media.checkPlayback`): `native` / `proxy` / `audio-only` / `missing`.
- FFmpeg proxy workflow for codecs Chromium can't decode (proxy is preview-only — renders always use the original, §64).
- Missing source → relink UI instead of a dead player (§13–14).
- Position/volume memory: returning to the tab resumes where you left off (§5).

**Live check:** `checkPlayback` returns `verdict: native, sourceExists: true`; renaming the source file flips it to `missing` with the exact filename in the reason; restoring returns `native`.

### Bug #2 — Heuristic analysis invented impossible candidates (§2)
**Before:** heuristic path bypassed `validateCandidate` → a **44.95s candidate against a 10s source** (your forensic repro). Render validation caught it only after a failed render.
**Now:** heuristic candidates pass the **same hard gate** as the AI path (source duration, duration preset, transcript checks).

**Live check (10s forensic source + 60s transcript):**
```
[analysis] heuristic.candidate.rejected: range exceeds source duration
[analysis] heuristic.candidate.rejected: range exceeds source duration
task: analyze failed | The analysis produced no valid clip candidates.
candidates: 0
```
No impossible candidate can ever exist; the analysis fails loudly with the reason instead.

### Bug #3 — Baked-in bars passed through into vertical exports (§22/§29)
**Before:** `computeCrop` had no concept of content bars. Your forensic case: cropdetect on a rendered 1080×1920 output reported `crop=1080:1440:0:246` — the source's baked-in bars shipped straight into the export (your ~1080×1426–1428 visible content).
**Now:**
- **Import-time detection:** `detectContentRect` — FFmpeg cropdetect sampled at 5 points, 2px consensus, ≥60% agreement, ≥2% bar threshold, clamped in-frame. Stored on the project (migration v3). Old projects are backfilled on first smart-crop analysis or relink.
- **Content-aware crops:** every `center/top/bottom/manual/smart` crop is computed **inside the content area**. Bars cannot survive.
- **`fit` mode:** explicit whole-content letterbox (renderer pad chain; preview parity).

**Live check (same forensic source, 9:16 1080p render):**
```
PRE-FIX  render: cropdetect → crop=1080:1440:0:246   (bars baked in)
POST-FIX render: cropdetect → crop=1080:1920:0:0    (frame fully filled)
```

---

## 2. New capabilities

| Capability | What it is | Where |
|---|---|---|
| **Smart crop** (§24–28) | Real FFmpeg scene detection (`select=gt(scene,0.32)` + showinfo) → per-shot saliency: decoded grayscale frames, gradient-energy integral images, best target-aspect window per shot + center bias. Keyframes merged (≤12, no jumps inside a stable composition) and stored on the clip. | `src/shared/video/saliency.ts` (pure, unit-tested), `src/main/services/media/smartcrop.ts`, IPC `clips.analyzeSmartCrop` (task with progress) |
| **Smart render** | Render plan splits kept ranges at keyframe boundaries — each segment carries its own crop window; caption remap unchanged. Editor preview follows the active window during playback (§68 parity). | `plan.ts`, `EditorPage.tsx` |
| **HEVC export** (§58–60) | Opt-in codec setting (collapsed "Advanced export" in Settings → Video), `libx265`, CRF+4, `hvc1` tag for Apple compatibility. Hardware encoders stay H.264-only; quick previews always H.264. Render validation now checks `codec_name`. | `plan.ts`, `queue.ts`, `SettingsPage.tsx` |
| **Relink** (§13–14) | `projects.relinkSource`: pick the moved file → inspected + compared (duration ±5%, resolution ±2px). A different file is refused (`RELINK_MISMATCH`) with specifics — never silently substituted. | `services/projects/index.ts`, shared `relink.ts` helper used by Source tab + editor overlay |
| **Source info diagnostics** | Source tab now shows the detected content area and warns when bars were found. | `SourceTab.tsx` |

**Live evidence:** relink with `sample.mp4` (wrong file) → `RELINK_MISMATCH: That file is 1.0 min long, but this project's source is 0.2 min.` Relink with the same file moved → success, status ready. HEVC render → `ffprobe: codec_name=hevc, 1080x1920`. Smart crop on the forensic clip → 1 keyframe, window `810×1440 at 90,246` (exactly inside the content area).

---

## 3. Tests — 222/222 (was 203)

New:
- `tests/integration/forensic.test.ts` (6 tests, the §22 acceptance end-to-end on a real FFmpeg-built bar-pad fixture): content-rect detection at import; heuristic gate invariant; **rendered output fills ≥95% of frame height (cropdetect)**; smart-crop keyframes inside content; HEVC output; clean delete.
- `tests/unit/saliency.test.ts` (8): integral/window energy (brute-force cross-check), best-window lock-on + bounds, merge/cap/gap-closing, even-clamping.
- `tests/unit/crop.test.ts` (+6): content-rect crops, top/bottom inside content, fit mode, degenerate-rect fallback, `smartWindowAt` coverage + nearest + fallback.
- `tests/unit/schemas.test.ts`: new IPC methods + codec field.
- Fixture: `forensic.mp4` (10s, 1080×1920, content 1080×1440 at y=246 — your case) added to `npm run fixtures`.

---

## 4. Verify on Windows (repo-verified commands)

```powershell
git pull origin arena-01a0e298-aiclipping     # or re-download the ZIP
npm install
npm run fixtures                               # regenerates incl. forensic.mp4
npm run typecheck                              # clean
npm test                                       # 222/222 expected (~4–5 min)
npm run preview:web                            # optional: browser preview on :8787
```

Manual §22 check in the app: import any video that has baked-in bars → Source tab shows "Content area 1080×1440 at 0,246" with the bars warning → create a 9:16 clip → Render → the output fills the frame (no bars).

---

## 5. Remaining in the 83-section overhaul (phases C–K)

Professional timeline polish, caption templates, semantic clipping, smart silence refinements, aspect-ratio UX details, export quality details, playback regression matrix (§75) full pass, and the final 13-item §81 report with §82 verified commands. Nothing in this round was marked done that isn't verified above.
