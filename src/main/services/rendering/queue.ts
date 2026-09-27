import fs from 'node:fs'
import path from 'node:path'
import { AppError, toStructuredError } from '@shared/errors'
import type { RenderJob, StructuredError } from '@shared/types'
import type { AppContext } from '../app-context'
import { clipsRepo, projectsRepo, rendersRepo, tasksRepo } from '../database/repositories'
import { getSettings } from '../settings'
import { getBinaries } from '../media/inspect'
import { runProcess } from '../media/ffmpeg'
import { generateThumbnail } from '../media/thumbnails'
import { buildRenderPlan, encoderMode, pickEncoder, probeEncoders, type RenderPlan } from './plan'
import { estimateRenderSizeMb, getQualityPreset, resolutionFor } from '@shared/constants'
import { keptSegments, keptDuration } from '@shared/video/segments'

/**
 * Render queue: persisted jobs, streaming progress, cancellation, retry,
 * atomic output finalization, and stage-attributed failure reports.
 * Concurrency is configurable (default 1) — heavy renders are never launched
 * in parallel by accident (spec §28).
 */

interface RunningJob {
  controller: AbortController
}

export class RenderQueue {
  private running = new Map<string, RunningJob>()
  private waitQueue: string[] = []
  private encoderCache: { mode: string; encoder: string; encoders: string[] } | null = null

  constructor(private ctx: AppContext) {}

  get concurrency(): number {
    const settings = getSettings(this.ctx)
    return Math.min(4, Math.max(1, settings.advanced.renderConcurrency))
  }

  async queueRender(clipId: string, preview = false): Promise<string> {
    const clip = clipsRepo.get(this.ctx.db, clipId)
    if (!clip) throw new AppError('CLIP_NOT_FOUND', 'That clip no longer exists.')
    const project = projectsRepo.get(this.ctx.db, clip.projectId)
    if (!project?.sourcePath) {
      throw new AppError('SOURCE_MISSING', 'This project has no imported media.', 'Import a video before rendering.')
    }

    // Disk-space pre-check (§73): estimate the output size (×2.5 safety for
    // intermediate files) and refuse early rather than failing mid-render.
    const kept = keptSegments(clip.startTime, clip.endTime, clip.silenceCuts ?? [])
    const seconds = Math.max(0.5, keptDuration(kept))
    const tier = preview ? '720p' : clip.outputResolution
    const quality = preview ? 'draft' : clip.outputQuality
    const estimateMb = estimateRenderSizeMb(clip.aspectRatio, tier as '720p', quality, seconds)
    const free = freeDiskBytes(this.ctx.workspaceRoot)
    if (free !== null && free < estimateMb * 2.5 * 1024 * 1024) {
      throw new AppError(
        'DISK_FULL',
        `Not enough disk space to render (about ${estimateMb} MB needed, ${(free / (1024 * 1024)).toFixed(0)} MB free).`,
        'Free up space on the drive holding the workspace and try again.'
      )
    }

    const renderId = crypto.randomUUID()
    const settings = getSettings(this.ctx)
    const { w, h } = resolutionFor(clip.aspectRatio, tier as '720p')
    rendersRepo.create(this.ctx.db, renderId, clipId, clip.projectId, {
      aspectRatio: clip.aspectRatio,
      cropMode: clip.cropMode,
      captionStyleId: clip.captionStyleId,
      resolution: tier,
      quality,
      fps: clip.outputFps,
      crf: getQualityPreset(quality).crf,
      preset: getQualityPreset(quality).x264Preset,
      startTime: clip.startTime,
      endTime: clip.endTime,
      silenceCuts: clip.silenceCuts?.length ?? 0,
      smartCropKeyframes: clip.smartCropKeyframes?.length ?? 0,
      hardwareEncoding: encoderMode(settings),
      codec: settings.video.codec
    }, preview)
    tasksRepo.create(this.ctx.db, { id: renderId, type: 'render', projectId: clip.projectId, payload: { clipId, preview } })

    this.waitQueue.push(renderId)
    this.pump()
    return renderId
  }

