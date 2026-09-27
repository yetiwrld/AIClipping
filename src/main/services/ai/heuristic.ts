import type { ScoreBreakdown, TranscriptSegment } from '@shared/types'
import { HOOK_CUE_PATTERNS, QUESTION_PATTERN, NUMBER_PATTERN } from '@shared/constants'
import { aggregateScore } from '@shared/candidates'
import type { RawCandidate } from '@shared/candidates'

/**
 * Local heuristic analyzer — an honest, fully offline provider (ADR-006).
 * It computes the same candidate + audit structure as the AI providers from
 * transparent text signals. The UI labels its output "Local heuristic — not
 * an AI model". Deterministic: same transcript in, same candidates out.
 */

const EMOTION_WORDS = /\b(love|hate|fear|afraid|scared|terrified|angry|furious|cried|crying|tears|heartbreaking|devastating|incredible|amazing|proud|ashamed|regret|miracle|disaster|painful|beautiful|brutal|honest|vulnerable|struggl\w*|surviv\w*)\b/i
const PROGRESSION_WORDS = /\b(then|after|next|finally|eventually|suddenly|later|until|meanwhile|so|because|but|however|instead)\b/gi
const FILLER_WORDS = /\b(um+|uh+|er+|like|you know|sort of|kind of|basically|actually|literally|i mean|right\??)\b/gi
const INCOMPLETE_STARTERS = /^(and|but|so|because|which|that|it|they|these|those|he|she|we)\b/i
const SENTENCE_END = /[.!?…"')\]]\s*$/
const Q_TO_ANSWER = /\?\s/

export interface HeuristicCandidate extends RawCandidate {
  scores: ScoreBreakdown
  overallScore: number
  scoreExplanation: string
  startTime: number
  endTime: number
}

export interface HeuristicOptions {
  minSeconds: number
  maxSeconds: number
  maxCandidates: number
}

export function runHeuristicAnalysis(
  segments: TranscriptSegment[],
  opts: HeuristicOptions
): HeuristicCandidate[] {
  if (segments.length === 0) return []

  const minS = Math.max(6, opts.minSeconds * 0.65)
  const maxS = opts.maxSeconds * 1.35

  const candidates: HeuristicCandidate[] = []
  const n = segments.length

  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      const startTime = segments[i].startTime
      const endTime = segments[j].endTime
      const dur = endTime - startTime
      if (dur > maxS) break
      if (dur < minS) continue

      const window = segments.slice(i, j + 1)
      const scored = scoreWindow(window, segments[i - 1], dur, opts)
      if (scored.overallScore < 32) continue

      const text = window.map((s) => s.text.trim()).join(' ')
      candidates.push({
        ...scored,
        startSegmentId: segments[i].id,
        endSegmentId: segments[j].id,
        title: makeTitle(text),
        hook: makeHook(window[0].text),
        reason: scored.scoreExplanation,
        clipType: classify(text),
        transcript: undefined,
        startTime,
        endTime
      })
    }
  }

  // Sort by score, then spread picks across the timeline via time buckets
  candidates.sort((a, b) => b.overallScore - a.overallScore)
  const totalDuration = segments[n - 1].endTime - segments[0].startTime
  const buckets = Math.max(1, opts.maxCandidates)
  const bucketSize = totalDuration / buckets
  const picked: HeuristicCandidate[] = []
  const usedBuckets = new Set<number>()

  for (const cand of candidates) {
    if (picked.length >= opts.maxCandidates) break
    const bucket = Math.floor((cand.startTime - segments[0].startTime) / bucketSize)
    if (usedBuckets.has(bucket)) continue
    // Skip near-duplicates of an already-picked candidate (light pre-dedup;
    // full moment grouping happens in the shared pipeline)
    if (picked.some((p) => overlapFrac(p, cand) > 0.55)) continue
    usedBuckets.add(bucket)
    picked.push(cand)
  }
  // Fill remaining slots with best leftovers
  for (const cand of candidates) {
    if (picked.length >= opts.maxCandidates) break
    if (picked.includes(cand)) continue
    if (picked.some((p) => overlapFrac(p, cand) > 0.55)) continue
    picked.push(cand)
  }

  return picked.sort((a, b) => a.startTime - b.startTime)
}

function overlapFrac(a: { startTime: number; endTime: number }, b: { startTime: number; endTime: number }): number {
  const inter = Math.min(a.endTime, b.endTime) - Math.max(a.startTime, b.startTime)
  if (inter <= 0) return 0
  return inter / Math.min(a.endTime - a.startTime, b.endTime - b.startTime)
}

