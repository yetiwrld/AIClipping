import fs from 'node:fs'
import path from 'node:path'
import { AppError } from '@shared/errors'
import { resolveFfmpeg, resolveFfprobe, runProcess, type BinaryInfo } from './ffmpeg'
import type { AppContext } from '../app-context'
import { getSettings } from '../settings'

/**
 * Media inspection via ffprobe. Validates before anything downstream runs:
 * existence, video stream presence, audio presence, duration, rotation.
 */

export interface MediaInfo {
  duration: number
  width: number
  height: number
  fps: number
  hasAudio: boolean
  hasVideo: boolean
  videoCodec: string | null
  audioCodec: string | null
  sizeBytes: number
  rotation: number
  /** Extra probe facts for the playback diagnostics panel (§9). */
  pixelFormat: string | null
  sampleRate: number | null
  channels: number | null
  container: string | null
}

export interface ContentRect {
  left: number
  top: number
  width: number
  height: number
}

interface FfprobeStream {
  codec_type?: string
  codec_name?: string
  pix_fmt?: string
  sample_rate?: number
  channels?: number
  width?: number
  height?: number
  avg_frame_rate?: string
  r_frame_rate?: string
  side_data_list?: Array<{ rotation?: number }>
  tags?: Record<string, string>
}

interface FfprobeOutput {
  streams?: FfprobeStream[]
  format?: { duration?: string; size?: string; format_name?: string }
}

export interface MediaBinaries {
  ffmpeg: BinaryInfo
  ffprobe: BinaryInfo
}

export async function getBinaries(ctx: AppContext): Promise<MediaBinaries> {
  const advanced = getSettings(ctx).advanced
  const ffmpegPath = advanced.ffmpegPath
  const ffprobePath = advanced.ffprobePath
  const ffmpeg = await resolveFfmpeg(ffmpegPath)
  const ffprobe = await resolveFfprobe(ffprobePath)
  if (!ffmpeg) {
    throw new AppError(
      'FFMPEG_NOT_FOUND',
      'FFmpeg could not be found on this system.',
      'Set a path in Settings → Advanced, install FFmpeg on your PATH, or reinstall the app so the bundled FFmpeg is restored.'
    )
  }
  if (!ffprobe) {
    throw new AppError(
      'FFPROBE_NOT_FOUND',
      'FFprobe could not be found on this system.',
      'Set a path in Settings → Advanced, install FFmpeg on your PATH, or reinstall the app so the bundled FFprobe is restored.'
    )
  }
  return { ffmpeg, ffprobe }
}

export async function inspectMedia(ffprobePath: string, filePath: string): Promise<MediaInfo> {
  if (!fs.existsSync(filePath)) {
    throw new AppError('FILE_NOT_FOUND', `The file "${path.basename(filePath)}" does not exist.`, 'Check the file location and try importing again.')
  }
  const stat = fs.statSync(filePath)
  if (!stat.isFile()) {
    throw new AppError('NOT_A_FILE', 'The selected path is not a file.')
  }
  if (stat.size === 0) {
    throw new AppError('EMPTY_FILE', 'The selected file is empty (0 bytes).', 'The file may not have finished downloading. Try again with the complete file.')
  }

  const { code, stdout, stderr } = await runProcess(ffprobePath, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath
  ])
  if (code !== 0) {
    throw new AppError(
      'FFPROBE_FAILED',
      `"${path.basename(filePath)}" could not be read as media.`,
      'The file may be corrupt, incomplete, or use a codec FFmpeg cannot read. Try re-exporting the video or using a different file.',
      stderr.slice(-2000)
    )
  }

  let parsed: FfprobeOutput
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new AppError('FFPROBE_BAD_OUTPUT', 'FFprobe returned unreadable output for this file.', undefined, stdout.slice(500))
  }

  const streams = parsed.streams ?? []
  const video = streams.find((s) => s.codec_type === 'video')
  const audio = streams.find((s) => s.codec_type === 'audio')
  if (!video) {
    throw new AppError(
      'NO_VIDEO_STREAM',
      `"${path.basename(filePath)}" does not contain a video track.`,
      'This may be an audio-only file. Import a video file, or use an audio format intentionally.'
    )
  }

  const duration = parseFloat(parsed.format?.duration ?? '0')
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new AppError('NO_DURATION', 'The media duration could not be determined.', 'The container may be broken. Try re-muxing the file.')
  }

  const fps = parseFps(video.avg_frame_rate) ?? parseFps(video.r_frame_rate) ?? 30
  let rotation = (video.side_data_list?.find((sd) => typeof sd.rotation === 'number')?.rotation ?? parseInt(video.tags?.rotate ?? '0', 10)) || 0
  rotation = ((rotation % 360) + 360) % 360

  // For 90/270 rotations, display dimensions swap
  const swap = rotation === 90 || rotation === 270
  const width = swap ? video.height ?? 0 : video.width ?? 0
  const height = swap ? video.width ?? 0 : video.height ?? 0

  return {
    duration,
    width,
    height,
    fps,
    hasAudio: Boolean(audio),
    hasVideo: true,
    videoCodec: video.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    sizeBytes: stat.size,
    rotation,
    pixelFormat: video.pix_fmt ?? null,
    sampleRate: audio?.sample_rate ?? null,
    channels: audio?.channels ?? null,
    container: parsed.format?.format_name?.split(',')[0] ?? null
  }
}