  async retry(renderId: string): Promise<RenderJob> {
    const render = rendersRepo.get(this.ctx.db, renderId)
    if (!render) throw new AppError('RENDER_NOT_FOUND', 'That render job no longer exists.')
    if (this.running.has(renderId)) return render
    rendersRepo.update(this.ctx.db, renderId, {
      status: 'queued',
      progress: 0,
      stage: null,
      error: null,
      startedAt: null,
      completedAt: null
    })
    this.publish({ ...render, status: 'queued', progress: 0, error: null })
    this.waitQueue.push(renderId)
    this.pump()
    return rendersRepo.get(this.ctx.db, renderId) as RenderJob
  }

  async cancel(renderId: string): Promise<void> {
    const job = this.running.get(renderId)
    if (job) {
      job.controller.abort()
      return
    }
    const idx = this.waitQueue.indexOf(renderId)
    if (idx !== -1) {
      this.waitQueue.splice(idx, 1)
      rendersRepo.update(this.ctx.db, renderId, { status: 'cancelled', stage: null })
      const render = rendersRepo.get(this.ctx.db, renderId)
      if (render) this.publish(render)
    }
  }

  list(projectId?: string): RenderJob[] {
    return rendersRepo.list(this.ctx.db, projectId)
  }

  /** Called at startup: in-flight renders from a previous session. */
  startupRecovery(): number {
    const interrupted = rendersRepo.findInterrupted(this.ctx.db)
    for (const render of interrupted) {
      const error: StructuredError = {
        code: 'INTERRUPTED',
        message: 'This render was interrupted when the application closed.',
        hint: 'The output was not finalized, so no corrupt file was kept. Retry to render it again.'
      }
      rendersRepo.update(this.ctx.db, render.id, { status: 'failed', error, stage: null })
      this.cleanupTemp(render.id, render.projectId)
    }
    return interrupted.length
  }

