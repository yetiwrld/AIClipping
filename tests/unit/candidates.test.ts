import { describe, it, expect } from 'vitest'
import {
  validateCandidate, aggregateScore, clampScore, dedupeCandidates,
  assignMomentMetadata, excerptFor, SCORE_WEIGHTS
} from '@shared/candidates'
import type { ScoreBreakdown, TranscriptSegment } from '@shared/types'

const seg = (id: number, start: number, end: number, text: string): TranscriptSegment => ({
  id, startTime: start, endTime: end, text, speaker: null, confidence: null, words: null
})

// 10 segments × ~5s = a 50s transcript
const SEGMENTS: TranscriptSegment[] = Array.from({ length: 10 }, (_, i) =>
  seg(i, i * 5, i * 5 + 4.8, `Segment ${i} with enough meaningful words to count as real speech content here.`)
)

const CTX = { segments: SEGMENTS, sourceDuration: 50, durationPreset: 'medium' as const }

const raw = (over: Partial<Parameters<typeof validateCandidate>[0]> = {}) => ({
  startSegmentId: 1,
  endSegmentId: 7,
  title: 'A strong moment',
  hook: 'You need to hear this',
  reason: 'Complete argument with payoff',
  clipType: 'advice' as const,
  transcript: '',
  ...over
})

describe('validateCandidate', () => {
  it('accepts a well-formed candidate and anchors times to segments', () => {
    const out = validateCandidate(raw(), CTX)
    expect('candidate' in out).toBe(true)
    if ('candidate' in out) {
      expect(out.candidate.startTime).toBe(5) // segment 1 start
      expect(out.candidate.endTime).toBe(39.8) // segment 7 end
      expect(out.candidate.transcriptExcerpt).toContain('Segment 1')
    }
  })

  it('rejects when start id is after end id', () => {
    const out = validateCandidate(raw({ startSegmentId: 5, endSegmentId: 2 }), CTX)
    expect('rejection' in out).toBe(true)
  })

  it('rejects ids not present in the transcript', () => {
    const out = validateCandidate(raw({ startSegmentId: 0, endSegmentId: 99 }), CTX)
    expect('rejection' in out && out.rejection).toContain('do not exist')
  })

  it('rejects ranges outside the duration preset tolerance', () => {
    const tooShort = validateCandidate(raw({ startSegmentId: 1, endSegmentId: 1 }), CTX)
    expect('rejection' in tooShort && tooShort.rejection).toContain('too short')

    const tooLong = validateCandidate(raw({ startSegmentId: 0, endSegmentId: 9 }), { ...CTX, durationPreset: 'short' })
    expect('rejection' in tooLong && tooLong.rejection).toContain('too long')
  })

  it('rejects ranges exceeding the source duration', () => {
    const out = validateCandidate(raw(), { ...CTX, sourceDuration: 10 })
    expect('rejection' in out && out.rejection).toContain('exceeds source duration')
  })

  it('rejects when the range contains almost no speech', () => {
    // a duration-valid range whose text is nearly empty
    const sparse = SEGMENTS.map((s, i) => (i >= 1 && i <= 6 ? seg(i, i * 5, i * 5 + 4.8, 'um') : s))
    const out = validateCandidate(raw({ startSegmentId: 1, endSegmentId: 6 }), { ...CTX, segments: sparse })
    expect('rejection' in out && out.rejection).toContain('no speech')
  })

  it('accepts mixed preset ranges (wider tolerance)', () => {
    const out = validateCandidate(raw({ startSegmentId: 0, endSegmentId: 9 }), { ...CTX, durationPreset: 'mixed' })
    expect('candidate' in out).toBe(true)
  })
})

describe('scoring', () => {
  const scores = (over: Partial<ScoreBreakdown> = {}): ScoreBreakdown => ({
    hook: 50, retention: 50, clarity: 50, contextCompleteness: 50,
    standaloneValue: 50, emotionalImpact: 50, shareability: 50, visualSuitability: 50,
    ...over
  })

  it('weights sum to 1 so the aggregate is a true weighted mean', () => {
    const total = Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0)
    expect(total).toBeCloseTo(1, 10)
  })

  it('aggregateScore is the weighted mean of dimensions', () => {
    expect(aggregateScore(scores())).toBe(50)
    expect(aggregateScore(scores({ hook: 100 }))).toBe(Math.round(50 + 50 * SCORE_WEIGHTS.hook))
    expect(aggregateScore(scores({ hook: 100, visualSuitability: 0 }))).toBe(
      Math.round(50 + 50 * (SCORE_WEIGHTS.hook - SCORE_WEIGHTS.visualSuitability))
    )
  })

  it('aggregateScore clamps to 0–100', () => {
    expect(aggregateScore(scores({ hook: 100, retention: 100, clarity: 100 }))).toBeLessThanOrEqual(100)
    expect(aggregateScore(scores({ hook: 0 }))).toBeGreaterThanOrEqual(0)
  })

  it('clampScore rounds and clamps', () => {
    expect(clampScore(49.6)).toBe(50)
    expect(clampScore(-5)).toBe(0)
    expect(clampScore(120)).toBe(100)
  })
})

describe('dedupeCandidates', () => {
  const cand = (start: number, end: number, overallScore: number) => ({
    startTime: start, endTime: end, startSegmentId: 0, endSegmentId: 0,
    title: '', hook: '', reason: '', clipType: 'other', transcriptExcerpt: '',
    scores: null, overallScore, scoreExplanation: null
  })

  it('groups candidates overlapping >55% of the shorter range', () => {
    const result = dedupeCandidates([
      cand(0, 30, 60), // anchor of moment A
      cand(5, 32, 70), // 25s overlap with 27s shorter → ~0.93 → same moment
      cand(60, 90, 50) // far away → own moment
    ])
    expect(result.moments).toHaveLength(2)
    expect(result.moments[0]).toHaveLength(2)
    expect(result.variationsGrouped).toBe(1)
  })

  it('keeps similar-overlap candidates as separate moments', () => {
    // overlap of exactly 10s over a 30s shorter range → 0.33 → separate
    const result = dedupeCandidates([cand(0, 30, 60), cand(20, 50, 70)])
    expect(result.moments).toHaveLength(2)
  })

  it('orders each moment best-score-first', () => {
    const result = dedupeCandidates([cand(0, 30, 60), cand(5, 32, 90), cand(3, 31, 75)])
    expect(result.moments[0].map((c) => c.overallScore)).toEqual([90, 75, 60])
  })

  it('assignMomentMetadata assigns stable keys and ranks', () => {
    const result = dedupeCandidates([cand(0, 30, 60), cand(5, 32, 90), cand(60, 90, 40)])
    const tagged = assignMomentMetadata(result.moments, 'project-uuid-1234')
    expect(tagged.filter((c) => c.rankInMoment === 0)).toHaveLength(2)
    const keys = new Set(tagged.map((c) => c.momentKey))
    expect(keys.size).toBe(2)
    // best of each moment has rank 0
    const best = tagged.filter((c) => c.rankInMoment === 0).map((c) => c.overallScore)
    expect(best).toContain(90)
    expect(best).toContain(40)
  })
})

describe('excerptFor', () => {
  it('joins segment texts inclusively and caps length', () => {
    expect(excerptFor(SEGMENTS, 2, 3)).toBe(
      `${SEGMENTS[2].text} ${SEGMENTS[3].text}`
    )
    const long = excerptFor(
      Array.from({ length: 50 }, (_, i) => seg(i, i * 5, i * 5 + 4, 'x'.repeat(120))),
      0, 49
    )
    expect(long.length).toBeLessThanOrEqual(4000)
  })
})
