import type { AppSettings, AppInfo, AnalysisSummary, Clip, ClipCandidate, DependencyStatus,
  DiagnosticsReport, ExportResult, Project, ProjectStorage, ProjectSummary, RenderJob,
  StructuredError, TaskInfo, TranscriptSegment } from './types'

/**
 * The typed API surface exposed to the renderer. Transports:
 *  - Electron: preload bridge → ipcRenderer.invoke('api:invoke', {method, payload})
 *  - Browser preview: POST /api/invoke  (+ SSE /api/events)
 * The main process validates every payload with the zod schemas in ./schemas.
 */
export interface ClipwrightApi {
  // app / system
  'app.getInfo'(): Promise<AppInfo>
  'app.diagnostics'(): Promise<DiagnosticsReport>
  'app.checkDependencies'(): Promise<DependencyStatus[]>
  'system.revealPath'(p: { path: string }): Promise<void>
  'system.copyToClipboard'(p: { text: string }): Promise<void>
  'system.openLogsFolder'(): Promise<void>
  'system.exportDiagnostics'(): { path: string }
  'system.fontUrl'(p: { file: string }): { path: string }

  // projects
  'projects.list'(): Promise<ProjectSummary[]>
  'projects.create'(p: { name: string }): Promise<Project>
  'projects.get'(p: { id: string }): Promise<Project | null>
  'projects.rename'(p: { id: string; name: string }): Promise<Project>
  'projects.delete'(p: { id: string; confirm: boolean }): Promise<void>
  'projects.storage'(p: { id: string }): Promise<ProjectStorage>
  'projects.updateSettings'(p: {
    id: string
    settings: { durationPreset?: 'short' | 'medium' | 'long' | 'mixed'; maxCandidates?: number }
  }): Promise<Project>
  /**
   * Relink a project to its moved source file (§13-14). The new file is
   * inspected and re-registered; a mismatched file is rejected, never
   * silently substituted.
   */
  'projects.relinkSource'(p: { id: string; filePath: string }): Promise<Project>

  // media
  'media.importFile'(p: { projectId: string; filePath?: string }): Promise<Project>
  'media.importUrl'(p: { projectId: string; url: string }): Promise<Project>
  /** Pre-flight URL check: which provider would handle this URL, and why not. No side effects. */
  'media.checkUrl'(p: { url: string }): Promise<{
    ok: boolean
    provider: string | null
    label: string | null
    reason: string | null
    hint: string | null
  }>

  'media.pickSourceFile'(): { filePath: string | null }
  'media.pickTranscriptFile'(): { filePath: string | null }

  /** Playback compatibility check + existing proxy status for the project source. */
  'media.checkPlayback'(p: { projectId: string }): Promise<{
    verdict: 'native' | 'proxy' | 'audio-only' | 'missing'
    reason: string
    proxyExists: boolean
    proxyPath: string | null
    sourceExists: boolean
    sourcePath: string | null
  }>
  /** Queue a preview-proxy transcode (task). */
  'media.renderProxy'(p: { projectId: string }): { taskId: string }

  /** Filmstrip thumbnails for the timeline (generated + cached via FFmpeg). */
  'media.filmstrip'(p: { projectId: string; count?: number }): Promise<{
    frames: Array<{ t: number; path: string }>
    cached: boolean
  }>
  /** Audio waveform peaks for the timeline (generated + cached via FFmpeg). */
  'media.waveform'(p: { projectId: string; buckets?: number }): Promise<{
    duration: number
    peaks: number[]
    silent: boolean
  }>

  // transcript
  'transcript.get'(p: { projectId: string }): Promise<TranscriptSegment[]>
  'transcript.start'(p: { projectId: string; providerId: 'faster-whisper-local' | 'openai-compatible' }): { taskId: string }
  'transcript.import'(p: { projectId: string; filePath?: string }): { segments: number }