  private cleanupTemp(renderId: string, projectId: string): void {
    const dir = path.join(this.ctx.projectDir(projectId), 'renders')
    for (const suffix of ['.tmp.mp4', '.ass']) {
      const p = path.join(dir, `${renderId}${suffix}`)
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p)
      } catch {
        /* best effort */
      }
    }
  }

  private pump(): void {
    while (this.running.size < this.concurrency && this.waitQueue.length > 0) {
      const renderId = this.waitQueue.shift() as string
      void this.execute(renderId).catch((err) => {
        this.ctx.logger.error('render', 'queue.execute', `render=${renderId} crashed`, String(err))
      })
    }
  }

  private publish(render: RenderJob): void {
    this.ctx.events.publish({ type: 'render:state', render })
  }

  private async execute(renderId: string): Promise<void> {
    const ctx = this.ctx
    const controller = new AbortController()
    this.running.set(renderId, { controller })

    let stage = 'preparing'
    const setStage = (s: string) => {
      stage = s
    }

    try {
      const render = rendersRepo.get(ctx.db, renderId)
      if (!render) return
      const clip = clipsRepo.get(ctx.db, render.clipId)
      const project = projectsRepo.get(ctx.db, render.projectId)
      if (!clip || !project) {
        throw new AppError('CLIP_NOT_FOUND', 'The clip for this render no longer exists.')
      }

      rendersRepo.update(ctx.db, renderId, { status: 'preparing', stage: 'preparing', startedAt: new Date().toISOString() })
      tasksRepo.update(ctx.db, renderId, { state: 'running', stage: 'preparing', message: 'Preparing render' })
      this.publish({ ...render, status: 'preparing' })

      const settings = getSettings(ctx)
      const { ffmpeg, ffprobe } = await getBinaries(ctx)
      setStage('preparing')
      const mode = encoderMode(settings)
      if (!this.encoderCache || this.encoderCache.mode !== mode) {
        let encoders: string[] = []
        try {
          encoders = await probeEncoders(ffmpeg.path, (bin, args) => runProcess(bin, args, { timeoutMs: 15000 }))
        } catch {
          encoders = []
        }
        this.encoderCache = { mode, encoder: pickEncoder(settings, encoders), encoders }
      }
      const encoder = this.encoderCache.encoder
      if (mode === 'hardware' && encoder === 'libx264') {
        throw new AppError(
          'HW_ENCODER_UNAVAILABLE',
          'Hardware encoding is enabled but no hardware encoder was found on this system.',
          'Switch Settings → Video → Encoder to "Auto" or "CPU" and render again.',
          this.encoderCache.encoders.filter((e) => e.includes('h264')).slice(0, 12).join(', ')
        )
      }

      let plan: RenderPlan
      try {
        plan = buildRenderPlan(ctx, { renderId, clip, project, settings, ffmpegPath: ffmpeg.path, encoder, preview: render.preview })
      } catch (err) {
        if (err instanceof AppError && err.code === 'SOURCE_MISSING') throw err
        throw new AppError('RENDER_PLAN_FAILED', 'The render could not be prepared.', undefined, String(err))
      }

      setStage('encoding')
      rendersRepo.update(ctx.db, renderId, { status: 'rendering', stage: 'encoding', progress: 0 })
      this.publish({ ...render, status: 'rendering', progress: 0, stage: 'encoding' })

      let lastDbUpdate = 0
      let lastEvent = 0
      let lastErrorChunk = ''

      const { code, stderr } = await runProcess(ffmpeg.path, plan.args, {
        signal: controller.signal,
        timeoutMs: 30 * 60 * 1000,
        onStdout: (chunk) => {
          const m = chunk.match(/out_time_us=(\d+)/g)
          if (!m || m.length === 0) return
          const last = m[m.length - 1]
          const us = parseInt(last.split('=')[1], 10)
          const seconds = us / 1e6
          const progress = Math.min(0.99, Math.max(0, seconds / plan.expectedDuration))
          const now = Date.now()
          if (now - lastEvent > 250) {
            lastEvent = now
            ctx.events.publish({
              type: 'render:progress',
              renderId,
              clipId: clip.id,
              projectId: clip.projectId,
              progress,
              stage: 'encoding'
            })
          }
          if (now - lastDbUpdate > 1000) {
            lastDbUpdate = now
            rendersRepo.update(ctx.db, renderId, { progress })
            tasksRepo.update(ctx.db, renderId, { state: 'running', progress, stage: 'encoding', message: 'Encoding video' })
          }
        },
        onStderr: (chunk) => {
          lastErrorChunk = (lastErrorChunk + chunk).slice(-4000)
        }
      })

      if (controller.signal.aborted) {
        throw new AppError('RENDER_CANCELLED', 'The render was cancelled.')
      }
      if (code !== 0 || !fs.existsSync(plan.tmpPath)) {
        throw mapFfmpegFailure(code, stderr || lastErrorChunk, stage, plan)
      }

      // Finalize atomically
      setStage('finalizing')
      if (fs.existsSync(plan.finalPath)) fs.unlinkSync(plan.finalPath)
      fs.renameSync(plan.tmpPath, plan.finalPath)

      // Output validation (§77-78): ffprobe the finalized file and verify
      // geometry, duration and frame rate. A silent bad output is worse than
      // a loud failure — corrupt files are never reported as success.
      setStage('validating')
      rendersRepo.update(ctx.db, renderId, { stage: 'validating' })
      await validateRenderOutput(ffprobe.path, plan)

      // Clip thumbnail from the rendered file
      try {
        await generateThumbnail(ffmpeg.path, plan.finalPath, path.join(ctx.projectDir(clip.projectId), 'thumbnails', `clip-${clip.id}.jpg`), { at: 0.5, height: 640 })
      } catch {
        /* non-fatal */
      }

      if (plan.assPath) {
        try {
          fs.unlinkSync(plan.assPath)
        } catch { /* best effort */ }
      }

      rendersRepo.update(ctx.db, renderId, {
        status: 'completed',
        progress: 1,
        stage: null,
        outputPath: plan.finalPath,
        completedAt: new Date().toISOString()
      })
      tasksRepo.update(ctx.db, renderId, { state: 'completed', progress: 1, message: 'Render complete' })
      clipsRepo.update(ctx.db, clip.id, { status: 'rendered' })

      const finalRender = rendersRepo.get(ctx.db, renderId)
      if (finalRender) this.publish(finalRender)
      ctx.logger.info('render', 'completed', `render=${renderId} encoder=${encoder} out=${plan.finalPath}`)
    } catch (err) {
      const structured = toStructuredError(err)
      const cancelled =
        controller.signal.aborted || structured.code === 'RENDER_CANCELLED' || structured.code === 'PROCESS_CANCELLED'
      // If the hardware encoder path failed, offer (and attempt) CPU fallback
      const render = rendersRepo.get(ctx.db, renderId)
      const usedHw = this.encoderCache && this.encoderCache.encoder !== 'libx264'
      const fallbackAllowed = this.encoderCache ? this.encoderCache.mode === 'auto' : true
      if (usedHw && fallbackAllowed && !cancelled && render) {
        ctx.logger.warn('render', 'hw.fallback', `hardware encoder failed, retrying with CPU (${structured.code})`)
        this.encoderCache = { mode: 'auto', encoder: 'libx264', encoders: [] }
        rendersRepo.update(ctx.db, renderId, { status: 'queued', progress: 0, stage: null, error: null })
        this.waitQueue.push(renderId)
      } else {
        this.cleanupTemp(renderId, render?.projectId ?? '')
        rendersRepo.update(ctx.db, renderId, {
          status: cancelled ? 'cancelled' : 'failed',
          error: structured,
          stage
        })
        tasksRepo.update(ctx.db, renderId, {
          state: cancelled ? 'cancelled' : 'failed',
          error: structured,
          message: cancelled ? 'Render cancelled' : `Render failed at stage: ${stage}`
        })
        const updated = rendersRepo.get(ctx.db, renderId)
        if (updated) this.publish(updated)
        ctx.logger.error('render', 'failed', `render=${renderId} stage=${stage} code=${structured.code}`, structured.details)
      }
    } finally {
      this.running.delete(renderId)
      this.pump()
    }
  }
}

