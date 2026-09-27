# Data Model

Storage: SQLite (via `sql.js` WASM — see DECISIONS ADR-003) at
`<workspace>/database/app.db`. Migrations are forward-only SQL scripts stored
in `src/main/services/database/migrations.ts` and tracked in
`schema_migrations`. Schema changes never destroy user data (no destructive
resets; additive migrations only).

The same entities have a human-readable JSON mirror for portability
(`projects/<id>/project.json`) written on every project update.

## Entity-relationship overview

```
Project 1─n TranscriptSegment
Project 1─n ClipCandidate 1─1? Clip 1─n Render
Project 1─n Task            Project 1─n Speaker (future-ready)
```

## Tables

### projects

| column | type | notes |
|---|---|---|
| id | TEXT PK | UUID v4 |
| name | TEXT | user-editable |
| created_at / updated_at | TEXT | ISO 8601 |
| source_type | TEXT | `file` \| `url` |
| source_path | TEXT? | absolute path of the stored copy inside workspace |
| source_url | TEXT? | original URL when imported via provider |
| source_filename | TEXT? | original filename for display |
| duration | REAL? | seconds |
| width / height | INTEGER? | display dimensions (rotation applied) |
| fps | REAL? | |
| has_audio | INTEGER | 0/1 — transcription blocked with clear error when 0 |
| video_codec / audio_codec | TEXT? | |
| size_bytes | INTEGER? | |
| rotation | INTEGER? | degrees, normalized to 0/90/180/270 |
| status | TEXT | state machine (see below) |
| status_message | TEXT? | last human-readable status/error |
| settings | TEXT (JSON) | per-project overrides (duration targets, provider choice, …) |

Status values: `created · importing · import_failed · ready · transcribing ·
transcription_failed · transcribed · analyzing · analysis_failed · analyzed`.
(State is explicit — never inferred from file existence.)

### transcript_segments

| column | type | notes |
|---|---|---|
| id | INTEGER PK AUTOINCREMENT | stable ordering |
| project_id | TEXT FK → projects (CASCADE) | |
| start_time / end_time | REAL | seconds, `0 ≤ start < end ≤ duration` |
| text | TEXT | |
| speaker | TEXT? | e.g. `speaker_01` when available (optional) |
| confidence | REAL? | average word confidence when available |
| words | TEXT? (JSON) | `[{ word, start, end }]` when word timing available |

Index: `(project_id, start_time)`.

### clip_candidates

| column | type | notes |
|---|---|---|
| id | TEXT PK | UUID |
| project_id | TEXT FK | |
| start_time / end_time | REAL | derived from real transcript segment bounds |
| start_segment_id / end_segment_id | INTEGER | provenance — which transcript segments produced the range |
| title / hook / reason / transcript_excerpt / clip_type | TEXT | AI- or heuristic-generated |
| scores | TEXT (JSON) | dimension breakdown (see AI_PIPELINE) |
| overall_score | INTEGER? | 0–100 aggregate |
| score_explanation | TEXT | "why this score" |
| provider | TEXT | which provider produced it (`openai-compatible:gpt-4o-mini`, `heuristic-local`, …) |
| moment_key | TEXT | dedup group id — overlapping candidates share a moment, shown as variations |
| rank_in_moment | INTEGER | ordering within a moment |
| status | TEXT | `discovered · approved · rejected · converted` |
| created_at / updated_at | TEXT | |

### clips (user-controlled clip configurations)

| column | type | notes |
|---|---|---|
| id | TEXT PK | UUID |
| candidate_id | TEXT? FK | provenance when created from a candidate |
| project_id | TEXT FK | |
| start_time / end_time | REAL | editable trim |
| aspect_ratio | TEXT | default `9:16` |
| crop_mode | TEXT | `center · top · bottom · manual` |
| crop_x / zoom | REAL | manual focus point (0–1) and zoom (1–3) |
| caption_style_id | TEXT | preset id (see constants) |
| caption_overrides | TEXT (JSON) | font size/position/emphasis/… deltas |
| caption_text_edits | TEXT (JSON) | `{ [cueKey]: "edited text" }` |
| title / description / cta | TEXT | editable metadata |
| hashtags | TEXT (JSON) | `string[]` |
| metadata_provider | TEXT? | which provider generated metadata |
| status | TEXT | `draft · rendered` (renders tracked separately) |
| created_at / updated_at | TEXT | |

### renders

| column | type | notes |
|---|---|---|
| id | TEXT PK | UUID |
| clip_id | TEXT FK | |
| output_path | TEXT? | final path only after success |
| status | TEXT | `queued · preparing · rendering · completed · failed · cancelled` |
| progress | REAL | 0–1 |
| stage | TEXT? | pipeline stage for failure attribution |
| error | TEXT? | human-readable `{what, why, hint}` JSON |
| settings | TEXT (JSON) | exact settings snapshot for reproducibility |
| started_at / completed_at / created_at / updated_at | TEXT | |

### tasks (job tracking + crash recovery)

| column | type | notes |
|---|---|---|
| id | TEXT PK | UUID |
| type | TEXT | `download · transcribe · analyze · render · thumbnail` |
| project_id | TEXT? | |
| state | TEXT | `queued · running · completed · failed · cancelled · interrupted` |
| stage / progress / message / error | | live status |
| payload / result | TEXT (JSON) | inputs/outputs for resume/retry |
| created_at / updated_at | TEXT | |

On launch, `running|queued` tasks are re-marked `interrupted` and surfaced in
the recovery UI (Resume / Restart / Discard).

### speakers (future-ready, minimal)

`id, project_id, label, name, color` — populated only when a provider
supplies speaker labels. MVP does not depend on it.

### app_settings

`key TEXT PK, value TEXT (JSON)`. Keys: `general`, `ai`, `transcription`,
`video`, `captions`, `export`, `advanced`. Secrets never live here — they go
to `secrets.json` (see SECURITY.md).

## Invariants enforced in code (not just schema)

- `0 ≤ start_time < end_time` for segments, candidates, clips.
- Candidate/clip ranges ⊆ `[0, project.duration]` (soft tolerance).
- Candidate times derive from **referenced segment ids** returned by the
  model — a model cannot invent a timestamp that no segment contains.
- Render output only marked complete after atomic rename of the temp file.
- All JSON columns round-trip through zod schemas (`src/shared/schemas`).
