import type { AppEvent, StructuredError } from '@shared/types'
import type { ApiEnvelope, ClipwrightApi } from '@shared/ipc'

/**
 * Transport-agnostic API client.
 *
 * - Inside Electron: the preload bridge (window.clipwright) over IPC.
 * - In the browser preview: POST /api/invoke + SSE /api/events, served by
 *   server/preview.ts which calls the exact same backend services.
 *
 * Both transports return the same envelope and are validated in the backend,
 * so the UI code below never needs to care which one is active.
 */

export const isElectron = typeof window !== 'undefined' && Boolean(window.clipwright)
export const isPreview = !isElectron

export class ApiCallError extends Error {
  readonly structured: StructuredError
  constructor(err: StructuredError) {
    super(err.message)
    this.name = 'ApiCallError'
    this.structured = err
  }
  get code(): string {
    return this.structured.code
  }
  get hint(): string | undefined {
    return this.structured.hint
  }
  get details(): string | undefined {
    return this.structured.details
  }
}

async function invoke<T>(method: string, payload: unknown = {}): Promise<T> {
  let envelope: ApiEnvelope<T>
  if (isElectron) {
    envelope = (await window.clipwright!.invoke(method, payload)) as ApiEnvelope<T>
  } else {
    const res = await fetch('/api/invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, payload })
    })
    if (!res.ok && res.status !== 400) {
      throw new ApiCallError({
        code: 'NETWORK',
        message: `The backend preview server is unreachable (HTTP ${res.status}).`,
        hint: 'Restart the preview server and reload.'
      })
    }
    envelope = (await res.json()) as ApiEnvelope<T>
  }
  if (!envelope.ok) throw new ApiCallError(envelope.error)
  return envelope.value
}

/** Build the URL for a media file the backend is allowed to stream. */
export function mediaUrl(absolutePath: string | null | undefined): string {
  if (!absolutePath) return ''
  if (isElectron) {
    return `clipwright-media://local/${encodeURIComponent(absolutePath)}`
  }
  return `/api/media/stream?path=${encodeURIComponent(absolutePath)}`
}

/** Clipboard with graceful fallback (works in both transports). */
export async function copyText(text: string): Promise<boolean> {
  if (isElectron) {
    try {
      await invoke('system.copyToClipboard', { text })
      return true
    } catch {
      return false
    }
  }
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** Subscribe to backend events (IPC push in Electron, SSE in preview). */
export function subscribeEvents(callback: (event: AppEvent) => void): () => void {
  if (isElectron) {
    return window.clipwright!.onEvent((event) => callback(event as AppEvent))
  }
  const source = new EventSource('/api/events')
  source.onmessage = (message) => {
    try {
      callback(JSON.parse(message.data) as AppEvent)
    } catch {
      /* ignore malformed frames */
    }
  }
  return () => source.close()
}

export function errMessage(err: unknown): { message: string; hint?: string; code?: string } {
  if (err instanceof ApiCallError) {
    return { message: err.message, hint: err.hint, code: err.code }
  }
  if (err instanceof Error) return { message: err.message }
  return { message: String(err) }
}

// ---------------------------------------------------------------------------

function wire(): ClipwrightApi {
  const f = (method: string) => (payload?: unknown) => invoke(method, payload)
  const api = {
    'app.getInfo': f('app.getInfo'),
    'app.diagnostics': f('app.diagnostics'),
    'app.checkDependencies': f('app.checkDependencies'),
    'system.revealPath': f('system.revealPath'),
    'system.copyToClipboard': f('system.copyToClipboard'),
    'system.openLogsFolder': f('system.openLogsFolder'),
    'system.exportDiagnostics': f('system.exportDiagnostics'),
    'system.fontUrl': f('system.fontUrl'),
    'projects.list': f('projects.list'),
    'projects.create': f('projects.create'),
    'projects.get': f('projects.get'),
    'projects.rename': f('projects.rename'),
    'projects.delete': f('projects.delete'),
    'projects.storage': f('projects.storage'),
    'projects.updateSettings': f('projects.updateSettings'),
    'media.importFile': f('media.importFile'),
    'media.importUrl': f('media.importUrl'),
    'media.pickSourceFile': f('media.pickSourceFile'),
    'media.pickTranscriptFile': f('media.pickTranscriptFile'),
    'transcript.get': f('transcript.get'),
    'transcript.start': f('transcript.start'),
    'transcript.import': f('transcript.import'),
    'analysis.providers': f('analysis.providers'),
    'analysis.start': f('analysis.start'),
    'analysis.getCandidates': f('analysis.getCandidates'),
    'analysis.updateCandidate': f('analysis.updateCandidate'),
    'clips.list': f('clips.list'),
    'clips.createFromCandidate': f('clips.createFromCandidate'),
    'clips.update': f('clips.update'),
    'clips.delete': f('clips.delete'),
    'clips.generateMetadata': f('clips.generateMetadata'),
    'renders.queue': f('renders.queue'),
    'renders.list': f('renders.list'),
    'renders.cancel': f('renders.cancel'),
    'renders.retry': f('renders.retry'),
    'tasks.list': f('tasks.list'),
    'tasks.cancel': f('tasks.cancel'),
    'tasks.resume': f('tasks.resume'),
    'tasks.discard': f('tasks.discard'),
    'settings.get': f('settings.get'),
    'settings.update': f('settings.update'),
    'settings.setSecret': f('settings.setSecret'),
    'settings.deleteSecret': f('settings.deleteSecret'),
    'settings.secretHints': f('settings.secretHints'),
    'settings.testAiProvider': f('settings.testAiProvider'),
    'exports.run': f('exports.run')
  } as Record<string, (payload?: unknown) => Promise<unknown>>
  return api as unknown as ClipwrightApi
}

export const api = wire()