function mapFfmpegFailure(code: number, stderr: string, stage: string, plan: RenderPlan): AppError {
  const tail = stderr.slice(-2500)
  // missing input must be detected before font messages — libconfig noise can
  // appear in the same stderr even when the real failure is a missing file
  if (/no such file or directory/i.test(stderr)) {
    return new AppError(
      'SOURCE_MISSING',
      'A file needed by this render is missing.',
      'The imported source may have been moved or deleted. Re-import the original video and try again.',
      tail
    )
  }
  if (/no space left on device/i.test(stderr)) {
    return new AppError('DISK_FULL', 'Rendering ran out of disk space.', 'Free up space (Settings → Storage shows usage) and retry.', tail)
  }
  if (/unknown filter|no such filter|failed to load subtitle/i.test(stderr)) {
    return new AppError('FFMPEG_NO_SUBTITLES', 'This FFmpeg build does not support burned-in subtitles.', 'Install a full FFmpeg build (with libass) and point Settings → Advanced to it, or render without captions.', tail)
  }
  if (/permission denied/i.test(stderr)) {
    return new AppError('PERMISSION_DENIED', 'FFmpeg could not write to the renders folder.', 'Check folder permissions for the workspace.', tail)
  }
  if (/invalid data found|moov atom not found/i.test(stderr)) {
    return new AppError('SOURCE_CORRUPT', 'The source media appears corrupt or unreadable.', 'Re-import the original file.', tail)
  }
  if (/fontselect|fontconfig|glyph/i.test(stderr)) {
    return new AppError('FONT_ERROR', 'Caption rendering hit a font problem.', 'The bundled font may be missing — reinstall the app, or pick another caption style.', tail)
  }
  return new AppError(
    'RENDER_FAILED',
    `Rendering failed while ${stage === 'encoding' ? 'encoding the video' : `in the ${stage} stage`}.`,
    'Check the technical details below. Common causes: unsupported codec, missing font, insufficient disk space.',
    tail
  )
}

