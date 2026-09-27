import fs from 'node:fs'
import path from 'node:path'
import type {
  AppSettings, Clip, ClipCandidate, Project, ProjectSettings, ProjectStatus,
  RenderJob, RenderStatus, ScoreBreakdown, StructuredError, TaskInfo, TaskState,
  TaskType, TranscriptSegment, WordTiming
} from '@shared/types'
import { appSettingsSchema } from '@shared/schemas'
import { DEFAULT_CAPTION_STYLE_ID, DURATION_RANGES } from '@shared/constants'
import type { AppDatabase } from './db'
import type { AppContext } from '../app-context'

/**
 * Typed data access. All JSON columns round-trip through safe parsing;
 * all rows map to domain types before leaving this module.
 */

function now(): string {
  return new Date().toISOString()
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw.length === 0) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function bool(v: unknown): boolean {
  return v === 1 || v === true
}

// ---------------------------------------------------------------- projects --

export interface ProjectRow {
  id: string; name: string; created_at: string; updated_at: string
  source_type: string; source_path: string | null; source_url: string | null
  source_filename: string | null; duration: number | null; width: number | null
  height: number | null; fps: number | null; has_audio: number
  video_codec: string | null; audio_codec: string | null; size_bytes: number | null
  rotation: number; status: string; status_message: string | null; settings: string
}

function defaultProjectSettings(): ProjectSettings {
  return { durationPreset: 'medium', maxCandidates: 8 }
}

export function mapProject(row: ProjectRow): Project {
  const settings = { ...defaultProjectSettings(), ...parseJson<Partial<ProjectSettings>>(row.settings, {}) }
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sourceType: row.source_type === 'url' ? 'url' : 'file',
    sourcePath: row.source_path,
    sourceUrl: row.source_url,
    sourceFilename: row.source_filename,
    duration: row.duration,
    width: row.width,
    height: row.height,
    fps: row.fps,
    hasAudio: bool(row.has_audio),
    videoCodec: row.video_codec,
    audioCodec: row.audio_codec,
    sizeBytes: row.size_bytes,
    rotation: row.rotation ?? 0,
    status: row.status as ProjectStatus,
    statusMessage: row.status_message,
    settings: { durationPreset: settings.durationPreset, maxCandidates: settings.maxCandidates }
  }
}

export const projectsRepo = {
  create(db: AppDatabase, id: string, name: string, settings: ProjectSettings): Project {
    const ts = now()
    db.run(
      `INSERT INTO projects (id, name, created_at, updated_at, status, settings)
       VALUES (?, ?, ?, ?, 'created', ?)`,
      [id, name, ts, ts, JSON.stringify(settings)]
    )
    return mapProject(
      db.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', [id]) as ProjectRow
    )
  },

  get(db: AppDatabase, id: string): Project | null {
    const row = db.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', [id])
    return row ? mapProject(row) : null
  },

  list(db: AppDatabase): Project[] {
    return db.all<ProjectRow>('SELECT * FROM projects ORDER BY updated_at DESC').map(mapProject)
  },

  update(db: AppDatabase, id: string, fields: Partial<ProjectRow>): void {
    const keys = Object.keys(fields).filter((k) => fields[k as keyof ProjectRow] !== undefined)
    if (keys.length === 0) return
    const sets = keys.map((k) => `${k} = ?`).join(', ')
    db.run(`UPDATE projects SET ${sets}, updated_at = ? WHERE id = ?`, [
      ...keys.map((k) => fields[k as keyof ProjectRow]),
      now(),
      id
    ])
  },

  setStatus(db: AppDatabase, id: string, status: ProjectStatus, message: string | null = null): void {
    db.run('UPDATE projects SET status = ?, status_message = ?, updated_at = ? WHERE id = ?', [status, message, now(), id])
  },

  delete(db: AppDatabase, id: string): void {
    db.run('DELETE FROM projects WHERE id = ?', [id])
  },

  writeProjectJson(ctx: AppContext, project: Project): void {
    const dir = ctx.projectDir(project.id)
    fs.mkdirSync(dir, { recursive: true })
    const tmp = path.join(dir, 'project.json.tmp')
    fs.writeFileSync(tmp, JSON.stringify(project, null, 2), 'utf-8')
    fs.renameSync(tmp, path.join(dir, 'project.json'))
  }
}

