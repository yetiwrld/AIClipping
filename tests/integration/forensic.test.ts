import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { makeTestContext, requireFixtures, FORENSIC_VIDEO, SAMPLE_TRANSCRIPT } from '../helpers/context'
import type { AppContext } from '../../src/main/services/app-context'
import { createProject, importMediaFile, deleteProject } from '../../src/main/services/projects'
import { importTranscript } from '../../src/main/services/transcription'
import { runAnalysis, getCandidates } from '../../src/main/services/ai/analysis'
import { createClipFromCandidate, updateClip } from '../../src/main/services/clips'
import { analyzeSmartCrop } from '../../src/main/services/media/smartcrop'
import { RenderQueue } from '../../src/main/services/rendering/queue'
import { clipsRepo, rendersRepo, projectsRepo } from '../../src/main/services/database/repositories'
import { updateSettings, getSettings } from '../../src/main/services/settings'

const run = promisify(execFile)
const FFMPEG = require('@ffmpeg-installer/ffmpeg').path as string
const FFPROBE = require('@ffprobe-installer/ffprobe').path as string

/**
 * §22 forensic regression — the user's mis-exported vertical clip.
 *
 * Source: 10s, 1080x1920, real content 1080x1440 at y=246 (baked-in bars).
 * Acceptance:
 *   1. Import detects the content rect (bars are known, not passed through).
 *   2. Heuristic analysis NEVER proposes a candidate longer than the source
 *      (the 44.95s-on-a-10s-source bug).
 *   3. A 9:16 render of the bar-filled source FILLS the frame — cropdetect
 *      on the rendered output finds no significant bars.
 *   4. Smart crop analysis produces real keyframes inside the content area.
 *   5. HEVC codec setting produces an HEVC output (validated by ffprobe).
 */

let ctx: AppContext
let cleanup: () => Promise<void> = async () => undefined
let projectId: string

beforeAll(async () => {
  requireFixtures()
  const made = await makeTestContext()
  ctx = made.ctx
  cleanup = made.cleanup
}, 30_000)

afterAll(async () => {
  await cleanup()
})

async function cropdetectHeightFraction(file: string): Promise<number> {
  // Runs cropdetect over the whole file; returns the detected content height
  // as a fraction of the stream height (1.0 = content fills the frame).
  const { stderr } = await run(FFMPEG, [
    '-hide_banner', '-nostats',
    '-i', file,
    '-vf', 'cropdetect=limit=24:round=2',
    '-frames:v', '40',
    '-f', 'null', '-'
  ])
  const crops = [...`${stderr}`.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)]
  expect(crops.length).toBeGreaterThan(0)
  const last = crops[crops.length - 1]
  const h = parseInt(last[2], 10)
  const probe = await run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=height', '-of', 'json', file])
  const streamH = JSON.parse(probe.stdout).streams[0].height as number
  return h / streamH
}

async function waitForRender(queue: RenderQueue, renderId: string, timeoutMs = 300_000): Promise<{ status: string; outputPath: string | null }> {
  const started = Date.now()
  for (;;) {
    const job = rendersRepo.get(ctx.db, renderId)
    if (job && (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled')) {
      return { status: job.status, outputPath: job.outputPath }
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`render ${renderId} did not finish within ${timeoutMs}ms (last: ${JSON.stringify(job ?? null)})`)
    }
    await new Promise((r) => setTimeout(r, 400))
  }
}