/** Best-effort free-space probe for the drive holding `dirPath`. */
export function freeDiskBytes(dirPath: string): number | null {
  try {
    const statfs = (fs as unknown as { statfsSync?: (p: string) => { bsize: number; bavail: number } }).statfsSync
    if (typeof statfs === 'function') {
      const s = statfs(dirPath)
      return s.bsize * s.bavail
    }
  } catch {
    /* unavailable or unsupported — skip the check */
  }
  return null
}

interface ProbeStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  avg_frame_rate?: string
}

/**
 * Verify the rendered file with FFprobe: video stream present, exact target
 * dimensions (±2px), duration within ±1.5s, and frame rate near the plan.
 * Deletes the bad output so it can never be mistaken for a good render.
 */
async function validateRenderOutput(ffprobePath: string, plan: RenderPlan): Promise<void> {
  const res = await runProcess(
    ffprobePath,
    ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,avg_frame_rate', '-show_entries', 'format=duration', '-of', 'json', plan.finalPath],
    { timeoutMs: 30_000 }
  )
  if (res.code !== 0) {
    safeUnlink(plan.finalPath)
    throw new AppError(
      'RENDER_VALIDATION_FAILED',
      'The rendered file could not be verified.',
      'FFprobe could not read the output. Retry the render; if it keeps failing, check the logs.',
      res.stderr.slice(-1500)
    )
  }
  let parsed: { streams?: ProbeStream[]; format?: { duration?: string } }
  try {
    parsed = JSON.parse(res.stdout)
  } catch {
    safeUnlink(plan.finalPath)
    throw new AppError('RENDER_VALIDATION_FAILED', 'The render verification returned unreadable data.', 'Retry the render.')
  }
  const video = (parsed.streams ?? []).find((s) => s.codec_type === 'video')
  const problems: string[] = []
  if (!video) problems.push('no video stream found')
  else {
    if (video.codec_name && video.codec_name !== plan.codec) {
      problems.push(`video codec ${video.codec_name} but expected ${plan.codec}`)
    }
    if (video.width == null || video.height == null) problems.push('missing dimensions')
    else if (Math.abs(video.width - plan.target.w) > 2 || Math.abs(video.height - plan.target.h) > 2) {
      problems.push(`dimensions ${video.width}x${video.height} but expected ${plan.target.w}x${plan.target.h}`)
    }
    const fr = video.avg_frame_rate
    if (fr && fr !== '0/0') {
      const [num, den] = fr.split('/').map(Number)
      if (den > 0 && Math.abs(num / den - plan.fps) > 1.5) {
        problems.push(`frame rate ${(num / den).toFixed(2)} but expected ${plan.fps}`)
      }
    }
  }
  const dur = parseFloat(parsed.format?.duration ?? '')
  if (!Number.isFinite(dur)) problems.push('no duration reported')
  else if (Math.abs(dur - plan.expectedDuration) > 1.5) {
    problems.push(`duration ${dur.toFixed(2)}s but expected ${plan.expectedDuration.toFixed(2)}s`)
  }
  if (problems.length > 0) {
    safeUnlink(plan.finalPath)
    throw new AppError(
      'RENDER_VALIDATION_FAILED',
      `The rendered file failed verification: ${problems.join('; ')}.`,
      'The file was discarded. Retry the render — if the problem repeats, reduce the output resolution or check the source file.',
      problems.join('; ')
    )
  }
}

function safeUnlink(p: string): void {
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p)
  } catch {
    /* best effort */
  }
}
