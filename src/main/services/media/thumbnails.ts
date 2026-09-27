import fs from 'node:fs'
import path from 'node:path'
import { AppError } from '@shared/errors'
import { runProcess } from './ffmpeg'

/**
 * Thumbnail generation (source poster + clip posters) — real FFmpeg frames,
 * never placeholders.
 */

export async function generateThumbnail(
  ffmpegPath: string,
  sourcePath: string,
  outputPath: string,
  opts: { at?: number; height?: number } = {}
): Promise<string> {
  if (!fs.existsSync(sourcePath)) {
    throw new AppError('FILE_NOT_FOUND', 'Cannot generate a thumbnail: the source file is missing.')
  }
  const at = opts.at ?? 1
  const height = opts.height ?? 360
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  const tmp = `${outputPath}.tmp.jpg`
  const { code, stderr } = await runProcess(ffmpegPath, [
    '-y',
    '-ss', String(Math.max(0, at)),
    '-i', sourcePath,
    '-frames:v', '1',
    '-vf', `scale=-2:${height}`,
    '-q:v', '3',
    tmp
  ])
  if (code !== 0 || !fs.existsSync(tmp)) {
    throw new AppError(
      'THUMBNAIL_FAILED',
      'A thumbnail could not be generated for this video.',
      'The file may use a codec this FFmpeg build cannot decode. Playback and rendering may still work.',
      stderr.slice(-1500)
    )
  }
  fs.renameSync(tmp, outputPath)
  return outputPath
}

/** Extract the audio track to m4a — used before cloud transcription. */
export async function extractAudio(ffmpegPath: string, sourcePath: string, outputPath: string): Promise<string> {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  const tmp = `${outputPath}.tmp.m4a`
  const { code, stderr } = await runProcess(ffmpegPath, [
    '-y',
    '-i', sourcePath,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'aac',
    '-b:a', '96k',
    tmp
  ])
  if (code !== 0 || !fs.existsSync(tmp)) {
    throw new AppError(
      'AUDIO_EXTRACT_FAILED',
      'The audio track could not be extracted from this video.',
      'If the file has no audio, transcription cannot run on it.',
      stderr.slice(-1500)
    )
  }
  fs.renameSync(tmp, outputPath)
  return outputPath
}

export function thumbnailPathFor(ctx: { projectDir(id: string): string }, projectId: string, name: string): string {
  return path.join(ctx.projectDir(projectId), 'thumbnails', `${name}.jpg`)
}
