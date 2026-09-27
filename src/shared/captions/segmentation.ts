import type { TranscriptSegment, WordTiming } from '../types'

/**
 * Caption cue construction. This module is the single source of truth for
 * caption text/timing: the editor's DOM preview and the ASS renderer both
 * call buildCues(), so preview and rendered output stay in sync.
 */

export interface CaptionWord {
  text: string
  start: number
  end: number
}

export interface CaptionCue {
  /** Stable key used for user text edits: `${index}:${startSeconds}` */
  key: string
  startTime: number
  endTime: number
  words: CaptionWord[]
  /** Raw (or user-edited) cue text */
  text: string
  /** Pre-wrapped display lines */
  lines: string[]
}

export interface CaptionBuildOptions {
  maxWordsPerCue: number
  maxCharsPerLine: number
  maxLines: number
  /** Break early at sentence-ending punctuation after this many seconds */
  sentenceBreakAfterSec?: number
  /** User text edits keyed by cue key */
  textEdits?: Record<string, string>
  /** Split the cue with this key after N words (cue editing). */
  splits?: Record<string, number>
  /** Merge the cue with this key into the following cue (cue editing). */
  merges?: Record<string, boolean>
  /** Per-cue timing shifts in seconds, keyed by cue key. */
  timingOffsets?: Record<string, number>
  /** Clamp cues to this window (clip trim) */
  fromTime?: number
  toTime?: number
}

