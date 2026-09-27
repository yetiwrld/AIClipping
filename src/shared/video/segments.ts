import type { CaptionCue } from '../captions/segmentation'

/**
 * Multi-segment clip math (silence removal). A clip keeps its single
 * startTime/endTime source window; `silenceCuts` records removed sub-ranges in
 * SOURCE time. Kept ranges are the complement of the cuts inside the window.
 * Preview and render both derive everything from these pure functions, which
 * keeps preview/render parity (§62-63).
 */

export interface TimeSegment {
  start: number
  end: number
}

/** Sort + merge overlapping/touching cut ranges; drop invalid ones. */
export function normalizeCuts(cuts: TimeSegment[]): TimeSegment[] {
  const valid = cuts
    .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end - c.start > 0.02)
    .map((c) => ({ start: Math.max(0, c.start), end: c.end }))
    .sort((a, b) => a.start - b.start)
  const merged: TimeSegment[] = []
  for (const c of valid) {
    const last = merged[merged.length - 1]
    if (last && c.start <= last.end + 0.01) {
      last.end = Math.max(last.end, c.end)
    } else {
      merged.push({ ...c })
    }
  }
  return merged
}

/** Complement of cuts inside [floor, ceil] — the kept source ranges. */
export function keptSegments(floor: number, ceil: number, cuts: TimeSegment[]): TimeSegment[] {
  const norm = normalizeCuts(cuts)
  const kept: TimeSegment[] = []
  let cursor = floor
  for (const c of norm) {
    if (c.end <= floor || c.start >= ceil) continue
    const start = Math.max(c.start, floor)
    const end = Math.min(c.end, ceil)
    if (start - cursor > 0.02) kept.push({ start: cursor, end: start })
    cursor = Math.max(cursor, end)
  }
  if (ceil - cursor > 0.02) kept.push({ start: cursor, end: ceil })
  if (kept.length === 0) kept.push({ start: floor, end: ceil })
  return kept
}

export function keptDuration(kept: TimeSegment[]): number {
  return kept.reduce((s, k) => s + (k.end - k.start), 0)
}

/**
 * Map a source timestamp to output-local time.
 * Returns null when the timestamp falls strictly inside a removed range
 * (cut boundaries themselves map onto the adjacent kept edge).
 */
export function remapTime(sourceTime: number, kept: TimeSegment[]): number | null {
  let acc = 0
  for (const k of kept) {
    if (sourceTime < k.start) return null // strictly inside a cut
    if (sourceTime <= k.end) return acc + (sourceTime - k.start)
    acc += k.end - k.start
  }
  return null // after the last kept segment
}

/**
 * Remap caption cues onto the kept (silence-removed) timeline.
 * Words inside removed ranges collapse to the cut point; cues fully inside a
 * removed range are dropped. Cue keys are preserved so user text edits and
 * timing offsets keep applying (§61).
 */
export function remapCuesToKept(cues: CaptionCue[], kept: TimeSegment[]): CaptionCue[] {
  if (kept.length === 0) return cues
  const out: CaptionCue[] = []
  for (const cue of cues) {
    const words: CaptionCue['words'] = []
    for (const w of cue.words) {
      const s = remapTime(w.start, kept)
      const e = remapTime(Math.min(w.end, kept[kept.length - 1].end), kept)
      if (s === null && e === null) continue // fully removed
      const start = s ?? (e as number) // word starts inside a cut → collapse to where it exits
      const end = e ?? start
      const prev = words[words.length - 1]
      if (prev && start < prev.end) {
        words.push({ text: w.text, start: prev.end, end: Math.max(prev.end + 0.04, end) })
      } else if (start >= (prev ? prev.end : 0) - 0.001) {
        words.push({ text: w.text, start, end: Math.max(end, start + 0.04) })
      }
    }
    if (words.length === 0) continue
    const start = words[0].start
    const end = Math.max(words[words.length - 1].end, start + 0.2)
    out.push({
      ...cue,
      startTime: start,
      endTime: end,
      words
    })
  }
  return out
}

/** -ss/-t pairs for ffmpeg filter_complex segment concat. */
export function segmentDraws(kept: TimeSegment[]): Array<{ seek: number; duration: number }> {
  return kept.map((k) => ({ seek: k.start, duration: Math.max(0.04, k.end - k.start) }))
}
