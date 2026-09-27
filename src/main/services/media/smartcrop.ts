import fs from 'node:fs'
import path from 'node:path'
import { AppError } from '@shared/errors'
import type { Clip, Project } from '@shared/types'
import { ASPECT_RATIOS, resolutionFor } from '@shared/constants'
import { computeCrop, contentRectOf } from '@shared/video/crop'
import { bestWindow, evenKeyframe, mergeKeyframes, type SmartKeyframe } from '@shared/video/saliency'
import type { AppContext } from '../app-context'
import { getSettings } from '../settings'
import { resolveFfmpeg, runProcess } from './ffmpeg'
import { detectContentRect } from './inspect'

/**
 * Smart-crop analysis (§24-28): REAL shot detection (FFmpeg scene scores) +
 * REAL per-shot saliency (decoded grayscale frames → gradient-energy window
 * selection). Results are stored as crop keyframes on the clip and used by
 * both the render pipeline and the editor preview (§68 parity).
 */

const SALIENCY_WIDTH = 192

/** Detect shot boundaries inside [from, to] via scene-change scores. */
export async function detectShots(
  ffmpegPath: string,
  sourcePath: string,
  from: number,
  to: number,
  opts: { threshold?: number } = {}
): Promise<number[]> {
  const threshold = opts.threshold ?? 0.32
  const duration = Math.max(0.2, to - from)
  const res = await runProcess(
    ffmpegPath,
    [
      '-hide_banner', '-nostats',
      '-ss', from.toFixed(3),
      '-t', duration.toFixed(3),
      '-i', sourcePath,
      '-vf', `select='gt(scene,${threshold})',showinfo`,
      '-an',
      '-f', 'null',
      '-'
    ],
    { timeoutMs: 120_000 }
  )
  const text = res.stderr + res.stdout
  const boundaries: number[] = []
  for (const m of text.matchAll(/pts_time:([\d.]+)/g)) {
    const t = parseFloat(m[1])
    if (Number.isFinite(t) && t > 0.05 && t < duration - 0.05) {
      boundaries.push(from + t)
    }
  }
  boundaries.sort((a, b) => a - b)
  // de-duplicate near-identical boundaries
  const out: number[] = []
  for (const b of boundaries) {
    if (out.length === 0 || b - out[out.length - 1] > 0.3) out.push(b)
  }
  return out
}

/** Decode one grayscale frame at time t (small scale) for saliency analysis. */
async function saliencyFrame(
  ffmpegPath: string,
  sourcePath: string,
  t: number,
  workDir: string
): Promise<{ width: number; height: number; gray: Uint8Array } | null> {
  const raw = path.join(workDir, `saliency-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.gray`)
  try {
    const res = await runProcess(
      ffmpegPath,
      [
        '-hide_banner', '-y', '-nostats',
        '-ss', Math.max(0, t).toFixed(3),
        '-i', sourcePath,
        '-frames:v', '1',
        '-vf', `scale=${SALIENCY_WIDTH}:-2`,
        '-f', 'rawvideo',
        '-pix_fmt', 'gray',
        raw
      ],
      { timeoutMs: 30_000 }
    )
    if (res.code !== 0 || !fs.existsSync(raw)) return null
    const buf = fs.readFileSync(raw)
    if (buf.length < SALIENCY_WIDTH * 8) return null
    // height derived from the buffer size (width fixed, height = len/width)
    const height = Math.floor(buf.length / SALIENCY_WIDTH)
    if (height < 8) return null
    return { width: SALIENCY_WIDTH, height, gray: new Uint8Array(buf) }
  } finally {
    try {
      if (fs.existsSync(raw)) fs.rmSync(raw, { force: true })
    } catch {
      /* best effort */
    }
  }
}

export interface SmartCropResult {
  keyframes: SmartKeyframe[]
  shotCount: number
  contentRect: { left: number; top: number; width: number; height: number } | null
  barsRemoved: boolean
}

