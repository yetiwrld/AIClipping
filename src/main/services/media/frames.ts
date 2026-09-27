import fs from 'node:fs'
import path from 'node:path'
import { AppError } from '@shared/errors'
import type { Project } from '@shared/types'
import type { AppContext } from '../app-context'
import { getSettings } from '../settings'
import { resolveFfmpeg, runProcess } from './ffmpeg'
import { getProject } from '../projects'

/**
 * Real timeline visuals: filmstrip thumbnails and audio waveform peaks.
 * Both are produced by FFmpeg, cached on disk, and refreshed only when the
 * source changes (mtime + size key). No simulated data (§109).
 */

interface CacheMeta {
  key: string
  count: number
}

function cacheKey(project: Project): string {
  let mtime = 0
  let size = 0
  try {
    const st = fs.statSync(project.sourcePath as string)
    mtime = st.mtimeMs
    size = st.size
  } catch {
    /* missing file handled by caller */
  }
  return `${Math.round(mtime)}-${size}`
}

function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as T
  } catch {
    return null
  }
}

function writeJson(p: string, data: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(data), 'utf-8')
}

// ------------------------------------------------------------ filmstrip ---

export interface FilmstripFrame {
  /** Source time of the frame center. */
  t: number
  /** Absolute path of the JPG. */
  path: string
}

export async function buildFilmstrip(
  ctx: AppContext,
  project: Project,
  count = 24
): Promise<{ frames: FilmstripFrame[]; cached: boolean }> {
  if (!project.sourcePath || !fs.existsSync(project.sourcePath)) {
    throw new AppError('FILE_NOT_FOUND', 'The source media file is missing.')
  }
  const ffmpeg = await resolveFfmpeg(getSettings(ctx).advanced.ffmpegPath || undefined)
  if (!ffmpeg) {
    throw new AppError('FFMPEG_NOT_FOUND', 'FFmpeg is required for the filmstrip.', 'Install FFmpeg or set its path in Settings → Advanced.')
  }
  const dir = path.join(ctx.projectDir(project.id), 'thumbnails', 'filmstrip')
  const metaPath = path.join(dir, 'meta.json')
  const key = cacheKey(project)
  const meta = readJson<CacheMeta>(metaPath)
  const n = Math.max(6, Math.min(48, Math.round(count)))
  if (meta && meta.key === key && meta.count === n) {
    const frames: FilmstripFrame[] = []
    for (let i = 0; i < meta.count; i++) {
      const p = path.join(dir, `f${String(i).padStart(3, '0')}.jpg`)
      if (!fs.existsSync(p)) {
        frames.length = 0
        break
      }
      frames.push({ t: ((i + 0.5) / meta.count) * (project.duration ?? 0), path: p })
    }
    if (frames.length === meta.count) return { frames, cached: true }
  }

  // Rebuild: evenly spaced frames via fps filter, 90px tall.
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const duration = Math.max(0.5, project.duration ?? 0)
  const fpsExpr = (n / duration).toFixed(6)
  const res = await runProcess(
    ffmpeg.path,
    [
      '-hide_banner', '-y',
      '-i', project.sourcePath,
      '-vf', `fps=${fpsExpr},scale=-2:90:flags=bicubic`,
      '-frames:v', String(n),
      '-start_number', '0',
      '-q:v', '4',
      path.join(dir, 'f%03d.jpg')
    ],
    { timeoutMs: 180_000 }
  )
  const frames: FilmstripFrame[] = []
  for (let i = 0; i < n; i++) {
    const p = path.join(dir, `f${String(i).padStart(3, '0')}.jpg`)
    if (fs.existsSync(p)) frames.push({ t: ((i + 0.5) / n) * duration, path: p })
  }
  if (res.code !== 0 || frames.length === 0) {
    throw new AppError(
      'FILMSTRIP_FAILED',
      'Filmstrip thumbnails could not be generated.',
      'The source may use a codec FFmpeg cannot decode. Timeline thumbnails are disabled for this file.',
      res.stderr.slice(-1200)
    )
  }
  writeJson(metaPath, { key, count: frames.length } satisfies CacheMeta)
  return { frames, cached: false }
}

