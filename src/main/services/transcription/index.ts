import fs from 'node:fs'
import path from 'node:path'
import { AppError } from '@shared/errors'
import { parseTranscriptFile } from '@shared/transcript/parsers'
import { transcriptResultSchema } from '@shared/schemas'
import type { ProviderAvailability, TranscriptSegment, WordTiming } from '@shared/types'
import type { AppContext } from '../app-context'
import { projectsRepo, segmentsRepo } from '../database/repositories'
import { getBinaries } from '../media/inspect'
import { extractAudio } from '../media/thumbnails'
import { runProcess, whichSync } from '../media/ffmpeg'
import { getSettings } from '../settings'

/**
 * Transcription orchestration. Providers:
 *  - faster-whisper-local (Python subprocess, word timestamps, offline)
 *  - openai-compatible (cloud — sends ONLY the extracted audio track, and
 *    only when the user has configured + selected it)
 *  - import-file (SRT / VTT / JSON / timestamped text — the offline path)
 */

export type TranscriptionProviderId = 'faster-whisper-local' | 'openai-compatible' | 'import-file'

export function pythonCandidates(): string[] {
  return process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python']
}

export async function detectLocalWhisper(): Promise<{ python: string | null; installed: boolean; message: string }> {
  // Probe EVERY candidate interpreter (python / py / python3) — Windows boxes
  // routinely have several (python.org install, Microsoft Store alias, the py
  // launcher), and faster-whisper may be installed in any one of them.
  // B-011: the old code stopped at the first candidate found on PATH and
  // reported "not installed" even when another interpreter had the package.
  const found: Array<{ command: string; binary: string }> = []
  for (const python of pythonCandidates()) {
    const binary = whichSync(python)
    if (!binary) continue
    if (found.some((f) => f.binary === binary)) continue // same interpreter via two names
    found.push({ command: python, binary })
    try {
      const { code, stdout } = await runProcess(binary, ['-c', 'import faster_whisper; print("ok")'], { timeoutMs: 15000 })
      if (code === 0 && stdout.includes('ok')) {
        return { python: binary, installed: true, message: `Local Whisper available (${binary})` }
      }
    } catch {
      /* this interpreter is broken/stubbed — try the next candidate */
    }
  }
  if (found.length === 0) {
    return {
      python: null,
      installed: false,
      message: 'Python was not found on this system. Install Python 3.9+ from python.org (and tick "Add to PATH"), then: python -m pip install faster-whisper'
    }
  }
  const first = found[0]
  const extra =
    found.length > 1
      ? ` (also found: ${found.slice(1).map((f) => `"${f.binary}"`).join(', ')} — the package must go into ONE of them)`
      : ''
  return {
    python: first.binary,
    installed: false,
    message: `Python found at "${first.binary}" but the 'faster-whisper' package is not installed there${extra}. Run exactly: "${first.binary}" -m pip install faster-whisper`,
  }
}

export async function listTranscriptionProviders(ctx: AppContext): Promise<ProviderAvailability[]> {
  const settings = getSettings(ctx)
  const local = await detectLocalWhisper()
  const openaiConfigured = Boolean(
    settings.ai.openai.baseUrl && settings.ai.openai.model && settings.ai.openai.supportsAudio
  )
  const hasKey = ctx.secrets.get('ai:openai-compatible') != null

  return [
    {
      id: 'faster-whisper-local',
      label: 'Local Whisper (faster-whisper)',
      kind: 'transcription',
      available: local.installed,
      configured: local.installed,
      message: local.installed
        ? 'Runs fully offline on this machine. Models are cached locally on first use.'
        : `${local.message} Install with "pip install faster-whisper" to enable offline transcription.`,
      fixHint: 'Settings → Transcription'
    },
    {
      id: 'openai-compatible',
      label: 'OpenAI-compatible cloud transcription',
      kind: 'transcription',
      available: openaiConfigured && hasKey,
      configured: openaiConfigured && hasKey,
      message:
        openaiConfigured && hasKey
          ? 'Sends the extracted audio track to your configured endpoint for transcription.'
          : 'Requires a provider with base URL, model, API key, and "supports audio transcription" enabled.',
      fixHint: 'Settings → AI'
    },
    {
      id: 'import-file',
      label: 'Import transcript file',
      kind: 'transcription',
      available: true,
      configured: true,
      message: 'Always available. Import an existing SRT, WebVTT, JSON, or timestamped text transcript.'
    }
  ]
}

