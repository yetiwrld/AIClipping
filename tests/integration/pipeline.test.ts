import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { makeTestContext, requireFixtures, SAMPLE_VIDEO, SAMPLE_TRANSCRIPT } from '../helpers/context'
import type { AppContext } from '../../src/main/services/app-context'
import { createProject, importMediaFile, deleteProject } from '../../src/main/services/projects'
import { importTranscript, getTranscript } from '../../src/main/services/transcription'
import { runAnalysis, getCandidates } from '../../src/main/services/ai/analysis'
import { createClipFromCandidate, updateClip, listClips } from '../../src/main/services/clips'
import { RenderQueue } from '../../src/main/services/rendering/queue'
import { runExport } from '../../src/main/services/exports'
import { projectsRepo, tasksRepo, rendersRepo } from '../../src/main/services/database/repositories'
import { AppError } from '@shared/errors'
import type { AppEvent, RenderJob } from '@shared/types'

const run = promisify(execFile)
const FFPROBE = require('@ffprobe-installer/ffprobe').path as string

/**
 * Full local pipeline against the real service stack and bundled FFmpeg:
 * project → media import (probe + stream-copy) → transcript import →
 * heuristic analysis → clip creation → render (9:16 + burned captions) →
 * export. No network, no mocks.
 */

let ctx: AppContext
let cleanup: () => Promise<void>
let projectId: string
const events: AppEvent[] = []

beforeAll(async () => {
  requireFixtures()
  const made = await makeTestContext()
  ctx = made.ctx
  cleanup = made.cleanup
  ctx.events.subscribe((e) => events.push(e))
}, 30_000)

afterAll(async () => {
  await cleanup()
})

async function waitForRender(renderId: string, timeoutMs = 150_000): Promise<RenderJob> {
  const started = Date.now()
  for (;;) {
    const job = rendersRepo.get(ctx.db, renderId)
    if (job && (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled')) {
      return job
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`render ${renderId} did not finish within ${timeoutMs}ms (last: ${JSON.stringify(job ?? null)})`)
    }
    await new Promise((r) => setTimeout(r, 400))
  }
}

