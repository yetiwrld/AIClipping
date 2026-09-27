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
}

interface FfprobeStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  avg_frame_rate?: string
  r_frame_rate?: string
  side_data_list?: Array<{ rotation?: number }>
  tags?: Record<string, string>
}

interface FfprobeOutput {
  streams?: FfprobeStream[]
  format?: { duration?: string; size?: string }
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
    rotation
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