export interface TranscribeOptions {
  projectId: string
  providerId: 'faster-whisper-local' | 'openai-compatible'
  onEvent: (stage: string, progress: number | null, message: string) => void
  signal: AbortSignal
}

interface RawSegment {
  start: number
  end: number
  text: string
  speaker?: string | null
  confidence?: number | null
  words?: WordTiming[] | null
}

export async function runTranscription(ctx: AppContext, opts: TranscribeOptions): Promise<{ segments: number }> {
  const project = projectsRepo.get(ctx.db, opts.projectId)
  if (!project) throw new AppError('PROJECT_NOT_FOUND', 'That project no longer exists.')
  if (!project.sourcePath || !fs.existsSync(project.sourcePath)) {
    throw new AppError('SOURCE_MISSING', 'This project has no imported media.', 'Import a video before transcribing.')
  }
  if (!project.hasAudio) {
    throw new AppError(
      'NO_AUDIO',
      'This video has no audio track, so speech transcription cannot run on it.',
      'You can still import an existing transcript (SRT/VTT/JSON) from the Transcript tab, or use a video that contains audio.'
    )
  }

  projectsRepo.setStatus(ctx.db, opts.projectId, 'transcribing', 'Transcribing audio')
  opts.onEvent('starting', null, 'Preparing audio')

  try {
    const settings = getSettings(ctx)
    let result: { language: string | null; segments: RawSegment[] }

    if (opts.providerId === 'faster-whisper-local') {
      result = await transcribeLocal(ctx, project.sourcePath, settings, opts)
    } else {
      result = await transcribeCloud(ctx, project.sourcePath, settings, opts)
    }

    const validated = transcriptResultSchema.safeParse(result)
    if (!validated.success) {
      throw new AppError('TRANSCRIPTION_INVALID', 'The transcription result failed validation.', undefined, validated.error.message)
    }
    if (validated.data.segments.length === 0) {
      throw new AppError(
        'TRANSCRIPTION_EMPTY',
        'The transcription produced no speech segments.',
        'The audio may be silent or music-only. Check the audio track, or import an existing transcript.'
      )
    }

    const count = segmentsRepo.replaceForProject(
      ctx.db,
      opts.projectId,
      validated.data.segments.map((s) => ({
        startTime: s.start,
        endTime: s.end,
        text: s.text,
        speaker: s.speaker ?? null,
        confidence: s.confidence ?? null,
        words: s.words ?? null
      }))
    )

    // Persist a human-readable copy in the project
    const transcriptPath = path.join(ctx.projectDir(opts.projectId), 'transcription', 'transcript.json')
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true })
    fs.writeFileSync(transcriptPath, JSON.stringify(validated.data, null, 2))

    projectsRepo.setStatus(ctx.db, opts.projectId, 'transcribed', null)
    ctx.logger.info('transcription', 'done', `project=${opts.projectId} segments=${count} provider=${opts.providerId}`)
    return { segments: count }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Transcription failed'
    if (!(err instanceof AppError) || err.code !== 'PROCESS_CANCELLED') {
      projectsRepo.setStatus(ctx.db, opts.projectId, 'transcription_failed', message)
      ctx.logger.error('transcription', 'failed', `project=${opts.projectId}`, String(err))
    }
    throw err
  }
}