// --------------------------------------------------------------- transcript --

interface SegmentRow {
  id: number; project_id: string; start_time: number; end_time: number
  text: string; speaker: string | null; confidence: number | null; words: string | null
}

function mapSegment(row: SegmentRow): TranscriptSegment {
  const words = parseJson<WordTiming[] | null>(row.words, null)
  return {
    id: row.id,
    startTime: row.start_time,
    endTime: row.end_time,
    text: row.text,
    speaker: row.speaker,
    confidence: row.confidence,
    words: words && words.length ? words : null
  }
}

export const segmentsRepo = {
  listForProject(db: AppDatabase, projectId: string): TranscriptSegment[] {
    return db
      .all<SegmentRow>('SELECT * FROM transcript_segments WHERE project_id = ? ORDER BY start_time', [projectId])
      .map(mapSegment)
  },

  countForProject(db: AppDatabase, projectId: string): number {
    return db.get<{ n: number }>('SELECT COUNT(*) as n FROM transcript_segments WHERE project_id = ?', [projectId])?.n ?? 0
  },

  replaceForProject(
    db: AppDatabase,
    projectId: string,
    segments: Array<{
      startTime: number; endTime: number; text: string
      speaker?: string | null; confidence?: number | null; words?: WordTiming[] | null
    }>
  ): number {
    return db.transaction(() => {
      db.run('DELETE FROM transcript_segments WHERE project_id = ?', [projectId])
      for (const s of segments) {
        db.run(
          `INSERT INTO transcript_segments (project_id, start_time, end_time, text, speaker, confidence, words)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            projectId,
            s.startTime,
            s.endTime,
            s.text,
            s.speaker ?? null,
            s.confidence ?? null,
            s.words && s.words.length ? JSON.stringify(s.words) : null
          ]
        )
      }
      return segments.length
    })
  }
}

// -------------------------------------------------------------- candidates --

interface CandidateRow {
  id: string; project_id: string; start_time: number; end_time: number
  start_segment_id: number; end_segment_id: number; title: string; hook: string
  transcript_excerpt: string; reason: string; clip_type: string; scores: string | null
  overall_score: number | null; score_explanation: string | null; provider: string
  moment_key: string; rank_in_moment: number; status: string; created_at: string; updated_at: string
}

function mapCandidate(row: CandidateRow): ClipCandidate {
  return {
    id: row.id,
    projectId: row.project_id,
    startTime: row.start_time,
    endTime: row.end_time,
    startSegmentId: row.start_segment_id,
    endSegmentId: row.end_segment_id,
    title: row.title,
    hook: row.hook,
    transcriptExcerpt: row.transcript_excerpt,
    reason: row.reason,
    clipType: row.clip_type,
    scores: parseJson<ScoreBreakdown | null>(row.scores, null),
    overallScore: row.overall_score,
    scoreExplanation: row.score_explanation,
    provider: row.provider,
    momentKey: row.moment_key,
    rankInMoment: row.rank_in_moment,
    status: row.status as ClipCandidate['status'],
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export const candidatesRepo = {
  replaceForProject(db: AppDatabase, projectId: string, candidates: Array<Omit<ClipCandidate, 'id' | 'createdAt' | 'updatedAt'>>): ClipCandidate[] {
    const ts = now()
    return db.transaction(() => {
      db.run(`DELETE FROM clip_candidates WHERE project_id = ? AND status = 'discovered'`, [projectId])
      const out: ClipCandidate[] = []
      for (const c of candidates) {
        const id = crypto.randomUUID()
        db.run(
          `INSERT INTO clip_candidates
           (id, project_id, start_time, end_time, start_segment_id, end_segment_id, title, hook,
            transcript_excerpt, reason, clip_type, scores, overall_score, score_explanation, provider,
            moment_key, rank_in_moment, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id, projectId, c.startTime, c.endTime, c.startSegmentId, c.endSegmentId,
            c.title, c.hook, c.transcriptExcerpt, c.reason, c.clipType,
            c.scores ? JSON.stringify(c.scores) : null, c.overallScore, c.scoreExplanation,
            c.provider, c.momentKey, c.rankInMoment, c.status, ts, ts
          ]
        )
        out.push({ ...c, id, createdAt: ts, updatedAt: ts })
      }
      return out
    })
  },

  listForProject(db: AppDatabase, projectId: string): ClipCandidate[] {
    return db
      .all<CandidateRow>(
        `SELECT * FROM clip_candidates WHERE project_id = ?
         ORDER BY rank_in_moment ASC, overall_score DESC`,
        [projectId]
      )
      .map(mapCandidate)
  },

  get(db: AppDatabase, id: string): ClipCandidate | null {
    const row = db.get<CandidateRow>('SELECT * FROM clip_candidates WHERE id = ?', [id])
    return row ? mapCandidate(row) : null
  },

  updateStatus(db: AppDatabase, id: string, status: ClipCandidate['status']): ClipCandidate | null {
    db.run('UPDATE clip_candidates SET status = ?, updated_at = ? WHERE id = ?', [status, now(), id])
    return candidatesRepo.get(db, id)
  },

  countForProject(db: AppDatabase, projectId: string): number {
    return db.get<{ n: number }>('SELECT COUNT(*) as n FROM clip_candidates WHERE project_id = ?', [projectId])?.n ?? 0
  }
}

