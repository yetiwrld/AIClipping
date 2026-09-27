# AI Pipeline

Two independent provider layers — **transcription** and **analysis** — plus a
prompt/template layer and a strict validation gate. Nothing AI-generated is
trusted by type alone: every structure passes zod validation before it can
touch the database or UI.

## Transcription providers (`TranscriptionProvider`)

| id | transport | notes |
|---|---|---|
| `faster-whisper-local` | Python subprocess (`scripts/python/transcribe_faster_whisper.py`) | local, word-level timestamps, model size + compute type configurable, models cached under `<workspace>/models`. Availability probe: `python3 -c "import faster_whisper"`. |
| `openai-compatible` | HTTPS `POST {baseUrl}/audio/transcriptions` (multipart) | OpenAI, Groq, etc. Only used when the user marks the endpoint as audio-capable and provides a key. Sends **only the audio track** (extracted/written to a temp file), never the full video. |
| `import-file` | local file picker | SRT / WebVTT / JSON / plain-text-with-timestamps import — the offline escape hatch. |

Normalized result (stored as `transcript_segments`):

```json
{ "language": "en",
  "segments": [ { "start": 0.0, "end": 4.2, "text": "...", "speaker": "speaker_01",
                  "confidence": 0.93, "words": [ { "word": "…", "start": 0.1, "end": 0.4 } ] } ] }
```

Word timing is optional everywhere (captions fall back to proportional
distribution within a segment).

## Analysis providers (`AnalysisProvider`)

| id | transport | notes |
|---|---|---|
| `openai-compatible` | `POST {baseUrl}/chat/completions` | any OpenAI-style endpoint: OpenAI, OpenRouter, Groq, Together, LM Studio, Ollama (`/v1`). Configurable base URL, model, temperature, max tokens. |
| `anthropic` | `POST https://api.anthropic.com/v1/messages` | separate wire format behind the same interface. |
| `heuristic-local` | in-process | built-in offline analyzer (see below). Always available; clearly labeled **"Local heuristic — not an AI model"** in the UI. |

## Prompt layer (`src/prompts/`)

Prompts live only in main-process code (`clip-discovery.ts`, `scoring.ts`,
`metadata.ts`). Each prompt builder receives structured context (numbered
transcript segments with ids, source metadata, duration targets) and demands
**strict JSON**.

### Anti-hallucination constraints baked into every discovery prompt

- The transcript may contain errors — reason about meaning, don't quote blindly.
- **Timestamps must be expressed as segment id ranges** (`startSegmentId`,
  `endSegmentId`). The application converts ids → real times. This makes
  invented or out-of-range timestamps structurally impossible.
- Never invent dialogue. The excerpt must be reconstructable from the segments.
- Clips must start at a meaningful opening and end after the payoff — no
  mid-thought starts, no dangling endings.
- Prioritize standalone value; inspect the **entire** transcript, not just the
  beginning; avoid near-duplicates of other candidates.
- Respect the requested duration window (short/medium/long), with tolerance.

### Pipeline

```
transcript (+ source metadata, user settings)
  → discoverCandidates (prompt: clip-discovery)      [AI or heuristic]
  → zod validation + segment-id → time conversion
  → reject: out-of-range, too short/long, empty text, degenerate ranges
  → dedup: candidates overlapping >55% (IoU of time ranges) grouped into
    "moments"; each moment keeps ranked variations (hook-rich, context-rich,
    shorter, …)
  → auditScores (prompt: scoring) per moment (batched)
  → zod validation + clamp 0–100 + aggregate overall = weighted mean
  → persist candidates + scores; UI summary ("Found 14 moments …")
```

### Malformed model output handling

1. Strip markdown fences / leading prose; attempt JSON extraction.
2. Safe repair: trailing commas, smart quotes, unescaped newlines.
3. Parse → zod. If invalid: **one** retry with a stricter "JSON only" system
   message.
4. Still invalid: fail the operation with a human-readable error
   (`AI_RETURNED_INVALID_JSON`) listing which candidates, if any, survived —
   partial valid candidates are kept, invalid ones dropped with a warning.

### Scoring dimensions (the "Performance Audit")

`hook · contextCompleteness · clarity · retention · emotionalImpact ·
standaloneValue · shareability · visualSuitability` — each 0–100 with a
per-dimension rationale, plus an overall estimate and a "why this score"
explanation. The UI always labels this as **an estimate by the configured
provider, not a prediction of views**, and shows *which* provider produced it.

The heuristic provider computes the same dimensions from transparent signals
(sentence completion, question/superlative/number cues, duration fit, position
diversity, keyword density) and is labeled accordingly.

### Metadata generation (`metadata.ts`)

Per clip, on demand: `{ title, description, hashtags[], cta }` validated by
zod, fully editable by the user, platform-preset aware (length/format hints
for TikTok / Reels / Shorts / Generic).

## Privacy rules

- Analysis providers receive **transcript text and lightweight metadata only**
  (duration, topic hints) — never video/audio files.
- The UI states, before an external call, which provider will receive data.
- `heuristic-local` and `faster-whisper-local` + `import-file` keep the whole
  workflow on-device; the app never claims "100% private" as a blanket
  statement — the privacy panel states exactly what leaves the machine and when.
- API keys live in `secrets.json` (0600, Electron `safeStorage`-encrypted when
  available), never in the database, logs, renderer, or diagnostics.

## Caching (avoid redundant cost)

- Transcripts are cached per project (re-running analysis never re-transcribes).
- Raw provider responses are archived to `projects/<id>/analysis/*.json`.
- Analysis is only re-run on explicit user action (or transcript change).
- Metadata generation is per-clip and only on request.
