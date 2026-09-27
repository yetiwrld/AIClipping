import fs from 'node:fs'
import path from 'node:path'
import type { DependencyStatus, DiagnosticsReport, ProviderAvailability } from '@shared/types'
import type { AppContext } from '../app-context'
import { resolveFfmpeg, resolveFfprobe } from '../media/ffmpeg'
import { detectLocalWhisper } from '../transcription'
import { listAnalysisProviders } from '../ai/analysis'
import { getSettings } from '../settings'
import { schemaVersion } from '../database/migrations'
import { workspaceStorage } from '../projects'

/**
 * Dependency probing + diagnostics export. The UI shows this board on the
 * first run and in Settings — users should never have to guess why
 * something doesn't work (spec §54).
 */

export async function checkDependencies(ctx: AppContext): Promise<DependencyStatus[]> {
  const settings = getSettings(ctx)
  const out: DependencyStatus[] = []

  const ffmpeg = await resolveFfmpeg(settings.advanced.ffmpegPath)
  out.push({
    id: 'ffmpeg',
    label: 'FFmpeg',
    kind: 'tool',
    available: Boolean(ffmpeg),
    configured: Boolean(ffmpeg),
    version: ffmpeg?.version ?? undefined,
    message: ffmpeg
      ? `Found (${ffmpeg.source === 'bundled' ? 'bundled with the app' : ffmpeg.source === 'path' ? 'system PATH' : 'custom path'}).`
      : 'Not found — rendering and media analysis are unavailable.',
    fixHint: 'Settings → Advanced → FFmpeg path'
  })

  const ffprobe = await resolveFfprobe(settings.advanced.ffprobePath)
  out.push({
    id: 'ffprobe',
    label: 'FFprobe',
    kind: 'tool',
    available: Boolean(ffprobe),
    configured: Boolean(ffprobe),
    version: ffprobe?.version ?? undefined,
    message: ffprobe ? `Found (${ffprobe.source}).` : 'Not found — media inspection is unavailable.',
    fixHint: 'Settings → Advanced → FFprobe path'
  })

  const local = await detectLocalWhisper()
  out.push({
    id: 'faster-whisper',
    label: 'Local Whisper (faster-whisper)',
    kind: 'system',
    available: local.installed,
    configured: local.installed,
    message: local.installed
      ? 'Available — fully offline transcription on this machine.'
      : `${local.message} Cloud transcription and transcript import remain available.`,
    fixHint: 'Install with: pip install faster-whisper'
  })

  const providers = await listAnalysisProviders(ctx)
  for (const p of providers) {
    out.push({
      id: p.id,
      label: p.label,
      kind: 'system',
      available: p.available,
      configured: p.configured,
      message: p.message,
      fixHint: p.fixHint
    })
  }

  const storage = workspaceStorage(ctx)
  out.push({
    id: 'disk',
    label: 'Free disk space',
    kind: 'system',
    available: storage.free > 1_000_000_000,
    configured: true,
    message: storage.free > 0 ? `${(storage.free / 1e9).toFixed(1)} GB free on the workspace drive.` : 'Free space could not be determined.',
  })

  return out
}

export async function buildDiagnostics(ctx: AppContext): Promise<DiagnosticsReport> {
  const settings = getSettings(ctx)
  const deps = await checkDependencies(ctx)
  const ffmpeg = deps.find((d) => d.id === 'ffmpeg')
  const ffprobe = deps.find((d) => d.id === 'ffprobe')

  const providers: ProviderAvailability[] = deps.map((d) => ({
    id: d.id,
    label: d.label,
    kind: d.kind === 'tool' ? 'tool' : 'system',
    available: d.available,
    configured: d.configured,
    message: d.message,
    fixHint: d.fixHint
  }))

  const storage = workspaceStorage(ctx)

  return {
    appVersion: ctx.appVersion,
    platform: `${process.platform} ${process.arch}`,
    electron: ctx.isElectron ? process.versions.electron ?? null : null,
    node: process.version,
    workspaceRoot: ctx.workspaceRoot,
    schemaVersion: schemaVersion(ctx.db),
    ffmpeg: ffmpeg?.available
      ? { path: '', source: '', version: ffmpeg.version ?? null }
      : null,
    ffprobe: ffprobe?.available ? { path: '', source: '', version: ffprobe.version ?? null } : null,
    providers,
    disk: storage.free > 0 ? { freeBytes: storage.free, totalBytes: storage.free } : null,
    recentErrors: ctx.logger.recentErrors(20).map((e) => ({ time: e.time, code: e.level, message: `${e.subsystem}/${e.operation}: ${e.message}` })),
    settingsSummary: {
      activeAnalysisProvider: settings.ai.activeProvider,
      transcriptionProvider: settings.transcription.providerId,
      whisperModel: settings.transcription.whisperModel,
      durationPreset: settings.video.targetDurationPreset,
      renderPreset: settings.video.renderPreset,
      crf: settings.video.crf,
      hardwareEncoder: settings.video.useHardwareEncoder,
      renderConcurrency: settings.advanced.renderConcurrency,
      logLevel: settings.advanced.logLevel,
      captionDefault: settings.captions.defaultStyleId,
      exportPreset: settings.export.preset,
      openaiBaseUrl: settings.ai.openai.baseUrl,
      openaiModel: settings.ai.openai.model,
      anthropicModel: settings.ai.anthropic.model
      // NOTE: no API keys, ever (SECURITY.md)
    }
  }
}

export function exportDiagnostics(ctx: AppContext, report: DiagnosticsReport): { path: string } {
  const dir = path.join(ctx.workspaceRoot, 'logs')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf-8')
  ctx.logger.info('diagnostics', 'export', `file=${file}`)
  return { path: file }
}
