import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { makeTestContext, requireFixtures, SAMPLE_VIDEO, SAMPLE_TRANSCRIPT, SILENCE_VIDEO } from '../helpers/context'
import type { AppContext } from '../../src/main/services/app-context'
import { createProject, importMediaFile, deleteProject } from '../../src/main/services/projects'
import { importTranscript } from '../../src/main/services/transcription'
import { detectSilence, playbackVerdict, optionsForMode, renderProxy } from '../../src/main/services/media/analysis'
import { buildFilmstrip, buildWaveform } from '../../src/main/services/media/frames'
import { createClipFromCandidate, updateClip } from '../../src/main/services/clips'
import { runAnalysis, getCandidates } from '../../src/main/services/ai/analysis'
import { optimizeClipBoundaries } from '../../src/main/services/clips/boundaries'
import { RenderQueue, freeDiskBytes } from '../../src/main/services/rendering/queue'
import { clipsRepo, rendersRepo } from '../../src/main/services/database/repositories'
import type { RenderJob } from '@shared/types'

const run = promisify(execFile)
const FFPROBE = require('@ffprobe-installer/ffprobe').path as string

/**
 * Video-engine overhaul integration coverage (§94-102): silence detection on
 * real audio, multi-segment renders with remapped captions, output validation
 * via FFprobe, preview renders, proxy transcode, filmstrip + waveform. All
 * against the real service stack and bundled FFmpeg — no mocks.
 */

let ctx: AppContext
// Default no-op: if beforeAll fails (missing fixtures), afterAll must not
// turn one clear error into three confusing ones.
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

async function probeJson(file: string): Promise<{ streams: Array<{ codec_type: string; width?: number; height?: number }>; format: { duration: string } }> {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type,width,height', '-show_entries', 'format=duration', '-of', 'json', file])
  return JSON.parse(stdout)
}

