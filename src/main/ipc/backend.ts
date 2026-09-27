import path from 'node:path'
import fs from 'node:fs'
import { AppError } from '@shared/errors'
import type { AppInfo, ProjectSummary, RenderJob } from '@shared/types'
import { ipcPayloads } from '@shared/schemas'
import type { AppContext } from '../services/app-context'
import { clipsRepo } from '../services/database/repositories'
import { TaskManager } from '../services/tasks'
import { RenderQueue } from '../services/rendering/queue'
import {
  createProject, deleteProject, getProject, importMediaFile, importMediaUrl,
  listProjects, projectStorage, relinkSource, renameProject, updateProjectSettings
} from '../services/projects'
import { analyzeSmartCrop } from '../services/media/smartcrop'
import { getTranscript, importTranscript, runTranscription } from '../services/transcription'
import { checkUrlProviders } from '../services/media/url-providers'
import { detectSilence, optionsForMode, projectWithMedia, proxyStatus, renderProxy } from '../services/media/analysis'
import { buildFilmstrip, buildWaveform, projectForVisuals } from '../services/media/frames'
import { optimizeClipBoundaries } from '../services/clips/boundaries'
import { getCandidates, listAnalysisProviders, runAnalysis, updateCandidateStatus } from '../services/ai/analysis'
import { testAiProvider as testAiProviderService } from '../services/ai/test'
import { createClipFromCandidate, deleteClip, generateClipMetadata, listClips, updateClip } from '../services/clips'
import { getSettings, updateSettings } from '../services/settings'
import { buildDiagnostics, checkDependencies, exportDiagnostics } from '../services/diagnostics'
import { runExport } from '../services/exports'

/**
 * Backend assembly + the single method registry. The same dispatcher serves
 * Electron IPC and the browser-preview HTTP transport. Every payload is
 * validated against the zod schemas; every method is allow-listed.
 */

export interface HostServices {
  pickFile(filters: Array<{ name: string; extensions: string[] }>): Promise<string | null>
  revealPath(target: string): Promise<void>
  copyToClipboard(text: string): Promise<void>
  openLogsFolder(): Promise<void>
  isPathInsideWorkspace(target: string): boolean
}

export interface Backend {
  ctx: AppContext
  tasks: TaskManager
  renders: RenderQueue
  host: HostServices | null
  invoke(method: string, payload: unknown): Promise<unknown>
}

const MEDIA_FILTERS = [
  { name: 'Media files', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'mpg', 'mpeg', 'wmv', 'flv', 'mp3', 'm4a', 'wav', 'aac', 'ogg', 'flac'] }
]
const TRANSCRIPT_FILTERS = [{ name: 'Transcripts', extensions: ['srt', 'vtt', 'json', 'txt'] }]

