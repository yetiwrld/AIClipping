import type { ClipCandidate, ScoreBreakdown, TranscriptSegment } from './types'
import { getDurationRange, DURATION_TOLERANCE } from './constants'
import { overlapRatio } from './utils/time'
import { sentenceSpans, snapToSentenceBoundaries } from './analysis/boundaries'
import type { z } from 'zod'
import type { rawCandidateSchema, rawScoresSchema } from './schemas'

/**
 * Candidate post-processing: segment-id → time conversion, validation,
 * duration gates, and deduplication into "moments".
 *
 * The AI never produces raw timestamps — only segment id ranges — so every
 * resulting time is anchored to real transcript segments (ADR-005).
 */

export type RawCandidate = z.infer<typeof rawCandidateSchema>
export type RawScores = z.infer<typeof rawScoresSchema>

export interface CandidateValidationContext {
  segments: TranscriptSegment[]
  sourceDuration: number | null
  durationPreset: 'short' | 'medium' | 'long' | 'mixed'
}

export interface ValidatedCandidate {
  startTime: number
  endTime: number
  startSegmentId: number
  endSegmentId: number
  title: string
  hook: string
  reason: string
  clipType: string
  transcriptExcerpt: string
}

export interface RejectedCandidate {
  raw: RawCandidate
  reason: string
}

