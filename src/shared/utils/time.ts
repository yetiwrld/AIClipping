/** Time utilities. Pure, shared by main and renderer. */

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 83.46 → "1:23" (or "1:23.4" with ms); 3600 → "1:00:00" — compact UI display. */
export function formatClock(seconds: number, showMs = false): string {
  const safe = Math.max(0, seconds)
  const h = Math.floor(safe / 3600)
  const m = Math.floor((safe % 3600) / 60)
  const s = Math.floor(safe % 60)
  const base = h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
  if (!showMs) return base
  const ms = Math.floor((safe % 1) * 10)
  return `${base}.${ms}`
}

/** 83.46 → "00:01:23,400" (SRT) */
export function formatSrtTime(seconds: number): string {
  const safe = Math.max(0, seconds)
  const h = Math.floor(safe / 3600)
  const m = Math.floor((safe % 3600) / 60)
  const s = Math.floor(safe % 60)
  const ms = Math.round((safe % 1) * 1000)
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${String(ms).padStart(3, '0')}`
}

/** 83.46 → "00:01:23.400" (WebVTT / ASS) */
export function formatVttTime(seconds: number): string {
  return formatSrtTime(seconds).replace(',', '.')
}

/** ASS timestamps use centiseconds: 83.46 → "0:01:23.46" */
export function formatAssTime(seconds: number): string {
  const safe = Math.max(0, seconds)
  const h = Math.floor(safe / 3600)
  const m = Math.floor((safe % 3600) / 60)
  const s = Math.floor(safe % 60)
  const cs = Math.round((safe % 1) * 100)
  return `${h}:${pad2(m)}:${pad2(s)}.${String(Math.min(99, cs)).padStart(2, '0')}`
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** "00:01:23,400" | "0:01:23.4" | "83.4" | 83.4 → seconds */
export function parseTimestamp(input: string | number): number | null {
  if (typeof input === 'number') return Number.isFinite(input) && input >= 0 ? input : null
  const trimmed = input.trim()
  if (!trimmed) return null

  // hh:mm:ss(.|,)ms  or  mm:ss(.|,)ms
  const m = trimmed.match(
    /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/
  )
  if (m) {
    const h = m[1] ? parseInt(m[1], 10) : 0
    const min = parseInt(m[2], 10)
    const s = parseInt(m[3], 10)
    const frac = m[4] ? parseFloat(`0.${m[4]}`) : 0
    if (min >= 60 || s >= 60) return null
    return h * 3600 + min * 60 + s + frac
  }

  // "[00:01:23]" or "(0:01:23)" bracketed
  const b = trimmed.match(/^[\[(](.+?)[\])]$/)
  if (b) return parseTimestamp(b[1])

  // plain seconds
  if (/^\d+(\.\d+)?$/.test(trimmed)) return parseFloat(trimmed)
  return null
}

export function isValidRange(start: number, end: number, duration?: number | null): boolean {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false
  if (start < 0 || end <= start) return false
  if (duration != null && end > duration + 0.05) return false
  return true
}

/** Overlap ratio (intersection over the shorter range), 0..1 */
export function overlapRatio(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  const inter = Math.min(aEnd, bEnd) - Math.max(aStart, bStart)
  if (inter <= 0) return 0
  const shorter = Math.min(aEnd - aStart, bEnd - bStart)
  return shorter > 0 ? inter / shorter : 0
}