function scoreWindow(
  window: TranscriptSegment[],
  prev: TranscriptSegment | undefined,
  dur: number,
  opts: HeuristicOptions
): { scores: ScoreBreakdown; overallScore: number; scoreExplanation: string } {
  const text = window.map((s) => s.text.trim()).join(' ')
  const words = text.split(/\s+/).filter(Boolean)
  const wordCount = words.length
  const wps = wordCount / Math.max(1, dur)
  const opening = window.slice(0, 2).map((s) => s.text).join(' ')
  const closing = window[window.length - 1].text

  // Hook: cue strength of the opening
  let hook = 24
  if (QUESTION_PATTERN.test(window[0].text.trim())) hook += 26
  for (const pattern of HOOK_CUE_PATTERNS) {
    if (pattern.test(opening)) hook += 12
  }
  if (NUMBER_PATTERN.test(opening)) hook += 8
  hook = Math.min(100, hook)

  // Context completeness: clean start + complete ending
  let context = 45
  const startsClean = !prev || SENTENCE_END.test(prev.text.trim()) || prev.endTime + 1.2 < window[0].startTime
  if (startsClean) context += 22
  else context -= 12
  if (SENTENCE_END.test(closing.trim())) context += 22
  else context -= 10
  if (INCOMPLETE_STARTERS.test(text.trim())) context -= 14
  context = clamp(context)

  // Clarity: speech rate in the sweet zone + low filler
  let clarity = 70
  if (wps >= 2.1 && wps <= 3.6) clarity += 18
  else if (wps < 1.4 || wps > 4.4) clarity -= 22
  else clarity += 4
  const fillers = (text.match(FILLER_WORDS) ?? []).length
  clarity -= Math.min(25, fillers * 4)
  clarity = clamp(clarity)

  // Retention: question→answer, progression, duration fit
  let retention = 34
  const questionIdx = window.findIndex((s) => Q_TO_ANSWER.test(s.text))
  if (questionIdx !== -1 && questionIdx < window.length - 1) retention += 20
  const progression = (text.match(PROGRESSION_WORDS) ?? []).length
  retention += Math.min(18, progression * 4)
  const idealMid = (opts.minSeconds + opts.maxSeconds) / 2
  const distFromIdeal = Math.abs(dur - idealMid) / idealMid
  retention += Math.round(14 * (1 - Math.min(1, distFromIdeal)))
  retention = clamp(retention)

  // Emotional impact
  const emotionHits = (text.match(new RegExp(EMOTION_WORDS.source, 'gi')) ?? []).length
  const emotional = clamp(30 + emotionHits * 16)

  // Standalone value: overall cue density
  let cueHits = 0
  for (const pattern of HOOK_CUE_PATTERNS) {
    if (pattern.test(text)) cueHits++
  }
  const standalone = clamp(34 + cueHits * 11 + (SENTENCE_END.test(closing.trim()) ? 8 : 0))

  // Shareability: punchy sentences + numbers + superlatives
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0)
  const avgSentenceWords = sentences.length ? wordCount / sentences.length : wordCount
  let shareability = 32
  if (avgSentenceWords > 0 && avgSentenceWords <= 14) shareability += 18
  if (NUMBER_PATTERN.test(text)) shareability += 14
  if (cueHits >= 2) shareability += 12
  shareability = clamp(shareability)

  // Visual suitability: talking-head default, speaker consistency bonus
  const speakers = new Set(window.map((s) => s.speaker).filter(Boolean))
  const visual = clamp(speakers.size <= 1 ? 76 : 66)

  const scores: ScoreBreakdown = {
    hook,
    contextCompleteness: context,
    clarity,
    retention,
    emotionalImpact: emotional,
    standaloneValue: standalone,
    shareability,
    visualSuitability: visual
  }
  const overallScore = aggregateScore(scores)

  const strengths: string[] = []
  const limits: string[] = []
  if (hook >= 60) strengths.push('an opening that creates immediate interest')
  if (context >= 70) strengths.push('a self-contained beginning and ending')
  if (retention >= 60) strengths.push('question→answer progression')
  if (emotional >= 55) strengths.push('emotionally charged language')
  if (hook < 45) limits.push('the opening line is not a strong hook')
  if (context < 55) limits.push('the clip starts or ends mid-thought')
  if (clarity < 55) limits.push('speech pace or filler words reduce clarity')

  const scoreExplanation =
    `Heuristic estimate: this window matches ${cueHits} cue pattern${cueHits === 1 ? '' : 's'} ` +
    `(${strengths.length ? strengths.join(', ') : 'a complete thought with sensible duration'}).` +
    (limits.length ? ` Limits: ${limits.join('; ')}.` : '') +
    ' Produced by the local heuristic analyzer — configure an AI provider for semantic quality.'

  return { scores, overallScore, scoreExplanation }
}

function clamp(n: number): number {
  return Math.round(Math.min(100, Math.max(0, n)))
}

function makeTitle(text: string): string {
  const firstSentence = text.split(/(?<=[.!?])\s+/)[0] ?? text
  const words = firstSentence.replace(/^[^A-Za-z0-9"']+/, '').split(/\s+/)
  let title = words.slice(0, 9).join(' ')
  if (words.length > 9) title += '…'
  title = title.replace(/["""]./g, (m) => m).trim()
  return title || 'Notable moment'
}

function makeHook(text: string): string {
  const words = text.trim().split(/\s+/).slice(0, 12).join(' ')
  return words
}

function classify(text: string): RawCandidate['clipType'] {
  if (QUESTION_PATTERN.test(text.split(/(?<=[.!?])\s+/)[0] ?? '')) return 'question-answer'
  if (/\bi (learned|realized|discovered|failed|made a mistake)\b/i.test(text)) return 'lesson'
  if (/\b(when i|back in|one time|story)\b/i.test(text)) return 'story'
  if (EMOTION_WORDS.test(text)) return 'emotional-moment'
  if (/\b(i think|i believe|in my opinion|the truth is|honestly)\b/i.test(text)) return 'strong-opinion'
  if (/\b(you should|you need to|here's how|the key is|advice)\b/i.test(text)) return 'advice'
  if (NUMBER_PATTERN.test(text) && /\b(grew|revenue|users|percent|million|billion)\b/i.test(text)) return 'surprising-fact'
  if (/\b(funny|hilarious|laugh|joke)\b/i.test(text)) return 'humor'
  return 'other'
}
