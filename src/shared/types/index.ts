/**
 * Core domain types shared by the main process, the renderer and tests.
 * Runtime validation of all external data (IPC, AI output, files) happens
 * through the zod schemas in `src/shared/schemas`.
 */

// ---------------------------------------------------------------- projects ---

export type ProjectStatus =
  | 'created'
  | 'importing'
  | 'import_failed'
  | 'ready'
  | 'transcribing'
  | 'transcription_failed'
  | 'transcribed'
  | 'analyzing'
  | 'analysis_failed'
  | 'analyzed'

export interface ProjectSettings {
  /** Duration window preset used by discovery */
  durationPreset: DurationPresetId
  /** Max candidates to discover */
  maxCandidates: number
}

export interface Project {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  sourceType: 'file' | 'url'
  sourcePath: string | null
  sourceUrl: string | null
  sourceFilename: string | null
  duration: number | null
  width: number | null
  height: number | null
  fps: number | null
  hasAudio: boolean
  videoCodec: string | null
  audioCodec: string | null
  sizeBytes: number | null
  rotation: number
  status: ProjectStatus
  statusMessage: string | null
  settings: ProjectSettings
}

export interface ProjectSummary {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  status: ProjectStatus
  statusMessage: string | null
  duration: number | null
  sourceFilename: string | null
  sourceType: 'file' | 'url'
  hasAudio: boolean
  candidateCount: number
  clipCount: number
  renderCount: number
  thumbnail: string | null
}

export interface ProjectStorage {
  source: number
  renders: number
  thumbnails: number
  cache: number
  total: number
}

// ------------------------------------------------------------- transcript ---

export interface WordTiming {
  word: string
  start: number
  end: number
}

export interface TranscriptSegment {
  id: number
  startTime: number
  endTime: number
  text: string
  speaker: string | null
  confidence: number | null
  words: WordTiming[] | null
}

export interface TranscriptResult {
  language: string | null
  segments: Array<{
    start: number
    end: number
    text: string
    speaker?: string | null
    confidence?: number | null
    words?: WordTiming[] | null
  }>
}

// -------------------------------------------------------------- analysis ---

export interface ScoreBreakdown {
  hook: number
  contextCompleteness: number
  clarity: number
  retention: number
  emotionalImpact: number
  standaloneValue: number
  shareability: number
  visualSuitability: number
}

export type CandidateStatus = 'discovered' | 'approved' | 'rejected' | 'converted'

export interface ClipCandidate {
  id: string
  projectId: string
  startTime: number
  endTime: number
  startSegmentId: number
  endSegmentId: number
  title: string
  hook: string
  transcriptExcerpt: string
  reason: string
  clipType: string
  scores: ScoreBreakdown | null
  overallScore: number | null
  scoreExplanation: string | null
  /** Which provider produced this candidate, e.g. `heuristic-local` */
  provider: string
  momentKey: string
  rankInMoment: number
  status: CandidateStatus
  createdAt: string
  updatedAt: string
}

export interface AnalysisSummary {
  foundMoments: number
  keptCandidates: number
  variationsGrouped: number
  rejected: number
  provider: string
}

// ----------------------------------------------------------------- clips ---

export type CropMode = 'center' | 'top' | 'bottom' | 'manual'
export type AspectRatioId = '9:16' | '1:1' | '4:5' | '16:9'

export type OutputResolutionId = '720p' | '1080p' | '1440p' | '2160p'
export type OutputQualityId = 'draft' | 'standard' | 'high' | 'maximum'
export type OutputFps = 'source' | 24 | 25 | 30 | 50 | 60

export interface CaptionOverrides {
  fontSizePct?: number
  positionY?: number
  emphasis?: boolean
  uppercase?: boolean
  maxWordsPerCue?: number
  /** Optional color customizations — applied on top of the template. */
  textColor?: string
  highlightColor?: string
  /** 0..1; overrides the template's box opacity (0 disables the box). */
  boxOpacity?: number
  outlineWidth?: number
  shadow?: number
}

export interface Clip {
  id: string
  candidateId: string | null
  projectId: string
  startTime: number
  endTime: number
  aspectRatio: AspectRatioId
  cropMode: CropMode
  cropX: number
  zoom: number
  captionStyleId: string
  captionOverrides: CaptionOverrides
  captionTextEdits: Record<string, string>
  /** Split cue (by key) after N words. */
  captionCueSplits: Record<string, number>
  /** Merge cue (by key) with the following cue. */
  captionCueMerges: Record<string, boolean>
  /** Per-cue timing shift in seconds (±5s max). */
  captionTimingOffsets: Record<string, number>
  /** Removed silence intervals in SOURCE time — never modified in place. */
  silenceCuts: Array<{ start: number; end: number }>
  /** Output resolution tier (short side). */
  outputResolution: OutputResolutionId
  /** Encoder quality tier. */
  outputQuality: OutputQualityId
  /** Output frame rate; 'source' preserves the input fps. */
  outputFps: OutputFps
  title: string
  description: string
  hashtags: string[]
  cta: string
  metadataProvider: string | null
  status: 'draft' | 'rendered'
  createdAt: string
  updatedAt: string
}

