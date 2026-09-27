import fs from 'node:fs'
import path from 'node:path'
import type { AppSettings, Clip, Project } from '@shared/types'
import { AppError } from '@shared/errors'
import { ASPECT_RATIOS, getCaptionStyle } from '@shared/constants'
import { buildCues, type CaptionCue } from '@shared/captions/segmentation'
import { computeCrop } from '@shared/video/crop'
import { buildAssDocument } from '@shared/captions/ass'
import { escapeFilterPath } from '../media/ffmpeg'
import type { AppContext } from '../app-context'
import { segmentsRepo } from '../database/repositories'

/**
 * Render plan construction: turns a clip configuration into the exact FFmpeg
 * invocation (trim → reframe → captions → audio → encode) plus the ASS
 * subtitle document. Pure planning — execution happens in queue.ts.
 */

export interface RenderPlan {
  renderId: string
  clipId: string
  sourcePath: string
  assPath: string | null
  tmpPath: string
  finalPath: string
  expectedDuration: number
  args: string[]
  hasCaptions: boolean
  hasAudio: boolean
  encoder: string
}

export const HW_ENCODER_PREFERENCE = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_videotoolbox']

/** Build caption cues for a clip (absolute times; shared logic with preview). */
export function buildClipCues(ctx: AppContext, clip: Clip): CaptionCue[] {
  if (clip.captionStyleId === 'none') return []
  const segments = segmentsRepo.listForProject(ctx.db, clip.projectId)
  const style = getCaptionStyle(clip.captionStyleId)
  const o = clip.captionOverrides
  return buildCues(segments, {
    maxWordsPerCue: o.maxWordsPerCue ?? style.maxWordsPerCue,
    maxCharsPerLine: style.maxCharsPerLine,
    maxLines: style.maxLines,
    textEdits: clip.captionTextEdits,
    fromTime: clip.startTime,
    toTime: clip.endTime
  })
}

/** Shift cues to a render-local timeline (input seeking resets t=0). */
export function shiftCues(cues: CaptionCue[], delta: number): CaptionCue[] {
  return cues.map((c) => ({
    ...c,
    startTime: Math.max(0, c.startTime + delta),
    endTime: Math.max(0.05, c.endTime + delta),
    words: c.words.map((w) => ({ ...w, start: Math.max(0, w.start + delta), end: Math.max(0, w.end + delta) }))
  }))
}

export function buildRenderPlan(
  ctx: AppContext,
  opts: {
    renderId: string
    clip: Clip
    project: Project
    settings: AppSettings
    ffmpegPath: string
    encoder: string
  }
): RenderPlan {
  const { clip, project, settings, encoder } = opts
  if (!project.sourcePath) {
    throw new AppError(
      'SOURCE_MISSING',
      'This project has no imported media to render from.',
      'Import a video first.'
    )
  }

  const target = ASPECT_RATIOS[clip.aspectRatio] ?? ASPECT_RATIOS['9:16']
  const rendersDir = path.join(ctx.projectDir(clip.projectId), 'renders')
  fs.mkdirSync(rendersDir, { recursive: true })

  const tmpPath = path.join(rendersDir, `${opts.renderId}.tmp.mp4`)
  const finalPath = path.join(rendersDir, `${opts.renderId}.mp4`)

  // Captions
  const cues = buildClipCues(ctx, clip)
  let assPath: string | null = null
  let assArg = ''
  if (cues.length > 0 && clip.captionStyleId !== 'none') {
    const style = getCaptionStyle(clip.captionStyleId)
    const o = clip.captionOverrides
    const ass = buildAssDocument(shiftCues(cues, -clip.startTime), {
      style,
      fontSizePct: o.fontSizePct,
      positionY: o.positionY,
      emphasis: o.emphasis,
      uppercase: o.uppercase,
      playResX: target.w,
      playResY: target.h
    })
    assPath = path.join(rendersDir, `${opts.renderId}.ass`)
    fs.writeFileSync(assPath, ass, 'utf-8')
    const fontsDir = ctx.paths.fontsDir
    assArg = `,subtitles='${escapeFilterPath(assPath)}':fontsdir='${escapeFilterPath(fontsDir)}'`
  }

  // Reframe
  const crop = computeCrop(
    project.width ?? 1920,
    project.height ?? 1080,
    target.w,
    target.h,
    clip.cropMode,
    clip.cropX,
    clip.zoom
  )
  const vf = `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},scale=${target.w}:${target.h}:flags=lanczos${assArg}`

  // Audio
  const hasAudio = project.hasAudio
  const audioArgs = hasAudio
    ? settings.video.audioNormalize
      ? ['-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-c:a', 'aac', '-b:a', '192k']
      : ['-c:a', 'aac', '-b:a', '192k']
    : ['-an']

  // Encoder
  const isHw = encoder !== 'libx264'
  const encoderArgs = isHw
    ? ['-c:v', encoder, '-b:v', clip.aspectRatio === '9:16' ? '8M' : '6M']
    : ['-c:v', 'libx264', '-crf', String(settings.video.crf), '-preset', settings.video.renderPreset]

  const duration = Math.max(0.2, clip.endTime - clip.startTime)

  const args = [
    '-y',
    '-ss', clip.startTime.toFixed(3),
    '-i', project.sourcePath,
    '-t', duration.toFixed(3),
    '-vf', vf,
    ...audioArgs,
    ...encoderArgs,
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-progress', 'pipe:1',
    '-nostats',
    tmpPath
  ]

  return {
    renderId: opts.renderId,
    clipId: clip.id,
    sourcePath: project.sourcePath,
    assPath,
    tmpPath,
    finalPath,
    expectedDuration: duration,
    args,
    hasCaptions: cues.length > 0,
    hasAudio,
    encoder
  }
}

/** Choose encoder based on settings + probed availability. */
export function pickEncoder(settings: AppSettings, availableEncoders: string[] | null): string {
  if (!settings.video.useHardwareEncoder) return 'libx264'
  if (availableEncoders) {
    for (const enc of HW_ENCODER_PREFERENCE) {
      if (availableEncoders.includes(enc)) return enc
    }
  }
  return 'libx264'
}

export async function probeEncoders(ffmpegPath: string, run: (bin: string, args: string[]) => Promise<{ stdout: string }>): Promise<string[]> {
  const { stdout } = await run(ffmpegPath, ['-hide_banner', '-encoders'])
  return stdout
    .split('\n')
    .map((line) => {
      const m = line.match(/^\s*[A-Z.]+\s+(\S+)\s+/)
      return m ? m[1] : null
    })
    .filter((x): x is string => x != null)
}