async function transcribeLocal(
  ctx: AppContext,
  sourcePath: string,
  settings: import('@shared/types').AppSettings,
  opts: TranscribeOptions
): Promise<{ language: string | null; segments: RawSegment[] }> {
  const local = await detectLocalWhisper()
  if (!local.installed || !local.python) {
    throw new AppError(
      'WHISPER_UNAVAILABLE',
      'Local Whisper is not available on this machine.',
      local.message + ' Alternatively, import an existing transcript or configure a cloud provider.',
      undefined
    )
  }

  const scriptPath = path.join(ctx.resourcesDir, 'python', 'transcribe_faster_whisper.py')
  if (!fs.existsSync(scriptPath)) {
    throw new AppError('SCRIPT_MISSING', 'The transcription script is missing from the application resources.', 'Reinstall the application.')
  }

  const args = [
    scriptPath,
    '--input', sourcePath,
    '--model', settings.transcription.whisperModel,
    '--model-dir', ctx.paths.modelsDir,
    '--device', 'cpu',
    '--compute', settings.transcription.whisperCompute === 'auto' ? 'int8' : settings.transcription.whisperCompute,
  ]
  if (settings.transcription.language && settings.transcription.language !== 'auto') {
    args.push('--language', settings.transcription.language)
  }

  opts.onEvent('loading-model', null, `Loading the ${settings.transcription.whisperModel} model (first use downloads it)`)

  let stderrBuf = ''
  const { code, stdout, stderr } = await runProcess(local.python, args, {
    signal: opts.signal,
    timeoutMs: 60 * 60 * 1000,
    onStderr: (chunk) => {
      stderrBuf = (stderrBuf + chunk).slice(-4000)
      for (const line of chunk.split('\n')) {
        try {
          const data = JSON.parse(line.trim())
          if (typeof data.progress === 'number') {
            opts.onEvent('transcribing', data.progress, data.message || 'Transcribing audio')
          }
        } catch {
          /* non-JSON noise */
        }
      }
    }
  })

  if (opts.signal.aborted) throw new AppError('PROCESS_CANCELLED', 'Transcription was cancelled.')
  if (code !== 0) {
    let parsed: { error?: { code?: string; message?: string } } = {}
    try {
      parsed = JSON.parse(stdout.trim().split('\n').pop() ?? '{}')
    } catch {
      /* raw failure */
    }
    if (parsed.error?.code === 'FASTER_WHISPER_NOT_INSTALLED') {
      throw new AppError('WHISPER_UNAVAILABLE', 'The faster-whisper Python package is not installed.', 'Run: pip install faster-whisper', stdout.slice(-800))
    }
    if (parsed.error?.code === 'MODEL_LOAD_FAILED') {
      throw new AppError('WHISPER_MODEL_LOAD_FAILED', parsed.error.message ?? 'The Whisper model could not be loaded.', 'Check your internet connection (models download on first use) and free disk space.', stdout.slice(-800))
    }
    throw new AppError(
      'WHISPER_FAILED',
      'Local transcription failed.',
      'Check the technical details; you can also switch providers in Settings.',
      (stderr || stderrBuf || stdout).slice(-2000)
    )
  }

  try {
    const parsed = JSON.parse(stdout)
    if (parsed.error) {
      throw new AppError('WHISPER_FAILED', parsed.error.message ?? 'Local transcription failed.', undefined, stdout.slice(-800))
    }
    return parsed
  } catch (err) {
    if (err instanceof AppError) throw err
    throw new AppError('WHISPER_BAD_OUTPUT', 'The transcription process returned unreadable output.', undefined, stdout.slice(-800))
  }
}