describe('§22 forensic regression — baked-in bars must not survive vertical export', () => {
  it('detects the content rect at import (1080x1440 at y≈246 in 1080x1920)', async () => {
    const project = createProject(ctx, 'Forensic §22')
    projectId = project.id
    await importMediaFile(ctx, projectId, FORENSIC_VIDEO)

    const stored = projectsRepo.get(ctx.db, projectId)!
    expect(stored.width).toBe(1080)
    expect(stored.height).toBe(1920)
    expect(stored.duration).toBeGreaterThan(9)
    expect(stored.contentRect).not.toBeNull()
    // 246 is already even; content is 1080x1440. cropdetect may report the
    // content starting at x=2 (edge chroma), and the rect is clamped in-frame.
    expect(stored.contentRect!.width).toBeGreaterThanOrEqual(1076)
    expect(stored.contentRect!.width).toBeLessThanOrEqual(1080)
    expect(stored.contentRect!.height).toBeGreaterThanOrEqual(1436) // 1440 ± codec fuzz
    expect(stored.contentRect!.height).toBeLessThanOrEqual(1444)
    expect(stored.contentRect!.top).toBeGreaterThanOrEqual(242)
    expect(stored.contentRect!.top).toBeLessThanOrEqual(250)
    // strictly inside the frame
    expect(stored.contentRect!.left + stored.contentRect!.width).toBeLessThanOrEqual(1080)
    expect(stored.contentRect!.top + stored.contentRect!.height).toBeLessThanOrEqual(1920)
  }, 120_000)

  it('heuristic analysis never proposes a candidate that exceeds the source (§2 gate)', async () => {
    // A 60s transcript against a 10s source: the OLD bug produced a 44.95s
    // candidate. The gate must reject anything past the source duration —
    // if nothing valid remains, the analysis fails loudly instead of lying.
    importTranscript(ctx, projectId, SAMPLE_TRANSCRIPT)
    let analysisRejected = false
    try {
      await runAnalysis(ctx, {
        projectId,
        providerId: 'heuristic-local',
        onEvent: () => undefined,
        signal: new AbortController().signal
      })
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code === 'ANALYSIS_NO_CANDIDATES' || code === 'ANALYSIS_NO_VALID_CANDIDATES') {
        analysisRejected = true
      } else {
        throw err
      }
    }
    const project = projectsRepo.get(ctx.db, projectId)!
    const candidates = getCandidates(ctx, projectId)
    if (analysisRejected) {
      // nothing persisted — the honest outcome for a 10s source + 30-60s preset
      expect(candidates.length).toBe(0)
    }
    for (const c of candidates) {
      expect(c.endTime, `candidate "${c.title}" ends past the source`).toBeLessThanOrEqual((project.duration ?? 0) + 1.0)
      expect(c.endTime - c.startTime).toBeLessThanOrEqual((project.duration ?? 0) + 1.0)
    }
  }, 120_000)

  it('renders a 9:16 export that FILLS the frame — no bars in the output', async () => {
    const project = projectsRepo.get(ctx.db, projectId)!
    const candidates = getCandidates(ctx, projectId)
    let clipId: string
    if (candidates.length > 0) {
      clipId = createClipFromCandidate(ctx, candidates[0].id).id
    } else {
      const clip = {
        id: crypto.randomUUID(),
        candidateId: null,
        projectId,
        startTime: 0,
        endTime: 9.5,
        aspectRatio: '9:16' as const,
        cropMode: 'center' as const,
        cropX: 0.5,
        zoom: 1,
        captionStyleId: 'none',
        captionOverrides: {},
        captionTextEdits: {},
        captionCueSplits: {},
        captionCueMerges: {},
        captionTimingOffsets: {},
        silenceCuts: [],
        smartCropKeyframes: [],
        outputResolution: '1080p' as const,
        outputQuality: 'standard' as const,
        outputFps: 'source' as const,
        title: 'Forensic clip',
        description: '',
        hashtags: [],
        cta: '',
        metadataProvider: null,
        status: 'draft' as const
      }
      clipId = clipsRepo.create(ctx.db, clip).id
    }
    // Trim to 9.5s max (source is 10s)
    const trimmed = updateClip(ctx, clipId, { startTime: 0, endTime: Math.min(9.5, project.duration ?? 9.5) })

    const queue = new RenderQueue(ctx)
    const renderId = await queue.queueRender(trimmed.id)
    const result = await waitForRender(queue, renderId)
    expect(result.status).toBe('completed')
    expect(result.outputPath).toBeTruthy()
    expect(fs.existsSync(result.outputPath!)).toBe(true)

    // Geometry: exact 1080x1920 portrait
    const probe = await run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,codec_name', '-of', 'json', result.outputPath!])
    const stream = JSON.parse(probe.stdout).streams[0]
    expect(stream.width).toBe(1080)
    expect(stream.height).toBe(1920)
    expect(stream.codec_name).toBe('h264')

    // §22 acceptance: the visible content must fill ≥ 95% of the frame height.
    // (Before the fix, cropdetect on the output reported 1080x1440 at y=246 —
    // bars passed straight through into the vertical export.)
    const fillFraction = await cropdetectHeightFraction(result.outputPath!)
    expect(fillFraction).toBeGreaterThanOrEqual(0.95)
  }, 300_000)

  it('smart crop analysis produces keyframes inside the content area', async () => {
    const clips = clipsRepo.listForProject(ctx.db, projectId)
    expect(clips.length).toBeGreaterThan(0)
    const clip = clips[0]
    const result = await analyzeSmartCrop(ctx, projectsRepo.get(ctx.db, projectId)!, clip)
    expect(result.keyframes.length).toBeGreaterThan(0)
    expect(result.keyframes.length).toBeLessThanOrEqual(12)
    for (const k of result.keyframes) {
      expect(k.w % 2).toBe(0)
      expect(k.h % 2).toBe(0)
      expect(k.x).toBeGreaterThanOrEqual(0)
      expect(k.y).toBeGreaterThanOrEqual(240) // inside the content area (top ≈ 246)
      expect(k.y + k.h).toBeLessThanOrEqual(1690) // content bottom ≈ 1686
      expect(k.end).toBeGreaterThan(k.start)
    }
    // persisted on the clip via the same call the IPC handler makes
    updateClip(ctx, clip.id, { smartCropKeyframes: result.keyframes })
    const stored = clipsRepo.get(ctx.db, clip.id)!
    expect(stored.smartCropKeyframes?.length).toBe(result.keyframes.length)
  }, 180_000)

  it('HEVC setting renders an HEVC stream (validated by ffprobe)', async () => {
    updateSettings(ctx, { video: { codec: 'hevc' } })
    expect(getSettings(ctx).video.codec).toBe('hevc')
    const clips = clipsRepo.listForProject(ctx.db, projectId)
    const queue = new RenderQueue(ctx)
    const renderId = await queue.queueRender(clips[0].id)
    const result = await waitForRender(queue, renderId)
    expect(result.status).toBe('completed')
    const probe = await run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'json', result.outputPath!])
    expect(JSON.parse(probe.stdout).streams[0].codec_name).toBe('hevc')
    // restore default for any later work in this ctx
    updateSettings(ctx, { video: { codec: 'h264' } })
  }, 300_000)

  it('deletes cleanly', async () => {
    deleteProject(ctx, projectId, true)
    expect(projectsRepo.get(ctx.db, projectId)).toBeNull()
  })
})
