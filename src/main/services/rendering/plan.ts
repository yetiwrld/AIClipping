import fs from 'node:fs'
import path from 'node:path'
import type { AppSettings, Clip, Project } from '@shared/types'
import { AppError } from '@shared/errors'
import { ASPECT_RATIOS, getCaptionStyle, getQualityPreset, resolutionFor, type QualityPreset } from '@shared/constants'
import { buildCues, type CaptionCue } from '@shared/captions/segmentation'
import { computeCrop } from '@shared/video/crop'
import { keptSegments, keptDuration, remapCuesToKept, type TimeSegment } from '@shared/video/segments'
import { smartWindowAt } from '@shared/video/crop'
import { buildAssDocument } from '@shared/captions/ass'
import { escapeFilterPath } from '../media/ffmpeg'
import type { AppContext } from '../app-context'
import { segmentsRepo } from '../database/repositories'

/**
 * Render plan construction: turns a clip configuration into the exact FFmpeg
 * invocation plus the ASS subtitle document. Pure planning — execution and
 * validation happen in queue.ts.
 *
 * Output geometry comes from clip.outputResolution (short-side tier) and the
 * aspect ratio; quality from clip.outputQuality. Silence cuts turn the render
 * into a multi-segment concat with caption times remapped onto the kept
 * timeline — the same math the editor preview uses (§62-63 parity).
 */