// --------------------------------------------------------------- renders ---

export type RenderStatus = 'queued' | 'preparing' | 'rendering' | 'completed' | 'failed' | 'cancelled'

export interface StructuredError {
  code: string
  message: string
  hint?: string
  details?: string
}

export interface RenderJob {
  id: string
  clipId: string
  projectId: string
  outputPath: string | null
  status: RenderStatus
  progress: number
  /** True for fast low-quality preview renders (draft/720p). */
  preview: boolean
  stage: string | null
  error: StructuredError | null
  startedAt: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
}

// ---------------------------------------------------------------- tasks ----

export type TaskType = 'download' | 'transcribe' | 'analyze' | 'render' | 'thumbnail' | 'proxy'
export type TaskState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

export interface TaskInfo {
  id: string
  type: TaskType
  projectId: string | null
  state: TaskState
  stage: string | null
  progress: number | null
  message: string | null
  error: StructuredError | null
  createdAt: string
  updatedAt: string
}

// -------------------------------------------------------------- settings ---

export type DurationPresetId = 'short' | 'medium' | 'long' | 'mixed'
export type PlatformPresetId = 'tiktok' | 'reels' | 'shorts' | 'generic'

export type AiAuthStyle = 'bearer' | 'x-api-key' | 'both'

export interface AiProviderRuntimeConfig {
  baseUrl: string
  model: string
  temperature: number
  maxTokens: number
  /** Ask the endpoint for JSON response_format (some proxies reject it) */
  jsonMode: boolean
  /** Endpoint also accepts audio transcription uploads */
  supportsAudio: boolean
  /**
   * How the API key is sent. `bearer` (Authorization: Bearer …) is the
   * OpenAI-compatible default and works with OpenAI, OpenRouter, Groq,
   * Together and GonkaRouter. Gateways that require the `x-api-key` header
   * instead can select it without affecting other providers.
   */
  authStyle?: AiAuthStyle
}

export type AnalysisProviderId = 'heuristic-local' | 'openai-compatible' | 'anthropic' | 'none'

export interface AiSettings {
  activeProvider: AnalysisProviderId
  openai: AiProviderRuntimeConfig
  anthropic: AiProviderRuntimeConfig
}

export interface TranscriptionSettings {
  providerId: 'import-file' | 'faster-whisper-local' | 'openai-compatible'
  language: string
  whisperModel: 'tiny' | 'base' | 'small' | 'medium'
  whisperCompute: 'auto' | 'int8' | 'float16'
}

export interface GeneralSettings {
  firstRunCompleted: boolean
}

export interface VideoSettings {
  targetDurationPreset: DurationPresetId
  renderPreset: 'ultrafast' | 'veryfast' | 'medium' | 'slow'
  crf: number
  useHardwareEncoder: boolean
  audioNormalize: boolean
  defaultResolution: OutputResolutionId
  defaultQuality: OutputQualityId
  hardwareEncoding: 'auto' | 'cpu' | 'hardware'
  silence: {
    mode: 'off' | 'auto' | 'aggressive' | 'custom'
    minSilenceMs: number
    paddingMs: number
    maxCutSec: number
  }
}

export interface CaptionDefaultsSettings {
  defaultStyleId: string
}

export interface ExportSettings {
  preset: PlatformPresetId
  includeMetadataFiles: boolean
  filenameTemplate: string
}

export interface AdvancedSettings {
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  renderConcurrency: number
  ffmpegPath: string
  ffprobePath: string
}

export interface AppSettings {
  general: GeneralSettings
  ai: AiSettings
  transcription: TranscriptionSettings
  video: VideoSettings
  captions: CaptionDefaultsSettings
  export: ExportSettings
  advanced: AdvancedSettings
}

// ------------------------------------------------------------ providers ----

export interface ProviderAvailability {
  id: string
  label: string
  kind: 'transcription' | 'analysis' | 'tool' | 'system'
  available: boolean
  configured: boolean
  message: string
  /** Where the user can fix it */
  fixHint?: string
}

export interface DependencyStatus extends ProviderAvailability {
  kind: 'tool' | 'system'
  version?: string
}

// --------------------------------------------------------------- events ----

export type AppEvent =
  | { type: 'task:update'; task: TaskInfo }
  | { type: 'render:progress'; renderId: string; clipId: string; projectId: string; progress: number; stage: string }
  | { type: 'render:state'; render: RenderJob }
  | { type: 'project:update'; project: Project }

// ------------------------------------------------------------- diagnostics -

export interface DiagnosticsReport {
  appVersion: string
  platform: string
  electron: string | null
  node: string
  workspaceRoot: string
  schemaVersion: number
  ffmpeg: { path: string; source: string; version: string | null } | null
  ffprobe: { path: string; source: string; version: string | null } | null
  providers: ProviderAvailability[]
  disk: { freeBytes: number; totalBytes: number } | null
  recentErrors: Array<{ time: string; code: string; message: string }>
  settingsSummary: Record<string, unknown>
}

export interface AppInfo {
  version: string
  platform: string
  isElectron: boolean
  workspaceRoot: string
}

export interface ExportResult {
  dir: string
  files: string[]
}