export function excerptFor(segments: TranscriptSegment[], startId: number, endId: number): string {
  return segments
    .filter((s) => s.id >= startId && s.id <= endId)
    .map((s) => s.text.trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .slice(0, 4000)
}

/**
 * Convert + validate one raw candidate. Returns null when the candidate must
 * be rejected, with the reason recorded.
 */
export function validateCandidate(
  raw: RawCandidate,
  ctx: CandidateValidationContext
): { candidate: ValidatedCandidate } | { rejection: string } {
  const { segments } = ctx
  if (segments.length === 0) return { rejection: 'transcript is empty' }
  if (raw.startSegmentId > raw.endSegmentId) return { rejection: 'start segment after end segment' }

  const startSeg = segments.find((s) => s.id === raw.startSegmentId)
  const endSeg = segments.find((s) => s.id === raw.endSegmentId)
  if (!startSeg || !endSeg) {
    return { rejection: `segment ids ${raw.startSegmentId}–${raw.endSegmentId} do not exist in the transcript` }
  }

  let startTime = startSeg.startTime
  let endTime = endSeg.endTime
  if (endTime <= startTime) return { rejection: 'zero or negative duration' }

  // Boundary optimization (§34): snap raw segment ranges onto sentence
  // boundaries so clips start at the beginning of a thought and end after it
  // completes. Falls back to the raw range when snapping would break the
  // duration gates.
  const spans = sentenceSpans(segments)
  if (spans.length > 0) {
    const range0 = getDurationRange(ctx.durationPreset)
    const snapped = snapToSentenceBoundaries(
      { startTime, endTime },
      spans,
      { minLengthSec: Math.max(6, range0.min * (1 - DURATION_TOLERANCE)), maxLengthSec: range0.max * (1 + DURATION_TOLERANCE) }
    )
    if (ctx.sourceDuration != null && snapped.endTime > ctx.sourceDuration + 1.0) {
      // keep raw
    } else {
      startTime = snapped.startTime
      endTime = snapped.endTime
    }
  }

  if (ctx.sourceDuration != null && endTime > ctx.sourceDuration + 1.0) {
    return { rejection: 'range exceeds source duration' }
  }

  const range = getDurationRange(ctx.durationPreset)
  const dur = endTime - startTime
  const minOk = range.min * (1 - DURATION_TOLERANCE)
  const maxOk = range.max * (1 + DURATION_TOLERANCE)
  if (dur < Math.max(6, minOk)) {
    return { rejection: `too short (${dur.toFixed(1)}s vs target ${range.min}–${range.max}s)` }
  }
  if (dur > maxOk) {
    return { rejection: `too long (${dur.toFixed(1)}s vs target ${range.min}–${range.max}s)` }
  }

  // Re-anchor segment ids to the (possibly snapped) time range so the excerpt
  // covers exactly what the clip will contain.
  const anchoredStart = segments.find((s) => s.endTime > startTime) ?? startSeg
  const anchoredEnd = [...segments].reverse().find((s) => s.startTime < endTime) ?? endSeg
  const startId = Math.min(anchoredStart.id, anchoredEnd.id)
  const endId = Math.max(anchoredStart.id, anchoredEnd.id)

  const excerpt = raw.transcript?.trim() || excerptFor(segments, startId, endId)
  if (excerpt.replace(/\s/g, '').length < 20) return { rejection: 'selected range contains almost no speech' }

  return {
    candidate: {
      startTime,
      endTime,
      startSegmentId: startId,
      endSegmentId: endId,
      title: raw.title.trim().slice(0, 140),
      hook: raw.hook.trim().slice(0, 240),
      reason: raw.reason.trim().slice(0, 1200),
      clipType: raw.clipType,
      transcriptExcerpt: excerpt
    }
  }
}

export interface ValidatedWithScores extends ValidatedCandidate {
  scores: ScoreBreakdown | null
  overallScore: number | null
  scoreExplanation: string | null
}

/** Weighted aggregate of audit dimensions → overall estimate 0–100. */
export const SCORE_WEIGHTS: Record<keyof ScoreBreakdown, number> = {
  hook: 0.22,
  retention: 0.16,
  clarity: 0.14,
  contextCompleteness: 0.14,
  standaloneValue: 0.12,
  emotionalImpact: 0.1,
  shareability: 0.07,
  visualSuitability: 0.05
}

export function aggregateScore(scores: ScoreBreakdown): number {
  let total = 0
  for (const key of Object.keys(SCORE_WEIGHTS) as Array<keyof ScoreBreakdown>) {
    total += scores[key] * SCORE_WEIGHTS[key]
  }
  return Math.round(Math.min(100, Math.max(0, total)))
}

export function clampScore(n: number): number {
  return Math.round(Math.min(100, Math.max(0, n)))
}

export interface DedupResult {
  /** Candidates grouped by moment; within a group sorted by rank */
  moments: ValidatedWithScores[][]
  variationsGrouped: number
}

/**
 * Group overlapping candidates into "moments". Two candidates belong to the
 * same moment when their time ranges overlap by more than 55% of the shorter
 * range. Each moment keeps ranked variations (best overall score first).
 */
export function dedupeCandidates(candidates: ValidatedWithScores[]): DedupResult {
  const sorted = [...candidates].sort((a, b) => a.startTime - b.startTime)
  const groups: ValidatedWithScores[][] = []

  for (const cand of sorted) {
    let placed = false
    for (const group of groups) {
      const anchor = group[0]
      if (overlapRatio(anchor.startTime, anchor.endTime, cand.startTime, cand.endTime) > 0.55) {
        group.push(cand)
        placed = true
        break
      }
    }
    if (!placed) groups.push([cand])
  }

  let variationsGrouped = 0
  for (const group of groups) {
    group.sort((a, b) => (b.overallScore ?? 0) - (a.overallScore ?? 0))
    variationsGrouped += Math.max(0, group.length - 1)
  }
  return { moments: groups, variationsGrouped }
}

/** Assign moment keys/ranks to deduped candidates (caller persists). */
export function assignMomentMetadata(
  moments: ValidatedWithScores[][],
  projectId: string
): Array<ValidatedWithScores & { momentKey: string; rankInMoment: number }> {
  const out: Array<ValidatedWithScores & { momentKey: string; rankInMoment: number }> = []
  moments.forEach((group, gi) => {
    group.forEach((cand, ci) => {
      out.push({ ...cand, momentKey: `moment-${projectId.slice(0, 8)}-${gi}`, rankInMoment: ci })
    })
  })
  return out
}

/** Human summary for the UI ("Found 14 moments, 8 passed checks…"). */
export function summarizeCandidates(
  total: number,
  kept: number,
  variationsGrouped: number,
  rejected: number,
  provider: string
) {
  return {
    foundMoments: total,
    keptCandidates: kept,
    variationsGrouped,
    rejected,
    provider
  }
}

export type CandidateLike = Pick<ClipCandidate, 'startTime' | 'endTime'>