// ------------------------------------------------------------- waveform ---

export interface WaveformData {
  duration: number
  /** Peak amplitude 0..1 per bucket. */
  peaks: number[]
  /** True when the media has no audio track (waveform hidden). */
  silent: boolean
}

export async function buildWaveform(
  ctx: AppContext,
  project: Project,
  buckets = 1200
): Promise<WaveformData> {
  const out: WaveformData = { duration: project.duration ?? 0, peaks: [], silent: !project.hasAudio }
  if (!project.hasAudio) return out
  if (!project.sourcePath || !fs.existsSync(project.sourcePath)) {
    throw new AppError('FILE_NOT_FOUND', 'The source media file is missing.')
  }
  const ffmpeg = await resolveFfmpeg(getSettings(ctx).advanced.ffmpegPath || undefined)
  if (!ffmpeg) {
    throw new AppError('FFMPEG_NOT_FOUND', 'FFmpeg is required for the waveform.', 'Install FFmpeg or set its path in Settings → Advanced.')
  }
  const cachePath = path.join(ctx.projectDir(project.id), 'thumbnails', 'waveform.json')
  const key = cacheKey(project)
  const cached = readJson<WaveformData & { key?: string }>(cachePath)
  if (cached && cached.key === key && Array.isArray(cached.peaks) && cached.peaks.length > 0) {
    return { duration: cached.duration, peaks: cached.peaks, silent: cached.silent }
  }

  // Decode to 8 kHz mono s16 PCM, compute per-bucket peaks, then delete the
  // intermediate file. Duration-bounded: a 10-min file is ~10 MB of PCM.
  const rawPath = path.join(ctx.projectDir(project.id), 'thumbnails', 'waveform.raw')
  fs.mkdirSync(path.dirname(rawPath), { recursive: true })
  const res = await runProcess(
    ffmpeg.path,
    [
      '-hide_banner', '-y',
      '-i', project.sourcePath,
      '-vn',
      '-ac', '1',
      '-ar', '8000',
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      rawPath
    ],
    { timeoutMs: 180_000 }
  )
  if (res.code !== 0 || !fs.existsSync(rawPath)) {
    fs.rmSync(rawPath, { force: true })
    throw new AppError(
      'WAVEFORM_FAILED',
      'The audio waveform could not be generated.',
      'The source audio may use a codec FFmpeg cannot decode. The waveform is disabled for this file.',
      res.stderr.slice(-1200)
    )
  }
  const buf = fs.readFileSync(rawPath)
  fs.rmSync(rawPath, { force: true })
  const totalSamples = Math.floor(buf.length / 2)
  const n = Math.max(10, Math.min(4000, Math.round(buckets)))
  const per = Math.max(1, Math.floor(totalSamples / n))
  const peaks: number[] = []
  for (let b = 0; b < n; b++) {
    let peak = 0
    const startIdx = b * per
    if (startIdx >= totalSamples) {
      peaks.push(0)
      continue
    }
    const endIdx = Math.min(totalSamples, startIdx + per)
    for (let i = startIdx; i < endIdx; i++) {
      const v = Math.abs(buf.readInt16LE(i * 2)) / 32768
      if (v > peak) peak = v
    }
    peaks.push(Math.round(peak * 1000) / 1000)
  }
  const data: WaveformData & { key: string } = { duration: project.duration ?? 0, peaks, silent: false, key }
  writeJson(cachePath, data)
  return { duration: data.duration, peaks, silent: false }
}

/** Handler helper: load project or throw. */
export function projectForVisuals(ctx: AppContext, projectId: string): Project {
  const project = getProject(ctx, projectId)
  if (!project) throw new AppError('PROJECT_NOT_FOUND', 'That project no longer exists.')
  if (!project.sourcePath) throw new AppError('PROJECT_HAS_NO_SOURCE', 'This project has no source media yet.')
  return project
}