// ------------------------------------------------------------------- clips --

interface ClipRow {
  id: string; candidate_id: string | null; project_id: string; start_time: number
  end_time: number; aspect_ratio: string; crop_mode: string; crop_x: number
  zoom: number; caption_style_id: string; caption_overrides: string
  caption_text_edits: string; caption_cue_splits: string; caption_cue_merges: string
  caption_timing_offsets: string; silence_cuts: string; title: string; description: string; hashtags: string
  cta: string; metadata_provider: string | null; status: string
  output_resolution: string; output_quality: string; output_fps: string
  created_at: string; updated_at: string
}

function mapClip(row: ClipRow): Clip {
  return {
    id: row.id,
    candidateId: row.candidate_id,
    projectId: row.project_id,
    startTime: row.start_time,
    endTime: row.end_time,
    aspectRatio: row.aspect_ratio as Clip['aspectRatio'],
    cropMode: row.crop_mode as Clip['cropMode'],
    cropX: row.crop_x,
    zoom: row.zoom,
    captionStyleId: row.caption_style_id,
    captionOverrides: parseJson<Clip['captionOverrides']>(row.caption_overrides, {}),
    captionTextEdits: parseJson<Record<string, string>>(row.caption_text_edits, {}),
    captionCueSplits: parseJson<Record<string, number>>(row.caption_cue_splits, {}),
    captionCueMerges: parseJson<Record<string, boolean>>(row.caption_cue_merges, {}),
    captionTimingOffsets: parseJson<Record<string, number>>(row.caption_timing_offsets, {}),
    silenceCuts: parseJson<Clip['silenceCuts']>(row.silence_cuts, []),
    outputResolution: row.output_resolution as Clip['outputResolution'],
    outputQuality: row.output_quality as Clip['outputQuality'],
    outputFps: (row.output_fps === 'source' ? 'source' : Number(row.output_fps)) as Clip['outputFps'],
    title: row.title,
    description: row.description,
    hashtags: parseJson<string[]>(row.hashtags, []),
    cta: row.cta,
    metadataProvider: row.metadata_provider,
    status: row.status as Clip['status'],
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export const clipsRepo = {
  create(db: AppDatabase, clip: Omit<Clip, 'createdAt' | 'updatedAt'>): Clip {
    const ts = now()
    db.run(
      `INSERT INTO clips (id, candidate_id, project_id, start_time, end_time, aspect_ratio, crop_mode,
        crop_x, zoom, caption_style_id, caption_overrides, caption_text_edits, caption_cue_splits,
        caption_cue_merges, caption_timing_offsets, silence_cuts, output_resolution, output_quality,
        output_fps, title, description, hashtags, cta, metadata_provider, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        clip.id, clip.candidateId, clip.projectId, clip.startTime, clip.endTime,
        clip.aspectRatio, clip.cropMode, clip.cropX, clip.zoom, clip.captionStyleId,
        JSON.stringify(clip.captionOverrides), JSON.stringify(clip.captionTextEdits),
        JSON.stringify(clip.captionCueSplits ?? {}), JSON.stringify(clip.captionCueMerges ?? {}),
        JSON.stringify(clip.captionTimingOffsets ?? {}), JSON.stringify(clip.silenceCuts ?? []),
        clip.outputResolution ?? '1080p', clip.outputQuality ?? 'standard',
        String(clip.outputFps ?? 'source'),
        clip.title, clip.description, JSON.stringify(clip.hashtags), clip.cta,
        clip.metadataProvider, clip.status, ts, ts
      ]
    )
    return { ...clip, createdAt: ts, updatedAt: ts }
  },

  get(db: AppDatabase, id: string): Clip | null {
    const row = db.get<ClipRow>('SELECT * FROM clips WHERE id = ?', [id])
    return row ? mapClip(row) : null
  },

  listForProject(db: AppDatabase, projectId: string): Clip[] {
    return db.all<ClipRow>('SELECT * FROM clips WHERE project_id = ? ORDER BY created_at', [projectId]).map(mapClip)
  },

  update(db: AppDatabase, id: string, patch: Record<string, unknown>): Clip | null {
    const columnMap: Record<string, string> = {
      startTime: 'start_time', endTime: 'end_time', aspectRatio: 'aspect_ratio',
      cropMode: 'crop_mode', cropX: 'crop_x', zoom: 'zoom',
      captionStyleId: 'caption_style_id', captionOverrides: 'caption_overrides',
      captionTextEdits: 'caption_text_edits', title: 'title', description: 'description',
      hashtags: 'hashtags', cta: 'cta', metadataProvider: 'metadata_provider', status: 'status',
      captionCueSplits: 'caption_cue_splits', captionCueMerges: 'caption_cue_merges',
      captionTimingOffsets: 'caption_timing_offsets', silenceCuts: 'silence_cuts',
      outputResolution: 'output_resolution', outputQuality: 'output_quality', outputFps: 'output_fps'
    }
    const CLIP_JSON_FIELDS = new Set([
      'hashtags', 'captionOverrides', 'captionTextEdits', 'captionCueSplits',
      'captionCueMerges', 'captionTimingOffsets', 'silenceCuts'
    ])
    const sets: string[] = []
    const values: unknown[] = []
    for (const [field, column] of Object.entries(columnMap)) {
      if (field in patch) {
        let value = patch[field]
        if (CLIP_JSON_FIELDS.has(field)) {
          value = JSON.stringify(value ?? (field === 'hashtags' || field === 'silenceCuts' ? [] : {}))
        }
        if (field === 'outputFps') value = String(value)
        sets.push(`${column} = ?`)
        values.push(value)
      }
    }
    if (sets.length === 0) return clipsRepo.get(db, id)
    db.run(`UPDATE clips SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, [...values, now(), id])
    return clipsRepo.get(db, id)
  },

  delete(db: AppDatabase, id: string): void {
    db.run('DELETE FROM clips WHERE id = ?', [id])
  },

  countForProject(db: AppDatabase, projectId: string): number {
    return db.get<{ n: number }>('SELECT COUNT(*) as n FROM clips WHERE project_id = ?', [projectId])?.n ?? 0
  }
}

// ----------------------------------------------------------------- renders --

interface RenderRow {
  id: string; clip_id: string; project_id: string; output_path: string | null
  status: string; progress: number; stage: string | null; error: string | null
  settings: string; preview: number; started_at: string | null; completed_at: string | null
  created_at: string; updated_at: string
}

function mapRender(row: RenderRow): RenderJob {
  return {
    id: row.id,
    clipId: row.clip_id,
    projectId: row.project_id,
    outputPath: row.output_path,
    status: row.status as RenderStatus,
    progress: row.progress,
    preview: row.preview === 1,
    stage: row.stage,
    error: parseJson<StructuredError | null>(row.error, null),
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export const rendersRepo = {
  create(db: AppDatabase, id: string, clipId: string, projectId: string, settings: unknown, preview = false): RenderJob {
    const ts = now()
    db.run(
      `INSERT INTO renders (id, clip_id, project_id, status, settings, preview, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)`,
      [id, clipId, projectId, JSON.stringify(settings ?? {}), preview ? 1 : 0, ts, ts]
    )
    return mapRender(db.get<RenderRow>('SELECT * FROM renders WHERE id = ?', [id]) as RenderRow)
  },

  get(db: AppDatabase, id: string): RenderJob | null {
    const row = db.get<RenderRow>('SELECT * FROM renders WHERE id = ?', [id])
    return row ? mapRender(row) : null
  },

  list(db: AppDatabase, projectId?: string): RenderJob[] {
    const rows = projectId
      ? db.all<RenderRow>('SELECT * FROM renders WHERE project_id = ? ORDER BY created_at DESC', [projectId])
      : db.all<RenderRow>('SELECT * FROM renders ORDER BY created_at DESC')
    return rows.map(mapRender)
  },

  update(db: AppDatabase, id: string, patch: Partial<{
    status: string; progress: number; stage: string | null; error: unknown
    outputPath: string | null; startedAt: string | null; completedAt: string | null
  }>): void {
    const columnMap: Record<string, string> = {
      status: 'status', progress: 'progress', stage: 'stage', error: 'error',
      outputPath: 'output_path', startedAt: 'started_at', completedAt: 'completed_at'
    }
    const sets: string[] = []
    const values: unknown[] = []
    const record = patch as Record<string, unknown>
    for (const [field, column] of Object.entries(columnMap)) {
      if (field in record) {
        let value = record[field]
        if (field === 'error' && value != null && typeof value !== 'string') value = JSON.stringify(value)
        sets.push(`${column} = ?`)
        values.push(value)
      }
    }
    if (sets.length === 0) return
    db.run(`UPDATE renders SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, [...values, now(), id])
  },

  countForProject(db: AppDatabase, projectId: string): number {
    return db.get<{ n: number }>('SELECT COUNT(*) as n FROM renders WHERE project_id = ?', [projectId])?.n ?? 0
  },

  activeCount(db: AppDatabase): number {
    return (
      db.get<{ n: number }>(`SELECT COUNT(*) as n FROM renders WHERE status IN ('queued','preparing','rendering')`)?.n ?? 0
    )
  },

  findInterrupted(db: AppDatabase): RenderJob[] {
    return db
      .all<RenderRow>(`SELECT * FROM renders WHERE status IN ('queued','preparing','rendering')`)
      .map(mapRender)
  }
}

// ------------------------------------------------------------------- tasks --

interface TaskRow {
  id: string; type: string; project_id: string | null; state: string
  stage: string | null; progress: number | null; message: string | null
  error: string | null; payload: string; result: string | null
  created_at: string; updated_at: string
}

function mapTask(row: TaskRow): TaskInfo {
  return {
    id: row.id,
    type: row.type as TaskType,
    projectId: row.project_id,
    state: row.state as TaskState,
    stage: row.stage,
    progress: row.progress,
    message: row.message,
    error: parseJson<StructuredError | null>(row.error, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export const tasksRepo = {
  create(db: AppDatabase, task: { id: string; type: TaskType; projectId: string | null; payload?: unknown }): TaskInfo {
    const ts = now()
    db.run(
      `INSERT INTO tasks (id, type, project_id, state, payload, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', ?, ?, ?)`,
      [task.id, task.type, task.projectId, JSON.stringify(task.payload ?? {}), ts, ts]
    )
    return mapTask(db.get<TaskRow>('SELECT * FROM tasks WHERE id = ?', [task.id]) as TaskRow)
  },

  get(db: AppDatabase, id: string): TaskInfo | null {
    const row = db.get<TaskRow>('SELECT * FROM tasks WHERE id = ?', [id])
    return row ? mapTask(row) : null
  },

  list(db: AppDatabase, projectId?: string): TaskInfo[] {
    const rows = projectId
      ? db.all<TaskRow>('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC LIMIT 100', [projectId])
      : db.all<TaskRow>('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 200')
    return rows.map(mapTask)
  },

  update(db: AppDatabase, id: string, patch: Record<string, unknown>): void {
    const columnMap: Record<string, string> = {
      state: 'state', stage: 'stage', progress: 'progress', message: 'message',
      error: 'error', result: 'result', project_id: 'project_id'
    }
    const sets: string[] = []
    const values: unknown[] = []
    for (const [field, column] of Object.entries(columnMap)) {
      if (field in patch) {
        let value = patch[field]
        if ((field === 'error' || field === 'result') && value != null && typeof value !== 'string') {
          value = JSON.stringify(value)
        }
        sets.push(`${column} = ?`)
        values.push(value)
      }
    }
    if (sets.length === 0) return
    db.run(`UPDATE tasks SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, [...values, now(), id])
  },

  markInterruptedOnLaunch(db: AppDatabase): TaskInfo[] {
    const interrupted = db
      .all<TaskRow>(`SELECT * FROM tasks WHERE state IN ('queued','running')`)
      .map(mapTask)
    for (const task of interrupted) {
      tasksRepo.update(db, task.id, { state: 'interrupted', message: 'Interrupted by application shutdown' })
    }
    // tasks are re-mapped to pick up the new state
    return interrupted.map((t) => tasksRepo.get(db, t.id) ?? t)
  }
}

// ---------------------------------------------------------------- settings --

export const settingsRepo = {
  defaults(): AppSettings {
    return {
      general: { firstRunCompleted: false },
      ai: {
        activeProvider: 'none',
        openai: { baseUrl: 'https://api.openai.com/v1', model: '', temperature: 0.4, maxTokens: 4096, jsonMode: false, supportsAudio: false, authStyle: 'bearer' },
        anthropic: { baseUrl: 'https://api.anthropic.com', model: '', temperature: 0.4, maxTokens: 4096, jsonMode: false, supportsAudio: false, authStyle: 'bearer' }
      },
      transcription: { providerId: 'import-file', language: 'auto', whisperModel: 'base', whisperCompute: 'int8' },
      video: {
        targetDurationPreset: 'medium',
        renderPreset: 'veryfast',
        crf: 18,
        useHardwareEncoder: false,
        audioNormalize: true,
        defaultResolution: '1080p',
        defaultQuality: 'standard',
        hardwareEncoding: 'auto',
        silence: { mode: 'auto', minSilenceMs: 700, paddingMs: 130, maxCutSec: 8 }
      },
      captions: { defaultStyleId: DEFAULT_CAPTION_STYLE_ID },
      export: { preset: 'generic', includeMetadataFiles: true, filenameTemplate: '{index}_{slug}' },
      advanced: { logLevel: 'info', renderConcurrency: 1, ffmpegPath: '', ffprobePath: '' }
    }
  },

  load(db: AppDatabase): AppSettings {
    const row = db.get<{ value: string }>(`SELECT value FROM app_settings WHERE key = 'app'`)
    const defaults = settingsRepo.defaults()
    if (!row) return defaults
    const stored = parseJson<Partial<AppSettings>>(row.value, {})
    const merged = { ...defaults }
    for (const key of Object.keys(defaults) as Array<keyof AppSettings>) {
      // @ts-expect-error — index merge of section objects
      merged[key] = { ...defaults[key], ...(stored[key] ?? {}) }
    }
    const parsed = appSettingsSchema.safeParse(merged)
    return parsed.success ? parsed.data : defaults
  },

  save(db: AppDatabase, settings: AppSettings): void {
    db.run(
      `INSERT INTO app_settings (key, value) VALUES ('app', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [JSON.stringify(settings)]
    )
  }
}

// ---------------------------------------------------------------- helpers ---

export function projectSummaries(db: AppDatabase, projects: Project[]): import('@shared/types').ProjectSummary[] {
  return projects.map((p) => ({
    id: p.id,
    name: p.name,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    status: p.status,
    statusMessage: p.statusMessage,
    duration: p.duration,
    sourceFilename: p.sourceFilename,
    sourceType: p.sourceType,
    hasAudio: p.hasAudio,
    candidateCount: candidatesRepo.countForProject(db, p.id),
    clipCount: clipsRepo.countForProject(db, p.id),
    renderCount: rendersRepo.countForProject(db, p.id),
    thumbnail: null
  }))
}

export function defaultClipCaptionStyle(settings: AppSettings): string {
  return settings.captions.defaultStyleId || DEFAULT_CAPTION_STYLE_ID
}

export function resolveDurationPreset(preset: string | undefined): ProjectSettings['durationPreset'] {
  const found = DURATION_RANGES.find((r) => r.id === preset)
  return (found?.id as ProjectSettings['durationPreset']) ?? 'medium'
}