const PUNCTUATION_END = /[.!?…]["')]?$/

/** Flatten a segment into words with timing (distributed proportionally when the
 *  provider did not give word timestamps). */
export function segmentToWords(segment: Pick<TranscriptSegment, 'startTime' | 'endTime' | 'text' | 'words'>): CaptionWord[] {
  const tokens = segment.text.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return []

  if (segment.words && segment.words.length > 0) {
    // Provider word timings: align to tokens best-effort
    const words: CaptionWord[] = []
    let wi = 0
    for (const token of tokens) {
      const clean = token.replace(/[^\p{L}\p{N}']/gu, '')
      let match = segment.words[wi]
      while (
        match &&
        typeof match.word === 'string' &&
        !match.word.trim().startsWith(clean.slice(0, Math.min(3, clean.length))) &&
        wi < segment.words.length - 1
      ) {
        wi++
        match = segment.words[wi]
      }
      if (match && typeof match.word === 'string' && Number.isFinite(match.start) && Number.isFinite(match.end)) {
        words.push({ text: token, start: match.start, end: Math.max(match.end, match.start + 0.04) })
        wi++
      } else {
        // timing list exhausted or malformed — fall back to segment bounds
        words.push({ text: token, start: segment.startTime, end: segment.endTime })
      }
    }
    return words
  }

  // Distribute by character weight
  const totalChars = tokens.reduce((n, t) => n + t.length + 1, 0)
  const dur = Math.max(0.2, segment.endTime - segment.startTime)
  let cursor = segment.startTime
  return tokens.map((t) => {
    const share = ((t.length + 1) / totalChars) * dur
    const w = { text: t, start: cursor, end: cursor + share }
    cursor += share
    return w
  })
}

/** Balance words into ≤ maxLines lines of ≤ maxCharsPerLine characters. */
export function wrapLines(words: CaptionWord[], maxCharsPerLine: number, maxLines: number): string[] {
  const texts = words.map((w) => w.text)
  if (texts.length === 0) return []
  // Greedy fill, then rebalance pairs into two lines when possible
  const lines: string[] = []
  let current: string[] = []
  for (const t of texts) {
    const candidate = [...current, t].join(' ')
    if (candidate.length > maxCharsPerLine && current.length > 0) {
      lines.push(current.join(' '))
      current = [t]
    } else {
      current.push(t)
    }
  }
  if (current.length) lines.push(current.join(' '))

  if (lines.length > maxLines) {
    // Hard-limit: merge overflow into the last allowed line
    const kept = lines.slice(0, maxLines - 1)
    kept.push(lines.slice(maxLines - 1).join(' '))
    return kept
  }

  // Two-line rebalance for nicer centering
  if (lines.length === 2 && maxLines >= 2) {
    const a = lines[0]
    const b = lines[1]
    if (Math.abs(a.length - b.length) > Math.max(3, a.length * 0.45)) {
      const wordsA = a.split(' ')
      const wordsB = b.split(' ')
      const all = [...wordsA, ...wordsB]
      const mid = Math.ceil(all.length / 2)
      const l1 = all.slice(0, mid).join(' ')
      const l2 = all.slice(mid).join(' ')
      if (l1.length <= maxCharsPerLine && l2.length <= maxCharsPerLine) return [l1, l2]
    }
  }
  return lines
}

export function buildCues(
  segments: Array<Pick<TranscriptSegment, 'startTime' | 'endTime' | 'text' | 'words'>>,
  opts: CaptionBuildOptions
): CaptionCue[] {
  const from = opts.fromTime ?? 0
  const to = opts.toTime ?? Number.POSITIVE_INFINITY
  const sentenceBreak = opts.sentenceBreakAfterSec ?? 1.4

  const allWords: CaptionWord[] = []
  for (const seg of segments) {
    if (seg.endTime < from || seg.startTime > to) continue
    for (const w of segmentToWords(seg)) {
      if (w.end < from || w.start > to) continue
      allWords.push(w)
    }
  }

  const cues: CaptionCue[] = []
  let current: CaptionWord[] = []

  const flush = () => {
    if (current.length === 0) return
    const start = current[0].start
    const end = current[current.length - 1].end
    const text = current.map((w) => w.text).join(' ')
    const key = `${cues.length}:${start.toFixed(2)}`
    const edited = opts.textEdits?.[key]
    const finalText = (edited ?? text).trim()
    cues.push({
      key,
      startTime: start,
      endTime: Math.max(end, start + 0.3),
      words: current,
      text: finalText,
      lines: wrapLines(
        edited
          ? edited.trim().split(/\s+/).map((t) => ({ text: t, start, end }))
          : current,
        opts.maxCharsPerLine,
        opts.maxLines
      )
    })
    current = []
  }

  for (let i = 0; i < allWords.length; i++) {
    const w = allWords[i]
    current.push(w)
    const next = allWords[i + 1]
    const dur = current[current.length - 1].end - current[0].start
    const chars = current.reduce((n, x) => n + x.text.length + 1, 0)

    let breakHere = false
    if (current.length >= opts.maxWordsPerCue) breakHere = true
    else if (chars >= opts.maxCharsPerLine * opts.maxLines) breakHere = true
    else if (dur >= 3.2) breakHere = true
    else if (PUNCTUATION_END.test(w.text) && dur >= sentenceBreak) breakHere = true
    else if (next && next.start - w.end > 0.7) breakHere = true

    if (breakHere) flush()
  }
  flush()
  return applyCueEdits(cues, opts)
}

/** Apply user cue edits (split / merge / timing shifts) to built cues. */
function applyCueEdits(cues: CaptionCue[], opts: CaptionBuildOptions): CaptionCue[] {
  let out = cues

  // --- splits ---
  if (opts.splits && Object.keys(opts.splits).length > 0) {
    const next: CaptionCue[] = []
    for (const cue of out) {
      const after = opts.splits[cue.key]
      if (
        after !== undefined && Number.isFinite(after) &&
        after >= 1 && after < cue.words.length
      ) {
        const a = cue.words.slice(0, after)
        const b = cue.words.slice(after)
        const mk = (words: CaptionWord[], suffix: string): CaptionCue => {
          const start = words[0].start
          const end = Math.max(words[words.length - 1].end, start + 0.2)
          const text = words.map((w) => w.text).join(' ')
          return {
            key: `${cue.key}/${suffix}`,
            startTime: start,
            endTime: end,
            words,
            text,
            lines: wrapLines(words, opts.maxCharsPerLine, opts.maxLines)
          }
        }
        next.push(mk(a, 'a'), mk(b, 'b'))
      } else {
        next.push(cue)
      }
    }
    out = next
  }

  // --- merges ---
  if (opts.merges && Object.keys(opts.merges).length > 0) {
    const next: CaptionCue[] = []
    for (let i = 0; i < out.length; i++) {
      const cue = out[i]
      if (opts.merges[cue.key] && i + 1 < out.length) {
        const b = out[i + 1]
        const words = [...cue.words, ...b.words]
        const start = cue.startTime
        const end = Math.max(b.endTime, start + 0.2)
        const text = `${cue.text} ${b.text}`.trim()
        next.push({
          key: cue.key,
          startTime: start,
          endTime: end,
          words,
          text,
          lines: wrapLines(words, opts.maxCharsPerLine, opts.maxLines + 1)
        })
        i++ // consumed b
      } else {
        next.push(cue)
      }
    }
    out = next
  }

  // --- timing offsets ---
  if (opts.timingOffsets && Object.keys(opts.timingOffsets).length > 0) {
    for (let i = 0; i < out.length; i++) {
      const cue = out[i]
      const off = opts.timingOffsets[cue.key]
      if (off === undefined || !Number.isFinite(off) || off === 0) continue
      const prev = out[i - 1]
      const nxt = out[i + 1]
      let start = cue.startTime + off
      let end = cue.endTime + off
      // clamp: keep 40ms inside neighbours
      if (prev) start = Math.max(start, prev.endTime + 0.04)
      if (nxt) end = Math.min(end, nxt.startTime - 0.04)
      if (end - start < 0.15) continue
      const shift = start - cue.startTime
      cue.startTime = start
      cue.endTime = end
      cue.words = cue.words.map((w) => ({ ...w, start: w.start + shift, end: w.end + shift }))
    }
  }

  return out
}

/** The cue active at a given time (for preview + highlight). */
export function cueAt(cues: CaptionCue[], time: number): CaptionCue | null {
  for (const cue of cues) {
    if (time >= cue.startTime && time <= cue.endTime) return cue
  }
  return null
}

/** The word active at a given time (for emphasis highlighting in preview). */
export function wordIndexAt(cue: CaptionCue, time: number): number {
  let idx = 0
  for (let i = 0; i < cue.words.length; i++) {
    if (time >= cue.words[i].start) idx = i
  }
  return idx
}

export function toWordTimings(words: CaptionWord[]): WordTiming[] {
  return words.map((w) => ({ word: w.text, start: w.start, end: w.end }))
}