  // analysis
  'analysis.providers'(): import('./types').ProviderAvailability[]
  'analysis.start'(p: {
    projectId: string
    providerId: 'heuristic-local' | 'openai-compatible' | 'anthropic'
  }): { taskId: string }
  'analysis.getCandidates'(p: { projectId: string }): Promise<ClipCandidate[]>
  'analysis.updateCandidate'(p: {
    id: string
    patch: { status?: 'discovered' | 'approved' | 'rejected' | 'converted' }
  }): Promise<ClipCandidate>

  /** Run FFmpeg silence detection over the clip window and store the cuts. */
  'analysis.detectSilence'(p: {
    clipId: string
    mode: 'auto' | 'aggressive' | 'custom'
    minSilenceMs?: number
    paddingMs?: number
    maxCutSec?: number
  }): Promise<{
    cuts: Array<{ start: number; end: number }>
    detected: Array<{ start: number; end: number }>
    savedSec: number
    clip: Clip
  }>

  /** Snap clip edges to sentence boundaries + add lead-in context. */
  'clips.optimizeBoundaries'(p: { clipId: string }): Promise<{
    clip: Clip
    adjusted: boolean
    startReason: string
    endReason: string
    leadIn: { applied: boolean; reason: string }
    quality: {
      before: { score: number; startReason: string; endReason: string }
      after: { score: number; startReason: string; endReason: string }
    }
  }>

  // clips
  'clips.list'(p: { projectId: string }): Promise<Clip[]>
  'clips.createFromCandidate'(p: { candidateId: string }): Promise<Clip>
  'clips.update'(p: { id: string; patch: Partial<Omit<Clip, 'id' | 'projectId' | 'candidateId' | 'status' | 'createdAt' | 'updatedAt'>> }): Promise<Clip>
  'clips.delete'(p: { id: string }): Promise<void>
  'clips.generateMetadata'(p: { id: string }): Promise<Clip>
  /**
   * Analyze the clip for smart crop: FFmpeg scene detection + per-shot
   * saliency windows, stored as crop keyframes (task with progress).
   */
  'clips.analyzeSmartCrop'(p: { clipId: string }): { taskId: string }

  // renders
  'renders.queue'(p: { clipId: string; preview?: boolean }): { renderId: string }
  'renders.list'(p: { projectId?: string }): Promise<RenderJob[]>
  'renders.cancel'(p: { id: string }): Promise<void>
  'renders.retry'(p: { id: string }): Promise<RenderJob>

  // tasks
  'tasks.list'(p: { projectId?: string }): Promise<TaskInfo[]>
  'tasks.cancel'(p: { id: string }): { cancelled: boolean }
  'tasks.resume'(p: { id: string }): Promise<void>
  'tasks.discard'(p: { id: string }): Promise<void>

  // settings
  'settings.get'(): Promise<AppSettings>
  'settings.update'(p: { patch: Record<string, unknown> }): Promise<AppSettings>
  'settings.setSecret'(p: { key: string; value: string }): Promise<void>
  'settings.deleteSecret'(p: { key: string }): Promise<void>
  'settings.secretHints'(): Promise<Record<string, string>>
  'settings.testAiProvider'(p: {
    providerId: 'openai-compatible' | 'anthropic'
    baseUrl?: string
    model?: string
  }): Promise<{ ok: boolean; message: string; endpoint: string; model: string; latencyMs: number | null }>

  // export
  'exports.run'(p: { clipIds: string[]; includeMetadata?: boolean }): Promise<ExportResult>
}

export type ApiMethod = keyof ClipwrightApi

/** Envelope for invoke responses over both transports. */
export type ApiEnvelope<T> = { ok: true; value: T } | { ok: false; error: StructuredError }

export interface AnalysisDonePayload {
  projectId: string
  summary: AnalysisSummary
}

declare global {
  interface Window {
    clipwright?: {
      invoke(method: string, payload: unknown): Promise<ApiEnvelope<unknown>>
      onEvent(cb: (event: unknown) => void): () => void
    }
  }
}
