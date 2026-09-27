# Release Checklist — Clipwright Studio

Run before every release. Items marked *(this QA)* were verified on
2026-09-27; re-run them on the release machine.

## 1. Automated gates

- [x] `npm install` — clean, 0 vulnerabilities *(this QA)*
- [x] `npm run typecheck` — clean *(this QA)*
- [x] `npm run fixtures` — generates test media *(this QA)*
- [x] `npm run test:unit` — 96/96 *(this QA)*
- [x] `npm run test:integration` — 64/64 *(this QA)*
- [x] `npm test` — 160/160 *(this QA)*
- [x] `npm run build` — clean *(this QA)*

## 2. Packaging (Windows machine required)

- [ ] `npm run dist:win` completes
- [ ] `dist/Clipwright Studio-<version>-setup-x64.exe` produced
- [ ] Installer runs on a clean Windows 11 x64 machine
- [ ] First-run environment check shows FFmpeg/FFprobe OK
- [ ] Bundled caption fonts render in preview and output
- [ ] Uninstaller removes the app (user data kept by design)

## 3. Smoke test on the packaged app (Windows)

- [ ] Create project → import a real long video → plays in preview
- [ ] Transcript import (SRT) or local Whisper transcription
- [ ] Heuristic analysis works offline (network off)
- [ ] Provider configured → Test connection → success with latency
- [ ] AI analysis → moments with audit scores → create clip
- [ ] Editor: trim/captions/crop/metadata changes persist after app restart
- [ ] Render 9:16 → output plays, correct aspect; render 4:5 → 1080×1350
- [ ] Export produces mp4 + metadata files; Reveal folder opens Explorer
- [ ] Cancel a running render; retry a failed one; interrupted tasks resume
      only with explicit user action
- [ ] Delete a project (with confirmation) while its import runs → app survives
- [ ] API key never visible in UI/logs/diagnostics export

## 4. GonkaRouter / provider acceptance (with a real key)

- [ ] Base URL `https://api.gonkarouter.io/v1`, key pasted in Settings → AI
- [ ] Test connection → "Connection successful — model responded correctly"
- [ ] Model ID with `/` accepted verbatim (e.g. `zai-org/GLM-5.3-Flash`)
- [ ] If gateway rejects `response_format`: analysis still succeeds (auto
      fallback), or JSON mode disabled manually
- [ ] If 401 with Bearer: switch **API key header** to `x-api-key` → success
- [ ] Full AI workflow: analyze → audit scores → clip → generate metadata

## 5. Release hygiene

- [ ] Version bumped in `package.json`
- [ ] `docs/CHANGELOG.md` updated
- [ ] `docs/TEST_RESULTS.md` updated with the release run
- [ ] No secrets/keys in the repo (`git grep -E "sk-[A-Za-z0-9]|gk-"` clean)
- [ ] No fixtures or build output committed
- [ ] Tag the release commit
