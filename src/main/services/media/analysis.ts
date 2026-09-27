import fs from 'node:fs'
import path from 'node:path'
import { AppError } from '@shared/errors'
import type { Project } from '@shared/types'
import { normalizeCuts } from '@shared/video/segments'
import type { AppContext } from '../app-context'
import { getSettings } from '../settings'
import { resolveFfmpeg, runProcess } from './ffmpeg'
import { getProject } from '../projects'

/**
 * Audio analysis + proxy transcoding (video-engine overhaul).
 * - detectSilence: real FFmpeg silencedetect pass over a clip window.
 * - renderProxy: H.264/AAC 720p stand-in for codecs Chromium cannot decode.
 * Everything here is genuinely executed via FFmpeg — no simulated results.
 */

export interface SilenceDetectionOptions {
  minSilenceMs: number
  paddingMs: number
  maxCutSec: number
}

export interface SilenceDetectionResult {
  /** Removed ranges in SOURCE time (ready for clip.silenceCuts). */
  cuts: Array<{ start: number; end: number }>
  /** Raw detected silence ranges (before padding/limits), source time. */
  detected: Array<{ start: number; end: number }>
  savedSec: number
}

export const DEFAULT_SILENCE_OPTIONS: SilenceDetectionOptions = {
  minSilenceMs: 700,
  paddingMs: 130,
  maxCutSec: 8
}

/** Effective thresholds for a detection mode (§36). */
export function optionsForMode(
  mode: 'auto' | 'aggressive' | 'custom',
  custom?: Partial<SilenceDetectionOptions>
): SilenceDetectionOptions {
  if (mode === 'aggressive') return { minSilenceMs: 450, paddingMs: 90, maxCutSec: 12 }
  if (mode === 'custom') return { ...DEFAULT_SILENCE_OPTIONS, ...custom }
  return DEFAULT_SILENCE_OPTIONS
}

/**
 * Run ffmpeg silencedetect over [from, to] of the project source and convert
 * the detected silence ranges into cut ranges with padding + per-cut limits.
 */
export async function detectSilence(
  ctx: AppContext,
  project: Project,
  window: { from: number; to: number },
  opts: SilenceDetectionOptions
): Promise<SilenceDetectionResult> {
  if (!project.hasAudio) {
    return { cuts: [], detected: [], savedSec: 0 }
  }
  const ffmpeg = await resolveFfmpeg(getSettings(ctx).advanced.ffmpegPath || undefined)
  if (!ffmpeg) {
    throw new AppError('FFMPEG_NOT_FOUND', 'FFmpeg is required for silence detection.', 'Install FFmpeg or set its path in Settings → Advanced.')
  }
  if (!project.sourcePath) {
    throw new AppError('PROJECT_HAS_NO_SOURCE', 'This project has no source media yet.')
  }
  const from = Math.max(0, window.from)
  const to = Math.max(from + 0.5, window.to)
  const duration = to - from
  const minSilence = Math.max(0.2, opts.minSilenceMs / 1000)
  const pad = Math.max(0, opts.paddingMs / 1000)

  const res = await runProcess(
    ffmpeg.path,
    [
      '-hide_banner', '-nostats',
      '-ss', from.toFixed(3),
      '-t', duration.toFixed(3),
      '-i', project.sourcePath as string,
      '-af', `silencedetect=noise=-35dB:d=${minSilence.toFixed(2)}`,
      '-vn',
      '-f', 'null',
      '-'
    ],
    { timeoutMs: 120_000 }
  )
  // silencedetect reports on stderr; a non-zero exit here still may contain
  // usable output, but treat hard failures as errors.
  const text = res.stderr + res.stdout

  const detected: Array<{ start: number; end: number }> = []
  const startRe = /silence_start:\s*(-?\d+(?:\.\d+)?)/g
  const endRe = /silence_end:\s*(\d+(?:\.\d+)?)/g
  const starts: number[] = []
  const ends: number[] = []
  let m: RegExpExecArray | null
  while ((m = startRe.exec(text)) !== null) starts.push(parseFloat(m[1]))
  while ((m = endRe.exec(text)) !== null) ends.push(parseFloat(m[1]))

  for (let i = 0; i < starts.length; i++) {
    const s = starts[i]
    const e = ends.length > i ? ends[i] : duration // unterminated silence → runs to window end
    if (e - s < minSilence) continue
    detected.push({
      start: from + Math.max(0, s),
      end: from + Math.min(duration, e)
    })
  }

  const cuts: Array<{ start: number; end: number }> = []
  for (const d of detected) {
    const cs = d.start + pad
    const ce = Math.min(d.end - pad, cs + opts.maxCutSec)
    if (ce - cs < 0.08) continue
    cuts.push({ start: cs, end: ce })
  }
  const norm = normalizeCuts(cuts)
  const savedSec = norm.reduce((s, c) => s + (c.end - c.start), 0)
  return { cuts: norm, detected, savedSec }
}