export interface RenderPlan {
  renderId: string
  clipId: string
  sourcePath: string
  assPath: string | null
  tmpPath: string
  finalPath: string
  /** Expected OUTPUT duration (after silence removal). */
  expectedDuration: number
  args: string[]
  hasCaptions: boolean
  hasAudio: boolean
  encoder: string
  target: { w: number; h: number }
  quality: QualityPreset
  fps: number
  segments: number
  /** Video codec actually used (for validation). */
  codec: string
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
    splits: clip.captionCueSplits,
    merges: clip.captionCueMerges,
    timingOffsets: clip.captionTimingOffsets,
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

/**
 * Output frame rate. 'source' follows the project's measured fps and falls
 * back to 30 when unknown — a fixed fps filter also guarantees CFR output
 * for VFR sources (phone recordings, screen captures) (§57-58).
 */
export function effectiveFps(clip: Clip, project: Project): number {
  if (clip.outputFps !== 'source' && Number.isFinite(clip.outputFps)) {
    return Math.min(120, Math.max(1, clip.outputFps))
  }
  const src = project.fps
  if (src == null || !Number.isFinite(src) || src < 1 || src > 120) return 30
  return Math.round(src * 1000) / 1000
}

/** Bitrate for hardware encoders scales with output area × quality factor. */
export function hwBitrate(w: number, h: number, quality: QualityPreset): string {
  const mbps = Math.max(1, ((w * h) / (1920 * 1080)) * 8 * quality.hwBitrateFactor)
  return `${mbps.toFixed(1)}M`
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
    /** Fast low-quality preview render (draft, 720p). */
    preview?: boolean
  }
): RenderPlan {
  const { clip, project, encoder } = opts
  if (!project.sourcePath) {
    throw new AppError(
      'SOURCE_MISSING',
      'This project has no imported media to render from.',
      'Import a video first.'
    )
  }

  const aspect = ASPECT_RATIOS[clip.aspectRatio] ?? ASPECT_RATIOS['9:16']
  const resolutionTier = opts.preview ? '720p' : clip.outputResolution
  const target = resolutionFor(clip.aspectRatio, resolutionTier as Clip['outputResolution'])
  const quality = getQualityPreset(opts.preview ? 'draft' : clip.outputQuality)
  const fps = effectiveFps(clip, project)

  const rendersDir = path.join(ctx.projectDir(clip.projectId), 'renders')
  fs.mkdirSync(rendersDir, { recursive: true })

  const tmpPath = path.join(rendersDir, `${opts.renderId}.tmp.mp4`)
  const finalPath = path.join(rendersDir, `${opts.renderId}.mp4`)

  // ---- kept segments (silence removal) ----
  const kept = keptSegments(clip.startTime, clip.endTime, clip.silenceCuts ?? [])
  const multiSegment =
    kept.length > 1 ||
    kept[0].start > clip.startTime + 0.001 ||
    kept[kept.length - 1].end < clip.endTime - 0.001 ||
    (clip.cropMode === 'smart' && (clip.smartCropKeyframes?.length ?? 0) > 1)
  const outputDuration = Math.max(0.2, kept.length > 1 ? keptDuration(kept) : clip.endTime - clip.startTime)

  // ---- captions (shared cue construction; remapped for multi-segment) ----
  const cues = buildClipCues(ctx, clip)
  let assPath: string | null = null
  let assArg = ''
  if (cues.length > 0 && clip.captionStyleId !== 'none') {
    const style = getCaptionStyle(clip.captionStyleId)
    const o = clip.captionOverrides
    let renderCues = shiftCues(cues, -clip.startTime)
    if (multiSegment) {
      // Map source-time cues onto the kept timeline (§61)
      renderCues = remapCuesToKept(renderCues, kept.map((k) => ({ start: k.start - clip.startTime, end: k.end - clip.startTime })))
    }
    const ass = buildAssDocument(renderCues, {
      style,
      fontSizePct: o.fontSizePct,
      positionY: o.positionY,
      emphasis: o.emphasis,
      uppercase: o.uppercase,
      textColor: o.textColor,
      highlightColor: o.highlightColor,
      boxOpacity: o.boxOpacity,
      outlineWidth: o.outlineWidth,
      shadow: o.shadow,
      playResX: target.w,
      playResY: target.h
    })
    assPath = path.join(rendersDir, `${opts.renderId}.ass`)
    fs.writeFileSync(assPath, ass, 'utf-8')
    const fontsDir = ctx.paths.fontsDir
    assArg = `subtitles='${escapeFilterPath(assPath)}':fontsdir='${escapeFilterPath(fontsDir)}'`
  }

  // ---- reframe ----
  // Content-rect aware: baked-in bars are cropped off first, so a portrait
  // export of a bar-filled source FILLS the frame instead of shipping bars.
  const crop = computeCrop(
    project.width ?? 1920,
    project.height ?? 1080,
    target.w,
    target.h,
    clip.cropMode === 'smart' ? 'center' : clip.cropMode,
    clip.cropX,
    clip.zoom,
    project.contentRect
  )
  const frameW = project.width ?? 1920
  const frameH = project.height ?? 1080
  const contentIsFullFrame =
    !project.contentRect ||
    (project.contentRect.left === 0 && project.contentRect.top === 0 &&
      project.contentRect.width >= frameW - 2 && project.contentRect.height >= frameH - 2)

  const fitVf = contentIsFullFrame
    ? `fps=${fps},scale=${target.w}:${target.h}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${target.w}:${target.h}:(ow-iw)/2:(oh-ih)/2`
    : `fps=${fps},crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},scale=${target.w}:${target.h}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${target.w}:${target.h}:(ow-iw)/2:(oh-ih)/2`
  const fillVfFor = (c: { w: number; h: number; x: number; y: number }) =>
    `fps=${fps},crop=${c.w}:${c.h}:${c.x}:${c.y},scale=${target.w}:${target.h}:flags=lanczos`
  const isFit = clip.cropMode === 'fit'
  // Render segments: silence-kept ranges, further split at smart-crop shot
  // boundaries so each segment carries its own crop window (§25, §28).
  interface RenderSegment extends TimeSegment {
    crop: { w: number; h: number; x: number; y: number }
  }
  const renderSegments: RenderSegment[] = []
  const keyframes = clip.cropMode === 'smart' ? clip.smartCropKeyframes ?? [] : []
  for (const k of kept) {
    if (keyframes.length === 0) {
      renderSegments.push({ ...k, crop })
      continue
    }
    // split the kept range at every keyframe boundary inside it
    const cuts: number[] = []
    for (const kf of keyframes) {
      if (kf.start > k.start + 0.05 && kf.start < k.end - 0.05) cuts.push(kf.start)
      if (kf.end > k.start + 0.05 && kf.end < k.end - 0.05) cuts.push(kf.end)
    }
    const points = [k.start, ...cuts.sort((a, b) => a - b), k.end]
    for (let i = 0; i < points.length - 1; i++) {
      const s = points[i]
      const e = points[i + 1]
      if (e - s < 0.04) continue
      const win = smartWindowAt(s + (e - s) / 2, keyframes, crop)
      renderSegments.push({ start: s, end: e, crop: win })
    }
  }

  // ---- audio ----
  const hasAudio = project.hasAudio
  const audioNormalize = opts.settings.video.audioNormalize

  // ---- encoder ----
  // H.264 is the everywhere-safe default; HEVC (libx265) is opt-in (§60).
  // Hardware encoders are h264-only — HEVC renders always use software.
  const wantsHevc = opts.settings.video.codec === 'hevc' && !opts.preview
  const isHw = encoder !== 'libx264' && !wantsHevc
  const encoderArgs = isHw
    ? ['-c:v', encoder, '-b:v', hwBitrate(target.w, target.h, quality)]
    : wantsHevc
      ? ['-c:v', 'libx265', '-crf', String(Math.min(40, quality.crf + 4)), '-preset', quality.x264Preset, '-tag:v', 'hvc1']
      : ['-c:v', 'libx264', '-crf', String(quality.crf), '-preset', quality.x264Preset]

  const commonTail = [
    ...encoderArgs,
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-progress', 'pipe:1',
    '-nostats',
    tmpPath
  ]

  const useMultiPath = renderSegments.length > 1
  // Single-segment renders (incl. smart with one keyframe) use that segment's crop.
  const simpleVf = isFit ? fitVf : fillVfFor(renderSegments[0]?.crop ?? crop)
  let args: string[]
  if (!useMultiPath) {
    // Simple path: single -ss/-t with a -vf chain.
    const vf = assArg ? `${simpleVf},${assArg}` : simpleVf
    const audioArgs = hasAudio
      ? audioNormalize
        ? ['-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000']
        : ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000']
      : ['-an']
    const only = renderSegments[0] ?? { start: clip.startTime, end: clip.endTime }
    args = [
      '-y',
      '-ss', only.start.toFixed(3),
      '-i', project.sourcePath,
      '-t', (only.end - only.start).toFixed(3),
      '-vf', vf,
      ...audioArgs,
      ...commonTail
    ]
  } else {
    // Multi-segment: one input per render segment, filter_complex concat.
    // Segments carry their own crop (smart-crop shot windows) and/or their
    // own time range (silence removal).
    const inputs: string[] = []
    for (const seg of renderSegments) {
      inputs.push(
        '-ss', seg.start.toFixed(3),
        '-t', (seg.end - seg.start).toFixed(3),
        '-i', project.sourcePath
      )
    }
    const n = renderSegments.length
    const chains: string[] = []
    for (let i = 0; i < n; i++) {
      const vf = isFit ? fitVf : fillVfFor(renderSegments[i].crop)
      chains.push(`[${i}:v]${vf}[v${i}]`)
    }
    chains.push(`${Array.from({ length: n }, (_, i) => `[v${i}]`).join('')}concat=n=${n}:v=1:a=0[vc]`)
    if (assArg) chains.push(`[vc]${assArg}[vout]`)
    const videoOut = assArg ? '[vout]' : '[vc]'

    const maps: string[] = ['-map', videoOut]
    if (hasAudio) {
      for (let i = 0; i < n; i++) {
        chains.push(`[${i}:a]aresample=48000:async=1:first_pts=0[a${i}]`)
      }
      chains.push(`${Array.from({ length: n }, (_, i) => `[a${i}]`).join('')}concat=n=${n}:v=0:a=1[ac]`)
      if (audioNormalize) chains.push('[ac]loudnorm=I=-16:TP=-1.5:LRA=11[aout]')
      maps.push('-map', audioNormalize ? '[aout]' : '[ac]', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000')
    } else {
      maps.push('-an')
    }

    args = [
      '-y',
      ...inputs,
      '-filter_complex', chains.join(';'),
      ...maps,
      ...commonTail
    ]
  }

  return {
    renderId: opts.renderId,
    clipId: clip.id,
    sourcePath: project.sourcePath,
    assPath,
    tmpPath,
    finalPath,
    expectedDuration: outputDuration,
    args,
    hasCaptions: cues.length > 0,
    hasAudio,
    encoder,
    target,
    quality,
    fps,
    segments: renderSegments.length,
    codec: wantsHevc ? 'hevc' : 'h264'
  }
}

/** Effective hardware-encoding mode with legacy-setting migration. */
export function encoderMode(settings: AppSettings): 'auto' | 'cpu' | 'hardware' {
  if (settings.video.hardwareEncoding) return settings.video.hardwareEncoding
  return settings.video.useHardwareEncoder ? 'auto' : 'cpu'
}

/** Choose encoder based on settings + probed availability. */
export function pickEncoder(settings: AppSettings, availableEncoders: string[] | null): string {
  const mode = encoderMode(settings)
  if (mode === 'cpu') return 'libx264'
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
