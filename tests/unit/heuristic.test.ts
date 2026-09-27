import { describe, it, expect } from 'vitest'
import { runHeuristicAnalysis } from '@main/services/ai/heuristic'
import { aggregateScore } from '@shared/candidates'
import type { TranscriptSegment } from '@shared/types'
import { SCORE_WEIGHTS } from '@shared/candidates'

const seg = (id: number, start: number, end: number, text: string): TranscriptSegment => ({
  id, startTime: start, endTime: end, text, speaker: null, confidence: null, words: null
})

// Rich, varied transcript: questions, emotion words, numbers, story progression
const SEGMENTS: TranscriptSegment[] = [
  seg(0, 0, 3.5, 'Why do most creators fail within their first ninety days?'),
  seg(1, 3.5, 8.0, 'I made every single mistake possible when I started three years ago'),
  seg(2, 8.0, 12.5, 'And honestly the results shocked me completely'),
  seg(3, 12.5, 17.0, 'The first thing you need to understand is consistency'),
  seg(4, 17.0, 21.5, 'Most people completely ignore this part of the process'),
  seg(5, 21.5, 26.0, 'Then everything changed when I wrote down every commitment'),
  seg(6, 26.0, 30.5, 'Because accountability compounds faster than talent ever will'),
  seg(7, 30.5, 35.0, 'Within two weeks you will feel an incredible difference'),
  seg(8, 35.0, 39.5, 'That is the whole system and it is brutally simple'),
  seg(9, 39.5, 44.0, 'What would you try if you could not fail at all?')
]

const OPTS = { minSeconds: 15, maxSeconds: 30, maxCandidates: 6 }

describe('local heuristic analyzer (ADR-006: honest, deterministic, offline)', () => {
  it('returns candidates for a real-paced transcript', () => {
    const candidates = runHeuristicAnalysis(SEGMENTS, OPTS)
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates.length).toBeLessThanOrEqual(OPTS.maxCandidates)
  })

  it('is deterministic — same input, same output', () => {
    const a = runHeuristicAnalysis(SEGMENTS, OPTS)
    const b = runHeuristicAnalysis(SEGMENTS, OPTS)
    expect(a).toEqual(b)
  })

  it('respects duration bounds (with documented tolerance)', () => {
    const candidates = runHeuristicAnalysis(SEGMENTS, OPTS)
    const minOk = Math.max(6, OPTS.minSeconds * 0.65)
    const maxOk = OPTS.maxSeconds * 1.35
    for (const c of candidates) {
      const dur = c.endTime - c.startTime
      expect(dur).toBeGreaterThanOrEqual(minOk - 0.01)
      expect(dur).toBeLessThanOrEqual(maxOk + 0.01)
    }
  })

  it('anchors candidates to segment ids that exist', () => {
    const candidates = runHeuristicAnalysis(SEGMENTS, OPTS)
    const ids = new Set(SEGMENTS.map((s) => s.id))
    for (const c of candidates) {
      expect(ids.has(c.startSegmentId)).toBe(true)
      expect(ids.has(c.endSegmentId)).toBe(true)
      expect(c.startSegmentId).toBeLessThanOrEqual(c.endSegmentId)
    }
  })

  it('produces scores in 0–100 whose aggregate matches the shared weights', () => {
    const candidates = runHeuristicAnalysis(SEGMENTS, OPTS)
    for (const c of candidates) {
      for (const value of Object.values(c.scores)) {
        expect(value).toBeGreaterThanOrEqual(0)
        expect(value).toBeLessThanOrEqual(100)
      }
      expect(c.overallScore).toBe(aggregateScore(c.scores))
      // aggregate is a weighted mean of the eight dimensions
      const manual = Object.keys(SCORE_WEIGHTS).reduce((sum, key) => sum + (c.scores as never as Record<string, number>)[key] * SCORE_WEIGHTS[key as keyof typeof SCORE_WEIGHTS], 0)
      expect(c.overallScore).toBe(Math.round(Math.min(100, Math.max(0, manual))))
    }
  })

  it('spreads candidates across the timeline (time buckets)', () => {
    const long: TranscriptSegment[] = []
    for (let i = 0; i < 40; i++) {
      long.push(seg(i, i * 4.5, i * 4.5 + 4.2, `Point number ${i} matters because reasons and numbers ${i} keep attention high here`))
    }
    const candidates = runHeuristicAnalysis(long, { minSeconds: 15, maxSeconds: 30, maxCandidates: 6 })
    expect(candidates.length).toBeGreaterThanOrEqual(3)
    // no two picked candidates overlap more than 55% (pre-dedup guarantee)
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i]
        const b = candidates[j]
        const inter = Math.min(a.endTime, b.endTime) - Math.max(a.startTime, b.startTime)
        const frac = inter > 0 ? inter / Math.min(a.endTime - a.startTime, b.endTime - b.startTime) : 0
        expect(frac).toBeLessThanOrEqual(0.55 + 0.001)
      }
    }
  })

  it('returns an empty list for an empty transcript (no fabrication)', () => {
    expect(runHeuristicAnalysis([], OPTS)).toEqual([])
  })

  it('labels itself in the explanation (honesty requirement)', () => {
    const candidates = runHeuristicAnalysis(SEGMENTS, OPTS)
    for (const c of candidates) {
      expect(c.scoreExplanation).toContain('heuristic')
    }
  })
})
