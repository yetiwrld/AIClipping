# Clipwright Studio

**A local-first AI video clipping & content repurposing studio.**

Clipwright Studio turns long-form video (podcasts, interviews, lectures,
webinars, talking-head recordings) into polished short-form vertical clips —
with transcription, AI-assisted clip discovery, performance audit estimates,
captioning, a clip editor, and local FFmpeg rendering.

- **Local-first**: your media stays on your machine. Nothing is uploaded
  unless you explicitly configure an external AI provider (and only the data
  that operation needs — e.g. transcript text, never the source video).
- **Modular providers**: transcription (local faster-whisper, OpenAI-compatible
  cloud, SRT/VTT/JSON import) and analysis (any OpenAI-compatible endpoint,
  Anthropic, or a built-in offline heuristic analyzer) are pluggable.
- **You stay in control**: the AI recommends moments and explains why; every
  clip, caption, crop and metadata field remains editable.

## Status

See `docs/DEVELOPMENT_PLAN.md` for the phase plan and `docs/TASKS.md` /
`docs/CHANGELOG.md` for current progress. The MVP workflow
(import → transcribe → analyze → edit → render → export) is implemented and
covered by automated tests.

## Development

```bash
npm install        # install dependencies
npm run dev        # run the Electron desktop app (dev mode)
npm test           # unit + integration test suites (runs real FFmpeg)
npm run fixtures   # generate the repeatable test-media fixture set
npm run preview:web# build UI + run the browser preview server (same backend services)
npm run typecheck  # strict TypeScript checks (main + renderer)
npm run dist:win   # build a Windows installer (on a Windows machine)
```

Requires Node.js >= 20. FFmpeg/FFprobe are resolved from: a path you configure
in Settings → your system PATH → the bundled copies shipped with the app.

## Documentation

All architecture and process documents live in [`docs/`](docs/):
`ARCHITECTURE.md`, `DEVELOPMENT_PLAN.md`, `DATA_MODEL.md`, `AI_PIPELINE.md`,
`RENDER_PIPELINE.md`, `SECURITY.md`, `DECISIONS.md`, `TASKS.md`, `TEST_RESULTS.md`.

## License

MIT. Bundled fonts (Inter) are licensed under the SIL Open Font License —
see `resources/fonts/OFL.txt`.
