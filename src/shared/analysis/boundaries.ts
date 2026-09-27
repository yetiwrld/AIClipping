import type { TranscriptSegment } from '../types'

/**
 * Sentence-boundary analysis shared by clip candidate ranking, the editor's
 * "optimize boundaries" action, and the candidate review UI. Pure functions —
 * no I/O — so the main process and tests exercise identical logic.
 */

const SENTENCE_END = /[.!?…]["')\]]?$/
const FILLER_OPENERS =
  /^(and|but|so|because|which|that|where|when|also|then|plus|now|okay|ok|yeah|right|well|like|actually|basically|literally)\b/i

export interface SentenceSpan {
  /** Source seconds. */
  start: number
  end: number
  wordCount: number
  text: string
  /** True when the sentence ends with terminal punctuation. */
  endsCleanly: boolean
}

/**
 * Build sentence spans from transcript segments. Uses word timings when
 * present; falls back to proportional distribution across the segment text.
 */
export function sentenceSpans(
  segments: Array<Pick<TranscriptSegment, 'startTime' | 'endTime' | 'text' | 'words'>>
): SentenceSpan[] {
  const spans: SentenceSpan[] = []
  for (const seg of segments) {
    const tokens = seg.text.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) continue

    // word timings
    let words: Array<{ text: string; start: number; end: number }> | null = null
    if (seg.words && seg.words.length > 0) {
      const timed: Array<{ text: string; start: number; end: number }> = []
      let wi = 0
      for (const token of tokens) {
        const clean = token.replace(/[^\p{L}\p{N}']/gu, '')
        let match = seg.words[wi]
        while (
          match &&
          typeof match.word === 'string' &&
          !match.word.trim().startsWith(clean.slice(0, Math.min(3, clean.length))) &&
          wi < seg.words.length - 1
        ) {
          wi++
          match = seg.words[wi]
        }
        if (match && typeof match.start === 'number' && typeof match.end === 'number') {
          timed.push({ text: token, start: match.start, end: match.end })
        }
        wi++
      }
      if (timed.length >= Math.max(1, tokens.length * 0.6)) words = timed
    }
    if (!words) {
      const dur = Math.max(0.2, seg.endTime - seg.startTime)
      const per = dur / tokens.length
      words = tokens.map((text, i) => ({
        text,
        start: seg.startTime + i * per,
        end: seg.startTime + (i + 1) * per
      }))
    }

    let current: typeof words = []
    const flush = () => {
      if (current.length === 0) return
      const text = current.map((w) => w.text).join(' ')
      spans.push({
        start: current[0].start,
        end: current[current.length - 1].end,
        wordCount: current.length,
        text,
        endsCleanly: SENTENCE_END.test(text)
      })
      current = []
    }
    for (let i = 0; i < words.length; i++) {
      current.push(words[i])
      if (SENTENCE_END.test(words[i].text)) flush()
    }
    flush()
  }
  return spans
}

export interface BoundaryResult {
  startTime: number
  endTime: number
  adjusted: boolean
  /** Human-readable explanation shown in the UI (never hidden magic). */
  startReason: string
  endReason: string
}

function spanAt(spans: SentenceSpan[], t: number): number {
  for (let i = 0; i < spans.length; i++) {
    if (t >= spans[i].start - 0.001 && t <= spans[i].end + 0.001) return i
  }
  return -1
}

function prevSpanIndex(spans: SentenceSpan[], t: number): number {
  let idx = -1
  for (let i = 0; i < spans.length; i++) {
    if (spans[i].end <= t + 0.001) idx = i
    else break
  }
  return idx
}

function nextSpanIndex(spans: SentenceSpan[], t: number): number {
  for (let i = 0; i < spans.length; i++) {
    if (spans[i].start >= t - 0.001) return i
  }
  return -1
}

/**
 * Snap a candidate's edges to sentence boundaries.
 * Start: include the sentence the current start cuts into (context), or skip
 * to the next sentence when that would exceed the maximum length.
 * End: extend to finish the sentence being cut, or trim to the last complete
 * sentence when extending is not possible.
 */
export function snapToSentenceBoundaries(
  candidate: { startTime: number; endTime: number },
  spans: SentenceSpan[],
  opts: { minLengthSec?: number; maxLengthSec?: number } = {}
): BoundaryResult {
  const minLen = opts.minLengthSec ?? 5
  const maxLen = opts.maxLengthSec ?? 90
  let { startTime, endTime } = candidate
  let startReason = 'raw start'
  let endReason = 'raw end'

  if (spans.length > 0) {
    // ---- start ----
    const si = spanAt(spans, startTime)
    if (si >= 0) {
      const span = spans[si]
      const startsMidSentence = startTime > span.start + 0.25 && span.wordCount > 1
      if (startsMidSentence) {
        const byIncluding = endTime - span.start
        const nextStart = si + 1 < spans.length ? spans[si + 1].start : null
        const bySkipping = nextStart !== null ? endTime - nextStart : null
        if (byIncluding >= minLen && byIncluding <= maxLen) {
          startTime = span.start
          startReason = 'extended to include the full opening sentence'
        } else if (bySkipping !== null && bySkipping >= minLen && bySkipping <= maxLen) {
          startTime = nextStart as number
          startReason = 'moved to the next complete sentence'
        } else if (byIncluding > maxLen && bySkipping === null) {
          startReason = 'kept raw (sentence too long to include)'
        } else {
          startReason = 'kept raw (length limits)'
        }
      } else if (Math.abs(startTime - span.start) > 0.05 && startTime < span.start) {
        startTime = span.start
        startReason = 'aligned to sentence start'
      } else if (Math.abs(startTime - span.start) > 0.05) {
        startTime = span.start
        startReason = 'snapped to sentence start'
      } else {
        startReason = 'already at a sentence start'
      }
    } else {
      const ni = nextSpanIndex(spans, startTime)
      if (ni >= 0 && spans[ni].start - startTime > 0.4 && endTime - spans[ni].start >= minLen) {
        startTime = spans[ni].start
        startReason = 'skipped dead air before the first sentence'
      } else if (ni >= 0 && spans[ni].start - startTime > 0.4) {
        startReason = 'kept raw (would be too short)'
      } else {
        startReason = 'no sentence coverage'
      }
    }

    // ---- end ----
    const ei = spanAt(spans, endTime)
    if (ei >= 0) {
      const span = spans[ei]
      const endsMidSentence = endTime < span.end - 0.25 && span.wordCount > 1
      if (endsMidSentence) {
        const byExtending = span.end - startTime
        const prevEnd = ei - 1 >= 0 ? spans[ei - 1].end : null
        const byTrimming = prevEnd !== null ? prevEnd - startTime : null
        if (byExtending <= maxLen && byExtending >= minLen) {
          endTime = span.end
          endReason = span.endsCleanly
            ? 'extended to finish the sentence'
            : 'extended to the end of the last phrase'
        } else if (byTrimming !== null && byTrimming >= minLen) {
          endTime = prevEnd as number
          endReason = 'trimmed to the last complete sentence'
        } else {
          endReason = 'kept raw (length limits)'
        }
      } else if (Math.abs(endTime - span.end) > 0.05 && endTime > span.end) {
        endTime = span.end
        endReason = 'trimmed trailing dead air'
      } else if (Math.abs(endTime - span.end) > 0.05) {
        endTime = span.end
        endReason = 'extended to the sentence end'
      } else {
        endReason = 'already at a sentence end'
      }
    } else {
      const pi = prevSpanIndex(spans, endTime)
      if (pi >= 0 && endTime - spans[pi].end > 0.4 && spans[pi].end - startTime >= minLen) {
        endTime = spans[pi].end
        endReason = 'trimmed trailing dead air'
      } else {
        endReason = 'no sentence coverage'
      }
    }
  }

  return {
    startTime: Math.max(0, startTime),
    endTime: Math.max(startTime + 0.5, endTime),
    adjusted:
      Math.abs(startTime - candidate.startTime) > 0.05 ||
      Math.abs(endTime - candidate.endTime) > 0.05,
    startReason,
    endReason
  }
}

export interface LeadInResult {
  startTime: number
  applied: boolean
  reason: string
}

/**
 * Context expansion (§33): pull in the sentence before the clip when it sets
 * up the opener — a question, a continuation, or a very short first sentence.
 * Never reorders or invents content; it only moves the start boundary.
 */
export function expandWithLeadIn(
  candidate: { startTime: number; endTime: number },
  spans: SentenceSpan[],
  opts: { maxLeadSec?: number; maxLengthSec?: number } = {}
): LeadInResult {
  const maxLead = opts.maxLeadSec ?? 3.5
  const maxLen = opts.maxLengthSec ?? 90
  const pi = prevSpanIndex(spans, candidate.startTime)
  if (pi < 0) return { startTime: candidate.startTime, applied: false, reason: 'nothing before the clip' }
  const prev = spans[pi]
  const gap = candidate.startTime - prev.end
  if (gap > maxLead) return { startTime: candidate.startTime, applied: false, reason: 'previous sentence is too far away' }
  if (candidate.endTime - prev.start > maxLen) {
    return { startTime: candidate.startTime, applied: false, reason: 'would exceed the maximum clip length' }
  }
  const fi = nextSpanIndex(spans, candidate.startTime)
  const first = fi >= 0 ? spans[fi] : null
  let reason: string | null = null
  if (/\?\s*$/.test(prev.text)) reason = 'the previous sentence is a question that sets up the answer'
  else if (prev.text.length > 0 && !SENTENCE_END.test(prev.text)) reason = 'the previous phrase continues into this clip'
  else if (first && first.wordCount <= 4) reason = 'the first sentence is very short and needs setup'
  else if (first && FILLER_OPENERS.test(first.text)) reason = 'the opener starts mid-thought'
  if (!reason) return { startTime: candidate.startTime, applied: false, reason: 'the opener stands on its own' }
  return { startTime: prev.start, applied: true, reason }
}

export interface BoundaryQuality {
  /** 0..1 overall. */
  score: number
  startScore: number
  endScore: number
  startReason: string
  endReason: string
}

/** Rate how cleanly a clip starts and ends (used for ranking + UI badges). */
export function boundaryQuality(
  clip: { startTime: number; endTime: number },
  spans: SentenceSpan[]
): BoundaryQuality {
  const si = spanAt(spans, clip.startTime)
  const ei = spanAt(spans, clip.endTime)
  let startScore = 0.5
  let startReason = 'starts mid-sentence'
  let endScore = 0.5
  let endReason = 'ends mid-sentence'

  if (si < 0) {
    const ni = nextSpanIndex(spans, clip.startTime)
    if (ni >= 0 && spans[ni].start - clip.startTime <= 0.4) {
      startScore = 1
      startReason = 'starts at a natural pause'
    } else if (ni >= 0) {
      startScore = 0.8
      startReason = 'starts during a pause'
    } else {
      startScore = 0.5
      startReason = 'no speech coverage at the start'
    }
  } else if (Math.abs(clip.startTime - spans[si].start) <= 0.3) {
    startScore = 1
    startReason = 'starts at a sentence start'
  }

  if (ei < 0) {
    const pi = prevSpanIndex(spans, clip.endTime)
    if (pi >= 0 && clip.endTime - spans[pi].end <= 0.4) {
      endScore = 1
      endReason = 'ends right after a sentence'
    } else if (pi >= 0) {
      endScore = 0.7
      endReason = 'ends during trailing silence'
    } else {
      endScore = 0.5
      endReason = 'no speech coverage at the end'
    }
  } else if (Math.abs(clip.endTime - spans[ei].end) <= 0.3 && spans[ei].endsCleanly) {
    endScore = 1
    endReason = 'ends at a complete sentence'
  } else if (Math.abs(clip.endTime - spans[ei].end) <= 0.3) {
    endScore = 0.8
    endReason = 'ends at a phrase boundary'
  }
  return { score: (startScore + endScore) / 2, startScore, endScore, startReason, endReason }
}

/** Fraction of the clip with no speech (dead air). 0..1. */
export function deadAirRatio(
  clip: { startTime: number; endTime: number },
  segments: Array<Pick<TranscriptSegment, 'startTime' | 'endTime'>>
): number {
  const dur = clip.endTime - clip.startTime
  if (dur <= 0) return 0
  let speech = 0
  for (const seg of segments) {
    const a = Math.max(seg.startTime, clip.startTime)
    const b = Math.min(seg.endTime, clip.endTime)
    if (b > a) speech += b - a
  }
  return Math.max(0, Math.min(1, 1 - speech / dur))
}