export function createBackend(ctx: AppContext, host: HostServices | null): Backend {
  const tasks = new TaskManager(ctx)
/** Fire-and-forget task dispatch: failures are recorded on the task row; the rethrow is swallowed so a failed background task can never crash the host (B-008). */
function runTask(taskId: string, fn: (report: import('../services/tasks/index').TaskReporter, signal: AbortSignal) => Promise<unknown>): void {
  void tasks.run(taskId, fn).catch(() => undefined)
}
  const renders = new RenderQueue(ctx)

  // ------------------------------------------------------------- runners ---
  tasks.registerRunner('transcribe', (payload, report, signal) =>
    runTranscription(ctx, {
      projectId: String(payload.projectId),
      providerId: payload.providerId === 'openai-compatible' ? 'openai-compatible' : 'faster-whisper-local',
      onEvent: (stage, progress, message) => report(stage, progress, message),
      signal
    })
  )
  tasks.registerRunner('analyze', (payload, report, signal) =>
    runAnalysis(ctx, {
      projectId: String(payload.projectId),
      providerId: payload.providerId as 'heuristic-local' | 'openai-compatible' | 'anthropic',
      onEvent: (stage, progress, message) => report(stage, progress, message),
      signal
    })
  )
  tasks.registerRunner('proxy', async (payload, report, signal) => {
    const project = projectWithMedia(ctx, String(payload.projectId))
    const result = await renderProxy(ctx, project, (pct) => report('transcoding', pct, 'Building preview proxy'), signal)
    return { proxyPath: result.proxyPath }
  })
  tasks.registerRunner('smartcrop', async (payload, report) => {
    const clip = clipsRepo.get(ctx.db, String(payload.clipId))
    if (!clip) throw new AppError('CLIP_NOT_FOUND', 'That clip no longer exists.')
    const project = getProject(ctx, clip.projectId)
    if (!project) throw new AppError('PROJECT_NOT_FOUND', 'That project no longer exists.')
    report('detecting-shots', 0.05, 'Detecting shots and content area')
    const result = await analyzeSmartCrop(ctx, project, clip)
    report('analyzing', 0.9, `Found ${result.shotCount} shot${result.shotCount === 1 ? '' : 's'}`)
    const { updateClip } = await import('../services/clips')
    const updated = updateClip(ctx, clip.id, { smartCropKeyframes: result.keyframes })
    return { keyframes: result.keyframes, shotCount: result.shotCount, barsRemoved: result.barsRemoved, clip: updated }
  })
  tasks.registerRunner('download', async (payload, report) => {
    const projectId = String(payload.projectId)
    if (payload.kind === 'url') {
      report('downloading', null, 'Starting download')
      return importMediaUrl(ctx, projectId, String(payload.url))
    }
    report('copying', null, 'Importing file')
    return importMediaFile(ctx, projectId, String(payload.filePath))
  })

  // ------------------------------------------------------------- handlers ---
  const handlers: Record<string, (payload: never) => unknown> = {
    'app.getInfo': (): AppInfo => ({
      version: ctx.appVersion,
      platform: process.platform,
      isElectron: ctx.isElectron,
      workspaceRoot: ctx.workspaceRoot
    }),
    'app.diagnostics': () => buildDiagnostics(ctx),
    'app.checkDependencies': () => checkDependencies(ctx),

    'projects.list': (): ProjectSummary[] => listProjects(ctx),
    'projects.create': (p: { name: string }) => createProject(ctx, p.name),
    'projects.get': (p: { id: string }) => getProject(ctx, p.id),
    'projects.rename': (p: { id: string; name: string }) => renameProject(ctx, p.id, p.name),
    'projects.delete': (p: { id: string; confirm: boolean }) => deleteProject(ctx, p.id, p.confirm),
    'projects.storage': (p: { id: string }) => projectStorage(ctx, p.id),
    'projects.updateSettings': (p: { id: string; settings: { durationPreset?: 'short' | 'medium' | 'long' | 'mixed'; maxCandidates?: number } }) =>
      updateProjectSettings(ctx, p.id, p.settings),
    'projects.relinkSource': (p: { id: string; filePath: string }) => relinkSource(ctx, p.id, p.filePath),

    'media.importFile': async (p: { projectId: string; filePath?: string }): Promise<{ taskId: string }> => {
      let filePath: string | null | undefined = p.filePath
      if (!filePath) {
        if (!host) throw new AppError('UNSUPPORTED_IN_PREVIEW', 'File picking is unavailable in the browser preview.', 'Use the upload control instead.')
        filePath = await host.pickFile(MEDIA_FILTERS)
        if (!filePath) throw new AppError('CANCELLED', 'No file was selected.')
      }
      const task = tasks.create('download', p.projectId, { kind: 'file', projectId: p.projectId, filePath })
      runTask(task.id, (report) => {
        report('copying', null, 'Importing file')
        return importMediaFile(ctx, p.projectId, filePath as string)
      })
      return { taskId: task.id }
    },
    'media.importUrl': (p: { projectId: string; url: string }): { taskId: string } => {
      // Fail fast: if no provider can handle this URL, throw before creating
      // a task, so the UI can clean up the placeholder project immediately.
      const check = checkUrlProviders(p.url)
      if (!check.ok) {
        throw new AppError('URL_PROVIDER_UNAVAILABLE', check.reason ?? 'This URL cannot be imported.', check.hint ?? undefined)
      }
      const task = tasks.create('download', p.projectId, { kind: 'url', projectId: p.projectId, url: p.url })
      runTask(task.id, async (report) => {
        report('downloading', null, 'Starting download')
        await importMediaUrl(ctx, p.projectId, p.url)
      })
      return { taskId: task.id }
    },
    'media.checkUrl': (p: { url: string }): { ok: boolean; provider: string | null; label: string | null; reason: string | null; hint: string | null } =>
      checkUrlProviders(p.url),

    'media.checkPlayback': (p: { projectId: string }) => proxyStatus(ctx, projectWithMedia(ctx, p.projectId)),
    'media.renderProxy': (p: { projectId: string }): { taskId: string } => {
      const project = projectWithMedia(ctx, p.projectId)
      const status = proxyStatus(ctx, project)
      if (status.verdict === 'native') {
        throw new AppError('PROXY_NOT_NEEDED', 'This file already plays directly — no proxy is required.')
      }
      const task = tasks.create('proxy', p.projectId, { projectId: p.projectId })
      runTask(task.id, async (report, signal) => {
        report('transcoding', 0, 'Building preview proxy')
        const r = await renderProxy(ctx, project, (pct) => report('transcoding', pct, 'Building preview proxy'), signal)
        return { proxyPath: r.proxyPath }
      })
      return { taskId: task.id }
    },

    'media.filmstrip': (p: { projectId: string; count?: number }) =>
      buildFilmstrip(ctx, projectForVisuals(ctx, p.projectId), p.count ?? 24),
    'media.waveform': (p: { projectId: string; buckets?: number }) =>
      buildWaveform(ctx, projectForVisuals(ctx, p.projectId), p.buckets ?? 1200),

    'media.pickSourceFile': async (): Promise<{ filePath: string | null }> => {
      if (!host) throw new AppError('UNSUPPORTED_IN_PREVIEW', 'File picking is unavailable in the browser preview.', 'Use the upload control instead.')
      return { filePath: await host.pickFile(MEDIA_FILTERS) }
    },
    'media.pickTranscriptFile': async (): Promise<{ filePath: string | null }> => {
      if (!host) throw new AppError('UNSUPPORTED_IN_PREVIEW', 'File picking is unavailable in the browser preview.', 'Use the upload control instead.')
      return { filePath: await host.pickFile(TRANSCRIPT_FILTERS) }
    },

    'transcript.get': (p: { projectId: string }) => getTranscript(ctx, p.projectId),
    'transcript.start': (p: { projectId: string; providerId: 'faster-whisper-local' | 'openai-compatible' }): { taskId: string } => {
      const task = tasks.create('transcribe', p.projectId, { projectId: p.projectId, providerId: p.providerId })
      runTask(task.id, (report, signal) =>
        runTranscription(ctx, {
          projectId: p.projectId,
          providerId: p.providerId,
          onEvent: (stage, progress, message) => report(stage, progress, message),
          signal
        })
      )
      return { taskId: task.id }
    },
    'transcript.import': (p: { projectId: string; filePath?: string }): { segments: number } => {
      if (!p.filePath) throw new AppError('FILE_NOT_FOUND', 'No transcript file was provided.')
      return importTranscript(ctx, p.projectId, p.filePath)
    },

    'analysis.providers': () => listAnalysisProviders(ctx),
    'analysis.start': (p: { projectId: string; providerId: 'heuristic-local' | 'openai-compatible' | 'anthropic' }): { taskId: string } => {
      const task = tasks.create('analyze', p.projectId, { projectId: p.projectId, providerId: p.providerId })
      runTask(task.id, (report, signal) =>
        runAnalysis(ctx, {
          projectId: p.projectId,
          providerId: p.providerId,
          onEvent: (stage, progress, message) => report(stage, progress, message),
          signal
        })
      )
      return { taskId: task.id }
    },
    'analysis.getCandidates': (p: { projectId: string }) => getCandidates(ctx, p.projectId),
    'analysis.updateCandidate': (p: { id: string; patch: { status?: 'discovered' | 'approved' | 'rejected' | 'converted' } }) =>
      updateCandidateStatus(ctx, p.id, p.patch.status ?? 'discovered'),

    'analysis.detectSilence': async (p: {
      clipId: string; mode: 'auto' | 'aggressive' | 'custom'
      minSilenceMs?: number; paddingMs?: number; maxCutSec?: number
    }) => {
      const clip = clipsRepo.get(ctx.db, p.clipId)
      if (!clip) throw new AppError('CLIP_NOT_FOUND', 'That clip no longer exists.')
      const project = projectWithMedia(ctx, clip.projectId)
      const opts = optionsForMode(p.mode, {
        minSilenceMs: p.minSilenceMs, paddingMs: p.paddingMs, maxCutSec: p.maxCutSec
      })
      const result = await detectSilence(ctx, project, { from: clip.startTime, to: clip.endTime }, opts)
      const updated = updateClip(ctx, p.clipId, { silenceCuts: result.cuts })
      return { ...result, clip: updated }
    },

    'clips.optimizeBoundaries': (p: { clipId: string }) => optimizeClipBoundaries(ctx, p.clipId),

    'clips.list': (p: { projectId: string }) => listClips(ctx, p.projectId),
    'clips.createFromCandidate': (p: { candidateId: string }) => createClipFromCandidate(ctx, p.candidateId),
    'clips.update': (p: { id: string; patch: Record<string, unknown> }) => updateClip(ctx, p.id, p.patch),
    'clips.delete': (p: { id: string }) => deleteClip(ctx, p.id),
    'clips.generateMetadata': (p: { id: string }) => generateClipMetadata(ctx, p.id),
    'clips.analyzeSmartCrop': (p: { clipId: string }): { taskId: string } => {
      const clip = clipsRepo.get(ctx.db, p.clipId)
      if (!clip) throw new AppError('CLIP_NOT_FOUND', 'That clip no longer exists.')
      const task = tasks.create('smartcrop', clip.projectId, { clipId: p.clipId, projectId: clip.projectId })
      runTask(task.id, async (report, signal) => {
        report('detecting-shots', 0.02, 'Detecting shots and content area')
        const project = projectWithMedia(ctx, clip.projectId)
        const result = await analyzeSmartCrop(ctx, project, clip)
        report('analyzing', 0.92, `Found ${result.shotCount} shot${result.shotCount === 1 ? '' : 's'}`)
        if (signal.aborted) throw new AppError('TASK_CANCELLED', 'Smart crop analysis was cancelled.')
        const updated = updateClip(ctx, p.clipId, { smartCropKeyframes: result.keyframes })
        return { keyframes: result.keyframes, shotCount: result.shotCount, barsRemoved: result.barsRemoved, clip: updated }
      })
      return { taskId: task.id }
    },

    'renders.queue': async (p: { clipId: string; preview?: boolean }): Promise<{ renderId: string }> =>
      ({ renderId: await renders.queueRender(p.clipId, p.preview ?? false) }),
    'renders.list': (p: { projectId?: string }): RenderJob[] => renders.list(p.projectId),
    'renders.cancel': async (p: { id: string }) => {
      await renders.cancel(p.id)
    },
    'renders.retry': (p: { id: string }) => renders.retry(p.id),

    'tasks.list': (p: { projectId?: string }) => tasks.list(p.projectId),
    'tasks.cancel': (p: { id: string }) => ({ cancelled: tasks.cancel(p.id) }),
    'tasks.resume': async (p: { id: string }) => {
      const all = tasks.list()
      const task = all.find((t) => t.id === p.id)
      if (!task) throw new AppError('TASK_NOT_FOUND', 'That task no longer exists.')
      if (task.type === 'render') {
        await renders.retry(p.id)
        return
      }
      await tasks.resume(p.id)
    },
    'tasks.discard': (p: { id: string }) => tasks.discard(p.id),

    'settings.get': () => getSettings(ctx),
    'settings.update': (p: { patch: Record<string, unknown> }) => updateSettings(ctx, p.patch),
    'settings.setSecret': (p: { key: string; value: string }) => ctx.secrets.set(p.key, p.value),
    'settings.deleteSecret': (p: { key: string }) => ctx.secrets.delete(p.key),
    'settings.secretHints': () => ctx.secrets.hints(),
    'settings.testAiProvider': (p: { providerId: 'openai-compatible' | 'anthropic'; baseUrl?: string; model?: string }) =>
      testAiProviderService(ctx, p),

    'exports.run': (p: { clipIds: string[]; includeMetadata?: boolean }) => runExport(ctx, p.clipIds, p.includeMetadata ?? true),

    'system.revealPath': async (p: { path: string }): Promise<void> => {
      if (!host) return
      if (!host.isPathInsideWorkspace(p.path)) {
        throw new AppError('PATH_OUTSIDE_WORKSPACE', 'Only files inside the application workspace can be revealed.')
      }
      await host.revealPath(p.path)
    },
    'system.copyToClipboard': async (p: { text: string }): Promise<void> => {
      if (!host) throw new AppError('UNSUPPORTED_IN_PREVIEW', 'Clipboard is handled by the browser in preview mode.')
      await host.copyToClipboard(p.text)
    },
    'system.openLogsFolder': async (): Promise<void> => {
      if (!host) throw new AppError('UNSUPPORTED_IN_PREVIEW', 'Opening folders is unavailable in the browser preview.')
      await host.openLogsFolder()
    },
    'system.exportDiagnostics': async () => exportDiagnostics(ctx, await buildDiagnostics(ctx)),
    'system.fontUrl': (p: { file: string }): { path: string } => {
      const fontPath = path.join(ctx.paths.fontsDir, path.basename(p.file))
      if (!fs.existsSync(fontPath)) throw new AppError('FONT_NOT_FOUND', `Font file ${p.file} is missing.`)
      return { path: fontPath }
    }
  }

  // ------------------------------------------------------------ dispatcher --

  async function invoke(method: string, payload: unknown): Promise<unknown> {
    const handler = handlers[method]
    if (!handler) throw new AppError('UNKNOWN_METHOD', `Unknown API method "${method}".`)
    const schema = (ipcPayloads as Record<string, unknown>)[method]
    let validatedPayload: unknown = payload ?? {}
    if (schema) {
      const parsed = (
        schema as { safeParse: (input: unknown) => { success: boolean; data?: unknown; error?: { message: string } } }
      ).safeParse(payload ?? {})
      if (!parsed.success) {
        throw new AppError(
          'VALIDATION_FAILED',
          `The request to "${method}" contained invalid data.`,
          'This is an application bug — the UI sent something the backend refused.',
          parsed.error?.message
        )
      }
      validatedPayload = parsed.data ?? {}
    }
    return handler(validatedPayload as never)
  }

  // Startup recovery: mark interrupted work for the recovery UI (spec §88)
  const interruptedTasks = tasks.startupRecovery().length
  const interruptedRenders = renders.startupRecovery()
  if (interruptedTasks + interruptedRenders > 0) {
    ctx.logger.info('recovery', 'startup', `interrupted tasks=${interruptedTasks} renders=${interruptedRenders}`)
  }

  return { ctx, tasks, renders, host, invoke }
}