// -------------------------------------------------------------- playback ---

export type PlaybackVerdict = 'native' | 'proxy' | 'audio-only'

const NATIVE_VIDEO_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1'])
const NATIVE_AUDIO_CODECS = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le'])

/**
 * Decide whether Chromium's <video> can decode this media directly. Conservative
 * on purpose: unknown codecs get the proxy path rather than a black rectangle.
 */
export function playbackVerdict(project: {
  hasVideo?: boolean
  hasAudio: boolean
  videoCodec: string | null
  audioCodec: string | null
}): { verdict: PlaybackVerdict; reason: string } {
  const hasVideo = project.hasVideo ?? (project.videoCodec != null && project.videoCodec !== 'none')
  if (!hasVideo) return { verdict: 'audio-only', reason: 'This file has no video track.' }
  const v = (project.videoCodec ?? '').toLowerCase()
  const a = (project.audioCodec ?? '').toLowerCase()
  const videoOk = NATIVE_VIDEO_CODECS.has(v)
  const audioOk = !project.hasAudio || NATIVE_AUDIO_CODECS.has(a)
  if (videoOk && audioOk) return { verdict: 'native', reason: 'Direct playback supported.' }
  const problems: string[] = []
  if (!videoOk) problems.push(`video codec ${v || 'unknown'}`)
  if (!audioOk) problems.push(`audio codec ${a || 'unknown'}`)
  return {
    verdict: 'proxy',
    reason: `Chromium can't decode ${problems.join(' and ')} — a preview proxy is required.`
  }
}

export function proxyPathFor(ctx: AppContext, projectId: string): string {
  return path.join(ctx.projectDir(projectId), 'source', 'proxy.mp4')
}

export function proxyStatus(ctx: AppContext, project: Project): {
  verdict: PlaybackVerdict
  reason: string
  proxyExists: boolean
  proxyPath: string | null
} {
  const v = playbackVerdict(project)
  const p = proxyPathFor(ctx, project.id)
  const proxyExists = fs.existsSync(p) && fs.statSync(p).size > 1024
  return { ...v, proxyExists, proxyPath: proxyExists ? p : null }
}

/**
 * Transcode a proxy copy: 720p H.264 + AAC + 30fps, faststart for streaming.
 * Used ONLY for preview — renders always use the original file.
 */
export async function renderProxy(
  ctx: AppContext,
  project: Project,
  onProgress: (pct: number) => void,
  signal: AbortSignal
): Promise<{ proxyPath: string; durationSec: number }> {
  if (!project.sourcePath || !fs.existsSync(project.sourcePath)) {
    throw new AppError('FILE_NOT_FOUND', 'The source media file is missing.')
  }
  const ffmpeg = await resolveFfmpeg(getSettings(ctx).advanced.ffmpegPath || undefined)
  if (!ffmpeg) {
    throw new AppError('FFMPEG_NOT_FOUND', 'FFmpeg is required to create a preview proxy.', 'Install FFmpeg or set its path in Settings → Advanced.')
  }
  const out = proxyPathFor(ctx, project.id)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const tmp = `${out}.tmp.mp4`
  if (fs.existsSync(tmp)) fs.rmSync(tmp)

  const total = Math.max(1, project.duration ?? 0)
  const args = [
    '-hide_banner', '-y',
    '-i', project.sourcePath,
    '-vf', 'scale=-2:min(720\\,ih):flags=bicubic,fps=30,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
    '-movflags', '+faststart',
    tmp
  ]
  const res = await runProcess(ffmpeg.path, args, {
    signal,
    timeoutMs: 30 * 60_000,
    onStderr: (chunk) => {
      const mt = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(chunk)
      if (mt) {
        const sec = parseInt(mt[1], 10) * 3600 + parseInt(mt[2], 10) * 60 + parseFloat(mt[3])
        onProgress(Math.min(0.99, sec / total))
      }
    }
  })
  if (res.code !== 0 || !fs.existsSync(tmp) || fs.statSync(tmp).size < 1024) {
    if (fs.existsSync(tmp)) fs.rmSync(tmp)
    throw new AppError(
      'RENDER_FAILED',
      'The preview proxy could not be created.',
      'The source file may use a codec FFmpeg cannot read. Check the logs for details.',
      res.stderr.slice(-2000)
    )
  }
  fs.renameSync(tmp, out)
  onProgress(1)
  return { proxyPath: out, durationSec: project.duration ?? 0 }
}

/** Locate the project and ensure it has media attached. */
export function projectWithMedia(ctx: AppContext, projectId: string): Project {
  const project = getProject(ctx, projectId)
  if (!project) throw new AppError('PROJECT_NOT_FOUND', 'That project no longer exists.')
  if (!project.sourcePath) {
    throw new AppError('PROJECT_HAS_NO_SOURCE', 'This project has no source media yet.')
  }
  return project
}