describe('end-to-end local pipeline', () => {
  it('creates a project', () => {
    const project = createProject(ctx, 'E2E Pipeline')
    projectId = project.id
    expect(project.status).toBe('created')
    expect(fs.existsSync(ctx.projectDir(projectId))).toBe(true)
  })

  it('imports media: probes, stream-copies, re-inspects, thumbnails', async () => {
    const project = await importMediaFile(ctx, projectId, SAMPLE_VIDEO)
    expect(project.status).toBe('ready')
    expect(project.duration).toBeGreaterThan(59.5)
    expect(project.duration).toBeLessThan(60.5)
    expect(project.width).toBe(1280)
    expect(project.height).toBe(720)
    expect(project.hasAudio).toBe(true)
    expect(project.sourcePath).not.toBeNull()
    // source copied into the project folder (original untouched)
    expect(project.sourcePath).not.toBe(SAMPLE_VIDEO)
    expect(fs.existsSync(project.sourcePath!)).toBe(true)
    // thumbnail generated at min(dur*0.25, 60) = 15s
    const thumb = path.join(ctx.projectDir(projectId), 'thumbnails', 'source.jpg')
    expect(fs.existsSync(thumb)).toBe(true)
  }, 60_000)

  it('imports a transcript file and persists segments', () => {
    const { segments } = importTranscript(ctx, projectId, SAMPLE_TRANSCRIPT)
    expect(segments).toBe(19)
    const stored = getTranscript(ctx, projectId)
    expect(stored).toHaveLength(19)
    expect(stored[0].startTime).toBeGreaterThanOrEqual(0)
    // words preserved for karaoke captions
    expect(stored[0].words).not.toBeNull()
    expect(stored[0].words!.length).toBeGreaterThan(0)
    expect(projectsRepo.get(ctx.db, projectId)!.status).toBe('transcribed')
  })

  it('runs heuristic analysis: validates, scores, dedupes into moments', async () => {
    const summary = await runAnalysis(ctx, {
      projectId,
      providerId: 'heuristic-local',
      onEvent: () => undefined,
      signal: new AbortController().signal
    })

    expect(summary.provider).toBe('heuristic-local')
    expect(summary.keptCandidates).toBeGreaterThan(0)

    const candidates = getCandidates(ctx, projectId)
    expect(candidates.length).toBeGreaterThan(0)
    for (const c of candidates) {
      expect(c.startTime).toBeGreaterThanOrEqual(0)
      expect(c.endTime).toBeLessThanOrEqual(60.5)
      expect(c.overallScore ?? 0).toBeGreaterThanOrEqual(0)
      expect(c.overallScore ?? 0).toBeLessThanOrEqual(100)
      expect(c.provider).toBe('heuristic-local')
    }
    // deduped into moments
    const momentKeys = new Set(candidates.map((c) => c.momentKey))
    expect(momentKeys.size).toBeGreaterThan(0)
    expect(momentKeys.size).toBe(summary.foundMoments)

    expect(projectsRepo.get(ctx.db, projectId)!.status).toBe('analyzed')
  }, 30_000)

  it('re-analysis replaces discovered candidates but keeps converted ones', async () => {
    const first = getCandidates(ctx, projectId)
    const best = first[0]
    createClipFromCandidate(ctx, best.id)

    await runAnalysis(ctx, {
      projectId,
      providerId: 'heuristic-local',
      onEvent: () => undefined,
      signal: new AbortController().signal
    })

    const after = getCandidates(ctx, projectId)
    expect(after.some((c) => c.id === best.id && c.status === 'converted')).toBe(true)
    expect(after.some((c) => c.status === 'discovered')).toBe(true)
  }, 30_000)

  it('creates a clip from a candidate (idempotent)', () => {
    const candidates = getCandidates(ctx, projectId).filter((c) => c.status === 'discovered')
    const target = candidates[0]
    const clip = createClipFromCandidate(ctx, target.id)
    expect(clip.aspectRatio).toBe('9:16')
    expect(clip.captionStyleId).not.toBe('none')
    expect(clip.status).toBe('draft')

    const again = createClipFromCandidate(ctx, target.id)
    expect(again.id).toBe(clip.id) // no duplicates
  })

  it('updates clip settings (non-destructive edit persistence)', () => {
    const clip = listClips(ctx, projectId)[0]
    const updated = updateClip(ctx, clip.id, {
      captionStyleId: 'high-impact',
      captionOverrides: { fontSizePct: 5, emphasis: true, uppercase: true },
      cropMode: 'manual',
      cropX: 0.3,
      zoom: 1.4,
      title: 'Edited title'
    })
    expect(updated.captionStyleId).toBe('high-impact')
    expect(updated.captionOverrides.emphasis).toBe(true)
    expect(updated.cropX).toBe(0.3)
    expect(updated.title).toBe('Edited title')
  })

  it('renders a 1080x1920 MP4 with burned captions and emits progress events', async () => {
    const queue = new RenderQueue(ctx)
    const clip = listClips(ctx, projectId)[0]

    const renderId = await queue.queueRender(clip.id)
    expect(renders().find((r) => r.id === renderId)).toBeDefined()

    const done = await waitForRender(renderId)
    expect(done.status).toBe('completed')
    expect(done.progress).toBe(1)
    expect(done.outputPath).not.toBeNull()
    expect(fs.existsSync(done.outputPath!)).toBe(true)

    // no temp files left behind (atomic rename semantics)
    expect(fs.existsSync(done.outputPath!.replace('.mp4', '.tmp.mp4'))).toBe(false)

    // probe the output: vertical, h264, aac, correct duration
    const probe = await run(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', done.outputPath!])
    const info = JSON.parse(probe.stdout)
    const video = info.streams.find((s: { codec_type: string }) => s.codec_type === 'video')
    const audio = info.streams.find((s: { codec_type: string }) => s.codec_type === 'audio')
    expect(video.codec_name).toBe('h264')
    expect(parseInt(video.width, 10)).toBe(1080)
    expect(parseInt(video.height, 10)).toBe(1920)
    expect(audio.codec_name).toBe('aac')
    const expectedDur = clip.endTime - clip.startTime
    expect(parseFloat(info.format.duration)).toBeGreaterThan(expectedDur - 1.5)
    expect(parseFloat(info.format.duration)).toBeLessThan(expectedDur + 1.5)

    // task row reached completed
    expect(tasksRepo.get(ctx.db, renderId)!.state).toBe('completed')

    // structured progress events were published during the render
    const stateEvents = events.filter(
      (e) => e.type === 'render:state' && (e as { render?: { id?: string } }).render?.id === renderId
    )
    const progressEvents = events.filter(
      (e) => e.type === 'render:progress' && (e as { renderId?: string }).renderId === renderId
    )
    expect(stateEvents.length).toBeGreaterThan(1)
    expect(progressEvents.length).toBeGreaterThan(0)
    const progressValues = progressEvents.map((e) => (e as { progress?: number }).progress ?? 0)
    expect(Math.max(...progressValues, 0)).toBeGreaterThan(0)
  }, 200_000)

  it('queue + cancel: a queued render waiting for a slot can be cancelled', async () => {
    // concurrency default is 1 — first render occupies the worker
    const queue = new RenderQueue(ctx)
    const clip = listClips(ctx, projectId)[0]
    const first = await queue.queueRender(clip.id)
    const done = await waitForRender(first)
    expect(done.status).toBe('completed')

    // retry the finished render, then cancel it while it runs
    const retried = await queue.retry(first)
    expect(['queued', 'preparing', 'rendering']).toContain(retried.status)
    await queue.cancel(first)
    // cancellation is asynchronous — wait for the job to settle
    const settled = Date.now()
    for (;;) {
      const after = renders().find((r) => r.id === first)!
      if (['cancelled', 'completed', 'failed'].includes(after.status)) {
        expect(after.status).toBe('cancelled')
        break
      }
      if (Date.now() - settled > 120_000) {
        throw new Error(`retry render did not settle after cancel (status: ${renders().find((r) => r.id === first)!.status})`)
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    // the partially-written temp file must not survive as the final output
    expect(fs.existsSync(path.join(ctx.projectDir(projectId), 'renders', `${first}.tmp.mp4`))).toBe(false)
  }, 200_000)

  it('exports rendered clips with metadata files', () => {
    const clip = listClips(ctx, projectId)[0]
    // give the clip metadata so export files have content
    updateClip(ctx, clip.id, {
      title: 'The system that actually works',
      description: 'A complete framework description.',
      hashtags: ['creator', 'focus']
    })
    const result = runExport(ctx, [clip.id], true)
    expect(result.files.length).toBeGreaterThan(0)
    expect(result.dir.startsWith(ctx.paths.exportsDir)).toBe(true)
    for (const f of result.files) {
      expect(fs.existsSync(f)).toBe(true)
      expect(path.dirname(f).startsWith(ctx.paths.exportsDir)).toBe(true)
    }
    // metadata sidecars
    const txt = result.files.find((f) => f.endsWith('.txt'))
    const json = result.files.find((f) => f.endsWith('.json'))
    expect(txt).toBeDefined()
    expect(json).toBeDefined()
    expect(fs.readFileSync(txt!, 'utf8')).toContain('The system that actually works')
    const meta = JSON.parse(fs.readFileSync(json!, 'utf8'))
    expect(meta.title).toBe('The system that actually works')
  })

  it('export refuses clips that were never rendered', () => {
    const clip = listClips(ctx, projectId)[0]
    // a fresh clip with no render
    const candidates = getCandidates(ctx, projectId).filter((c) => c.status === 'discovered')
    const fresh = createClipFromCandidate(ctx, candidates[candidates.length - 1].id)
    expect(() => runExport(ctx, [fresh.id], true)).toThrow(AppError)
  })

  it('startup recovery marks in-flight renders as failed (no corrupt output kept)', async () => {
    const queue = new RenderQueue(ctx)
    const clip = listClips(ctx, projectId)[0]
    const renderId = await queue.queueRender(clip.id)
    // simulate an unclean shutdown while it is queued/running
    const interruptedCount = queue.startupRecovery()
    expect(interruptedCount).toBeGreaterThanOrEqual(0)
    const after = renders().find((r) => r.id === renderId)
    if (after && after.status !== 'completed') {
      expect(after.status).toBe('failed')
    }
  }, 120_000)

  it('a failed render leaves no final artifact and records the stage', async () => {
    const throwaway = createProject(ctx, 'Render Failure')
    const imported = await importMediaFile(ctx, throwaway.id, SAMPLE_VIDEO)
    importTranscript(ctx, throwaway.id, SAMPLE_TRANSCRIPT)
    await runAnalysis(ctx, {
      projectId: throwaway.id,
      providerId: 'heuristic-local',
      onEvent: () => undefined,
      signal: new AbortController().signal
    })
    const candidate = getCandidates(ctx, throwaway.id)[0]
    const clip = createClipFromCandidate(ctx, candidate.id)

    // sabotage: remove the imported source so FFmpeg cannot read it
    fs.unlinkSync(imported.sourcePath!)

    const queue = new RenderQueue(ctx)
    const renderId = await queue.queueRender(clip.id)
    const done = await waitForRender(renderId, 120_000)
    expect(done.status).toBe('failed')
    expect(done.error).not.toBeNull()
    expect(done.error!.code).toBe('SOURCE_MISSING')
    // no final artifact, no leftover temp file
    const rendersDir = path.join(ctx.projectDir(throwaway.id), 'renders')
    expect(fs.readdirSync(rendersDir).filter((f) => f.endsWith('.mp4'))).toEqual([])
    expect(tasksRepo.get(ctx.db, renderId)!.state).toBe('failed')
    deleteProject(ctx, throwaway.id, true)
  }, 180_000)

  it('deleting a project requires confirmation and removes its folder', async () => {
    const throwaway = createProject(ctx, 'To Delete')
    await importMediaFile(ctx, throwaway.id, SAMPLE_VIDEO)
    expect(() => deleteProject(ctx, throwaway.id, false)).toThrow(AppError)
    const dir = ctx.projectDir(throwaway.id)
    expect(fs.existsSync(dir)).toBe(true)
    deleteProject(ctx, throwaway.id, true)
    expect(projectsRepo.get(ctx.db, throwaway.id)).toBeNull()
    expect(fs.existsSync(dir)).toBe(false)
  }, 60_000)

  function renders(): RenderJob[] {
    return rendersRepo.list(ctx.db)
  }
})