/**
 * Detect the real content area inside the frame (baked-in letterbox /
 * pillarbox bars) using FFmpeg cropdetect. Samples several points across the
 * duration; returns the rect only when the samples agree — conservative, so
 * dark scenes never trigger a false crop. Rotation ≠ 0/180 → null (decoded
 * vs display coordinates differ; never guess).
 */
export async function detectContentRect(
  ffmpegPath: string,
  filePath: string,
  duration: number,
  frameWidth: number,
  frameHeight: number,
  rotation: number
): Promise<ContentRect | null> {
  if (rotation !== 0 && rotation !== 180) return null
  if (duration < 2 || frameWidth < 16 || frameHeight < 16) return null

  const samples = [0.1, 0.3, 0.5, 0.7, 0.9]
    .map((f) => Math.min(duration - 0.2, Math.max(0, duration * f)))
    .filter((t, idx, arr) => arr.indexOf(t) === idx)

  const rects: ContentRect[] = []
  for (const t of samples) {
    try {
      const res = await runProcess(ffmpegPath, [
        '-hide_banner', '-nostats',
        '-ss', t.toFixed(3),
        '-i', filePath,
        '-frames:v', '6',
        '-vf', 'cropdetect=limit=24:round=2',
        '-f', 'rawvideo', '-pix_fmt', 'gray',
        '-'
      ], { timeoutMs: 30_000 })
      // cropdetect reports on stderr; take the last reported rect
      const crops = [...(res.stderr + res.stdout).matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)]
      const last = crops[crops.length - 1]
      if (!last) continue
      const [, w, h, x, y] = last.map((v) => parseInt(v, 10))
      if (w >= 16 && h >= 16) rects.push({ left: x, top: y, width: w, height: h })
    } catch {
      /* sampling failure on one point is fine */
    }
  }
  if (rects.length < Math.ceil(samples.length * 0.6)) return null

  // consensus: rects within 2px of the median area/position
  const same = (a: ContentRect, b: ContentRect) =>
    Math.abs(a.left - b.left) <= 2 && Math.abs(a.top - b.top) <= 2 &&
    Math.abs(a.width - b.width) <= 2 && Math.abs(a.height - b.height) <= 2
  let best: ContentRect | null = null
  let bestCount = 0
  for (const r of rects) {
    const count = rects.filter((o) => same(r, o)).length
    if (count > bestCount) {
      best = r
      bestCount = count
    }
  }
  if (!best || bestCount < Math.ceil(rects.length * 0.6)) return null

  // meaningful only when bars actually exist (≥ 2% of a dimension)
  const barX = best.left + (frameWidth - best.left - best.width)
  const barY = best.top + (frameHeight - best.top - best.height)
  if (barX < frameWidth * 0.02 && barY < frameHeight * 0.02) {
    return { left: 0, top: 0, width: frameWidth, height: frameHeight } // no bars
  }
  // even dimensions for yuv420p; cropdetect (round=2) can round x down past
  // the frame edge, so clamp the rect into the frame before returning.
  const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2)
  const left = Math.min(even(best.left), even(frameWidth) - 2)
  const top = Math.min(even(best.top), even(frameHeight) - 2)
  return {
    left,
    top,
    width: Math.min(even(best.width), even(frameWidth) - left),
    height: Math.min(even(best.height), even(frameHeight) - top)
  }
}

function parseFps(rate?: string): number | null {
  if (!rate) return null
  const m = rate.match(/^(\d+)\/(\d+)$/)
  if (m && parseInt(m[2], 10) > 0) {
    const fps = parseInt(m[1], 10) / parseInt(m[2], 10)
    return Number.isFinite(fps) && fps > 0 ? Math.round(fps * 1000) / 1000 : null
  }
  if (/^\d+(\.\d+)?$/.test(rate)) return parseFloat(rate)
  return null
}

/** Supported media extensions for the import dialog. */
export const SUPPORTED_MEDIA_EXTENSIONS = ['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.mpg', '.mpeg', '.wmv', '.flv', '.mp3', '.m4a', '.wav', '.aac', '.ogg', '.flac']

export function isSupportedMediaFile(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase()
  return SUPPORTED_MEDIA_EXTENSIONS.includes(ext)
}