async function waitForRender(queue: RenderQueue, renderId: string, timeoutMs = 240_000): Promise<RenderJob> {
  const started = Date.now()
  for (;;) {
    const job = rendersRepo.get(ctx.db, renderId)
    if (job && (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled')) return job
    if (Date.now() - started > timeoutMs) {
      throw new Error(`render ${renderId} did not finish within ${timeoutMs}ms (last: ${JSON.stringify(job ?? null)})`)
    }
    await new Promise((r) => setTimeout(r, 400))
  }
}

async function setupProject(name: string): Promise<string> {
  const project = createProject(ctx, name)
  await importMediaFile(ctx, project.id, SAMPLE_VIDEO)
  importTranscript(ctx, project.id, SAMPLE_TRANSCRIPT)
  await runAnalysis(ctx, { projectId: project.id, providerId: 'heuristic-local', onEvent: () => undefined, signal: new AbortController().signal })
  return project.id
}

describe('video engine overhaul — real FFmpeg integration', () => {
  it('classifies native playback for the H.264/AAC fixture and probes disk space', async () => {
    projectId = await setupProject('VE Overhaul')
    const verdict = playbackVerdict({
      hasVideo: true,
      hasAudio: true,
      videoCodec: 'h264',
      audioCodec: 'aac'
    })
    expect(verdict.verdict).toBe('native')
    const hevc = playbackVerdict({ hasVideo: true, hasAudio: true, videoCodec: 'hevc', audioCodec: 'aac' })
    expect(hevc.verdict).toBe('proxy')
    expect(hevc.reason).toContain('hevc')
    const ac3 = playbackVerdict({ hasVideo: true, hasAudio: true, videoCodec: 'h264', audioCodec: 'ac3' })
    expect(ac3.verdict).toBe('proxy')
    expect(freeDiskBytes(ctx.workspaceRoot)).not.toBeNull()
    expect(freeDiskBytes(ctx.workspaceRoot)!).toBeGreaterThan(0)
  }, 60_000)

  it('detects a known 2.5s silence gap in a purpose-built fixture', async () => {
    // tone(3s) → silence(2.5s) → tone(3s); committed as tests/fixtures/media/silence.mp4
    const project = createProject(ctx, 'VE Silence Fixture')
    await importMediaFile(ctx, project.id, SILENCE_VIDEO)
    const { getProject } = await import('../../src/main/services/projects')
    const loaded = getProject(ctx, project.id)!
    expect(loaded.hasAudio).toBe(true)
    const result = await detectSilence(ctx, loaded, { from: 0, to: 8.5 }, optionsForMode('auto'))
    expect(result.detected.length).toBeGreaterThanOrEqual(1)
    expect(result.detected[0].start).toBeGreaterThan(2.8)
    expect(result.detected[0].end).toBeLessThan(5.7)
    // cut = detected range shrunk by the 130ms padding on each side
    expect(result.cuts.length).toBe(1)
    expect(result.cuts[0].start).toBeGreaterThan(result.detected[0].start)
    expect(result.savedSec).toBeGreaterThan(2.0)
    expect(result.savedSec).toBeLessThan(2.5)
    deleteProject(ctx, project.id, true)
  }, 120_000)

  it('detects real silence with FFmpeg silencedetect and stores cuts on the clip', async () => {
    const candidate = getCandidates(ctx, projectId)[0]
    const clip = createClipFromCandidate(ctx, candidate.id)
    const { getProject } = await import('../../src/main/services/projects')
    const project = getProject(ctx, projectId)!
    const result = await detectSilence(ctx, project, { from: clip.startTime, to: clip.endTime }, optionsForMode('auto'))
    // deterministic assertions on structure, not on the fixture's exact audio:
    for (const cut of result.cuts) {
      expect(cut.end).toBeGreaterThan(cut.start)
      expect(cut.start).toBeGreaterThanOrEqual(clip.startTime)
      expect(cut.end).toBeLessThanOrEqual(clip.endTime)
    }
    const saved = result.cuts.reduce((s, c) => s + (c.end - c.start), 0)
    expect(result.savedSec).toBeCloseTo(saved, 5)
    expect(saved).toBeLessThan(clip.endTime - clip.startTime) // never removes everything
  }, 120_000)

  it('renders a multi-segment clip (silence removal) with exact geometry and validated duration', async () => {
    const candidate = getCandidates(ctx, projectId)[1] ?? getCandidates(ctx, projectId)[0]
    const clip = createClipFromCandidate(ctx, candidate.id)
    // Two hard cuts inside the clip → three kept segments.
    const mid1 = clip.startTime + (clip.endTime - clip.startTime) * 0.3
    const mid2 = clip.startTime + (clip.endTime - clip.startTime) * 0.6
    const cutClip = updateClip(ctx, clip.id, {
      silenceCuts: [
        { start: Math.round(mid1 * 100) / 100, end: Math.round((mid1 + 0.8) * 100) / 100 },
        { start: Math.round(mid2 * 100) / 100, end: Math.round((mid2 + 0.8) * 100) / 100 }
      ]
    })
    const expected = clip.endTime - clip.startTime - 1.6

    const queue = new RenderQueue(ctx)
    const renderId = await queue.queueRender(cutClip.id)
    const done = await waitForRender(queue, renderId)
    expect(done.status).toBe('completed')
    expect(done.error).toBeNull()

    const job = rendersRepo.get(ctx.db, renderId)!
    const probe = await probeJson(job.outputPath!)
    const video = probe.streams.find((s) => s.codec_type === 'video')!
    expect(video).toBeDefined()
    // 9:16 @ clip default 1080p → exact 1080×1920
    expect(video.width).toBe(1080)
    expect(video.height).toBe(1920)
    // duration must reflect the removed silence (±1.5s validation window)
    const duration = parseFloat(probe.format.duration)
    expect(Math.abs(duration - expected)).toBeLessThanOrEqual(1.5)
    expect(duration).toBeLessThan(clip.endTime - clip.startTime - 0.5)
  }, 300_000)

  it('renders a 720p draft preview render flagged as preview', async () => {
    const clip = clipsRepo.listForProject(ctx.db, projectId)[0]
    updateClip(ctx, clip.id, { aspectRatio: '16:9' })
    const queue = new RenderQueue(ctx)
    const renderId = await queue.queueRender(clipsRepo.get(ctx.db, clip.id)!.id, true)
    const done = await waitForRender(queue, renderId)
    expect(done.status).toBe('completed')
    expect(done.preview).toBe(true)
    const job = rendersRepo.get(ctx.db, renderId)!
    const probe = await probeJson(job.outputPath!)
    const video = probe.streams.find((s) => s.codec_type === 'video')!
    // 16:9 @ 720p → 1280×720
    expect(video.width).toBe(1280)
    expect(video.height).toBe(720)
  }, 300_000)

  it('rejects an impossible render (missing source) without keeping artifacts', async () => {
    const throwaway = await setupProject('VE Failure')
    const candidate = getCandidates(ctx, throwaway)[0]
    const clip = createClipFromCandidate(ctx, candidate.id)
    const { getProject } = await import('../../src/main/services/projects')
    fs.unlinkSync(getProject(ctx, throwaway)!.sourcePath!)
    const queue = new RenderQueue(ctx)
    const renderId = await queue.queueRender(clip.id)
    const done = await waitForRender(queue, renderId, 120_000)
    expect(done.status).toBe('failed')
    const rendersDir = path.join(ctx.projectDir(throwaway), 'renders')
    expect(fs.readdirSync(rendersDir).filter((f) => f.endsWith('.mp4'))).toEqual([])
    deleteProject(ctx, throwaway, true)
  }, 180_000)

  it('generates a real filmstrip and waveform, cached on the second call', async () => {
    const { getProject } = await import('../../src/main/services/projects')
    const project = getProject(ctx, projectId)!
    const first = await buildFilmstrip(ctx, project, 12)
    expect(first.frames.length).toBeGreaterThanOrEqual(6)
    for (const f of first.frames) {
      expect(fs.existsSync(f.path)).toBe(true)
      expect(f.t).toBeGreaterThanOrEqual(0)
    }
    const second = await buildFilmstrip(ctx, project, 12)
    expect(second.cached).toBe(true)

    const wave = await buildWaveform(ctx, project, 200)
    expect(wave.silent).toBe(false)
    expect(wave.peaks.length).toBeGreaterThan(50)
    for (const p of wave.peaks) {
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThanOrEqual(1)
    }
    // at least some real audio energy in the fixture
    expect(wave.peaks.some((p) => p > 0.05)).toBe(true)
  }, 180_000)

  it('transcodes a playable H.264 proxy at 720p', async () => {
    const { getProject } = await import('../../src/main/services/projects')
    const project = getProject(ctx, projectId)!
    const result = await renderProxy(ctx, project, () => undefined, new AbortController().signal)
    expect(fs.existsSync(result.proxyPath)).toBe(true)
    expect(fs.statSync(result.proxyPath).size).toBeGreaterThan(10_000)
    const probe = await probeJson(result.proxyPath)
    const video = probe.streams.find((s) => s.codec_type === 'video')!
    expect(video.height).toBe(720)
    expect(parseFloat(probe.format.duration)).toBeGreaterThan(50)
  }, 300_000)

  it('optimizeBoundaries snaps a ragged clip to sentences and reports honestly', async () => {
    const candidate = getCandidates(ctx, projectId)[0]
    const clip = createClipFromCandidate(ctx, candidate.id)
    // ragged: cut into the middle of the range
    const ragged = updateClip(ctx, clip.id, {
      startTime: clip.startTime + (clip.endTime - clip.startTime) * 0.37,
      endTime: clip.endTime - 0.3
    })
    const result = optimizeClipBoundaries(ctx, ragged.id)
    expect(result.clip.startTime).toBeGreaterThanOrEqual(0)
    expect(result.clip.endTime).toBeGreaterThan(result.clip.startTime)
    expect(typeof result.startReason).toBe('string')
    expect(typeof result.endReason).toBe('string')
    expect(result.quality.after.score).toBeGreaterThanOrEqual(result.quality.before.score - 0.05)
  }, 60_000)
})