async function transcribeCloud(
  ctx: AppContext,
  sourcePath: string,
  settings: import('@shared/types').AppSettings,
  opts: TranscribeOptions
): Promise<{ language: string | null; segments: RawSegment[] }> {
  const cfg = settings.ai.openai
  const key = ctx.secrets.get('ai:openai-compatible')
  if (!cfg.baseUrl || !cfg.model) {
    throw new AppError('AI_NOT_CONFIGURED', 'The cloud transcription provider is not configured.', 'Set the base URL and model in Settings → AI.')
  }
  if (!key) {
    throw new AppError('AI_NO_KEY', 'No API key is set for this provider.', 'Add the key in Settings → AI.')
  }

  opts.onEvent('extracting-audio', null, 'Extracting the audio track')
  const { ffmpeg } = await getBinaries(ctx)
  const audioPath = path.join(ctx.projectDir(opts.projectId), 'cache', 'audio-for-transcription.m4a')
  await extractAudio(ffmpeg.path, sourcePath, audioPath)

  opts.onEvent('uploading', null, 'Sending the audio track to the configured endpoint')
  const base = cfg.baseUrl.replace(/\/+$/, '')
  const url = base.endsWith('/audio/transcriptions') ? base : `${base}/audio/transcriptions`

  const audioBuffer = await fs.promises.readFile(audioPath)
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(audioBuffer)], { type: 'audio/m4a' }), 'audio.m4a')
  form.append('model', cfg.model)
  form.append('response_format', 'verbose_json')
  if (settings.transcription.language && settings.transcription.language !== 'auto') {
    form.append('language', settings.transcription.language)
  }
  const timeout = AbortSignal.any([opts.signal, AbortSignal.timeout(10 * 60 * 1000)])

  let res: Response
  try {
    res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal: timeout })
  } catch (err) {
    if (opts.signal.aborted) throw new AppError('PROCESS_CANCELLED', 'Transcription was cancelled.')
    throw new AppError('AI_NETWORK_ERROR', 'The transcription endpoint could not be reached.', 'Check the base URL and your internet connection.', String(err))
  }

  const text = await res.text()
  if (!res.ok) {
    if (res.status === 401) throw new AppError('AI_UNAUTHORIZED', 'The endpoint rejected the API key.', 'Check the API key in Settings → AI.')
    throw new AppError('AI_HTTP_ERROR', `The endpoint returned HTTP ${res.status}.`, 'Check the model name and base URL. Not every OpenAI-compatible endpoint supports audio transcription.', text.slice(-1000))
  }

  try {
    const parsed = JSON.parse(text)
    // verbose_json: { language, segments: [{start,end,text,words?}] } — also accept flat 'duration'
    if (Array.isArray(parsed.segments) && parsed.segments.length > 0) {
      return {
        language: parsed.language ?? null,
        segments: parsed.segments.map((s: { start: number; end: number; text: string; words?: Array<{ word: string; start: number; end: number }> }) => ({
          start: s.start,
          end: s.end,
          text: String(s.text ?? '').trim(),
          words: Array.isArray(s.words) ? s.words.map((w) => ({ word: w.word, start: w.start, end: w.end })) : null
        }))
      }
    }
    throw new Error('no segments in response')
  } catch {
    throw new AppError('AI_BAD_RESPONSE', 'The endpoint responded, but not with a readable transcript.', 'Verify the endpoint supports the verbose_json transcription format.', text.slice(-800))
  }
}

// ------------------------------------------------------------------ import --

export function importTranscript(ctx: AppContext, projectId: string, filePath: string): { segments: number } {
  const project = projectsRepo.get(ctx.db, projectId)
  if (!project) throw new AppError('PROJECT_NOT_FOUND', 'That project no longer exists.')
  if (!fs.existsSync(filePath)) {
    throw new AppError('FILE_NOT_FOUND', `The file "${path.basename(filePath)}" does not exist.`)
  }
  const content = fs.readFileSync(filePath, 'utf-8')
  const result = parseTranscriptFile(path.basename(filePath), content)

  if (project.duration != null) {
    const maxEnd = Math.max(...result.segments.map((s) => s.end))
    if (maxEnd > project.duration + 30) {
      // Not fatal — imported transcripts may come from extended cuts — but log it
      ctx.logger.warn('transcription', 'import.range', `transcript ends at ${maxEnd.toFixed(1)}s but media is ${project.duration.toFixed(1)}s`)
    }
  }

  const count = segmentsRepo.replaceForProject(
    ctx.db,
    projectId,
    result.segments.map((s) => ({ startTime: s.start, endTime: s.end, text: s.text, speaker: s.speaker ?? null, confidence: s.confidence ?? null, words: s.words ?? null }))
  )

  const transcriptPath = path.join(ctx.projectDir(projectId), 'transcription', 'transcript.json')
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true })
  fs.writeFileSync(transcriptPath, JSON.stringify(result, null, 2))

  projectsRepo.setStatus(ctx.db, projectId, 'transcribed', null)
  const updated = projectsRepo.get(ctx.db, projectId)
  if (updated) ctx.events.publish({ type: 'project:update', project: updated })
  ctx.logger.info('transcription', 'import', `project=${projectId} segments=${count} file=${path.basename(filePath)}`)
  return { segments: count }
}

export function getTranscript(ctx: AppContext, projectId: string): TranscriptSegment[] {
  return segmentsRepo.listForProject(ctx.db, projectId)
}