export async function analyzeSmartCrop(ctx: AppContext, project: Project, clip: Clip): Promise<SmartCropResult> {
  if (!project.sourcePath || !fs.existsSync(project.sourcePath)) {
    throw new AppError('SOURCE_MISSING', 'This project has no imported media.', 'Import a video first.')
  }
  const ffmpeg = await resolveFfmpeg(getSettings(ctx).advanced.ffmpegPath || undefined)
  if (!ffmpeg) {
    throw new AppError('FFMPEG_NOT_FOUND', 'FFmpeg is required for smart crop analysis.', 'Install FFmpeg or set its path in Settings → Advanced.')
  }
  if (project.rotation !== 0 && project.rotation !== 180) {
    throw new AppError(
      'SMART_CROP_UNSUPPORTED_ROTATION',
      'Smart crop is not available for rotated video (90°/270° metadata).',
      'Use Manual or Center crop for this source — they handle rotation correctly.'
    )
  }

  // Backfill the content rect for projects imported before detection existed.
  let contentRect = project.contentRect
  if (!contentRect) {
    try {
      contentRect = await detectContentRect(
        ffmpeg.path,
        project.sourcePath,
        project.duration ?? clip.endTime,
        project.width ?? 1920,
        project.height ?? 1080,
        project.rotation
      )
    } catch {
      contentRect = null
    }
    if (contentRect) {
      const { projectsRepo } = await import('../database/repositories')
      projectsRepo.update(ctx.db, project.id, {
        content_left: contentRect.left,
        content_top: contentRect.top,
        content_width: contentRect.width,
        content_height: contentRect.height
      })
    }
  }

  const frameW = project.width ?? 1920
  const frameH = project.height ?? 1080
  const content = contentRectOf({ width: frameW, height: frameH, contentRect }, frameW, frameH)
  const target = resolutionFor(clip.aspectRatio, clip.outputResolution)

  // The fill window (max target-aspect window inside the content area)
  const fill = computeCrop(frameW, frameH, target.w, target.h, 'center', 0.5, 1, content)

  // Shot boundaries inside the clip window
  const from = clip.startTime
  const to = clip.endTime
  const shots = await detectShots(ffmpeg.path, project.sourcePath, from, to)
  const spanStarts = [from, ...shots].slice(0, 17) // hard cap on analyzed spans
  const rawKeyframes: SmartKeyframe[] = []
  for (let i = 0; i < spanStarts.length; i++) {
    const segStart = spanStarts[i]
    const segEnd = i + 1 < spanStarts.length ? spanStarts[i + 1] : to
    if (segEnd - segStart < 0.2) continue
    const mid = segStart + (segEnd - segStart) / 2
    const frame = await saliencyFrame(ffmpeg.path, project.sourcePath, mid, ctx.projectDir(project.id))
    let win = { x: fill.x, y: fill.y }
    if (frame) {
      const scale = frame.width / frameW
      const choice = bestWindow(
        frame.width,
        frame.height,
        frame.gray,
        Math.max(8, Math.round(fill.w * scale)),
        Math.max(8, Math.round(fill.h * scale)),
        {
          left: Math.round(content.left * scale),
          top: Math.round(content.top * scale),
          width: Math.max(8, Math.round(content.width * scale)),
          height: Math.max(8, Math.round(content.height * scale))
        }
      )
      win = { x: Math.round(choice.x / scale), y: Math.round(choice.y / scale) }
    }
    rawKeyframes.push({ start: segStart, end: segEnd, x: win.x, y: win.y, w: fill.w, h: fill.h })
  }

  if (rawKeyframes.length === 0) {
    rawKeyframes.push({ start: from, end: to, x: fill.x, y: fill.y, w: fill.w, h: fill.h })
  }

  const moveThreshold = Math.max(2, Math.round(frameW * 0.01))
  // Clamp windows INTO the content area (not just the frame): the bars must
  // never leak back in through a rounded-up coordinate.
  const contentBounds = { w: content.left + content.width, h: content.top + content.height }
  const merged = mergeKeyframes(
    rawKeyframes.map((raw) => {
      const clamped: SmartKeyframe = {
        ...raw,
        x: Math.max(content.left, Math.min(contentBounds.w - raw.w, raw.x)),
        y: Math.max(content.top, Math.min(contentBounds.h - raw.h, raw.y))
      }
      return evenKeyframe(clamped, frameW, frameH)
    }),
    { maxKeyframes: 12, moveThresholdPx: moveThreshold }
  )

  return {
    keyframes: merged,
    shotCount: shots.length,
    contentRect: content,
    barsRemoved: content.width !== frameW || content.height !== frameH
  }
}
