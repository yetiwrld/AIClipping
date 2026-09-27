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

  // media
  'media.importFile'(p: { projectId: string; filePath?: string }): Promise<Project>
  'media.importUrl'(p: { projectId: string; url: string }): Promise<Project>
  'media.pickSourceFile'(): { filePath: string | null }
  'media.pickTranscriptFile'(): { filePath: string | null }

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

  // clips
  'clips.list'(p: { projectId: string }): Promise<Clip[]>
  'clips.createFromCandidate'(p: { candidateId: string }): Promise<Clip>
  'clips.update'(p: { id: string; patch: Partial<Omit<Clip, 'id' | 'projectId' | 'candidateId' | 'status' | 'createdAt' | 'updatedAt'>> }): Promise<Clip>
  'clips.delete'(p: { id: string }): Promise<void>
  'clips.generateMetadata'(p: { id: string }): Promise<Clip>

  // renders
  'renders.queue'(p: { clipId: string }): { renderId: string }
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
  }): Promise<{ ok: boolean; message: string }>

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
