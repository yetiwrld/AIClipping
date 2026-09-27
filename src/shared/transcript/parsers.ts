import { parseTimestamp } from '../utils/time'
import { transcriptResultSchema } from '../schemas'
import type { TranscriptResult } from '../types'
import { AppError } from '../errors'

/**
 * Transcript file parsers: SRT, WebVTT, Clipwright JSON, and
 * timestamped plain text. Pure functions — heavily unit tested.
 */

interface RawCue {
  start: number
  end: number
  text: string
}

function parseCueTime(line: string): { start: number; end: number } | null {
  // "00:00:01,000 --> 00:00:04,200" (SRT) or "00:01.000 --> 00:04.200" (VTT)
  const m = line.match(/^\s*(\S+)\s*-->\s*(\S+)/)
  if (!m) return null
  const start = parseTimestamp(m[1])
  const end = parseTimestamp(m[2].split(' ')[0])
  if (start == null || end == null || end <= start) return null
  return { start, end }
}

/** Strip HTML/VTT markup and inline cue settings from cue text. */
function cleanCueText(lines: string[]): string {
  return lines
    .join(' ')
    .replace(/<\/?[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function cuesFromBlocks(blocks: string[]): RawCue[] {
  const cues: RawCue[] = []
  for (const block of blocks) {
    const lines = block
      .split(/\r?\n/)
      .map((l) => l.trimEnd())
      .filter((l) => l.trim().length > 0)
    if (lines.length === 0) continue
    const timeLineIndex = lines.findIndex((l) => l.includes('-->'))
    if (timeLineIndex === -1) continue
    const time = parseCueTime(lines[timeLineIndex])
    if (!time) continue
    const text = cleanCueText(lines.slice(timeLineIndex + 1))
    if (!text) continue
    cues.push({ ...time, text })
  }
  return cues
}

export function parseSrt(content: string): RawCue[] {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  return cuesFromBlocks(normalized.split(/\n{2,}/))
}

export function parseVtt(content: string): RawCue[] {
  const normalized = content
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/^WEBVTT[^\n]*\n/, '')
    .replace(/^(NOTE|STYLE|REGION)[\s\S]*?\n\n/gm, '')
  return cuesFromBlocks(normalized.split(/\n{2,}/))
}

/**
 * Timestamped plain text, one utterance per line:
 *   [00:01:23] This is what happened.
 *   00:01:30 - And then we changed everything.
 *   (0:01:35) Numbers matter.
 * If a line has no timestamp it is appended to the previous cue; a missing
 * end time is inferred from the next cue's start.
 */
export function parseTimestampedText(content: string): RawCue[] {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/)
  const entries: Array<{ time: number; text: string }> = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const m = line.match(/^[\[(]?((?:\d+:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)[\])]?\s*(?:[-–—]\s*)?(.*)$/)
    if (m) {
      const t = parseTimestamp(m[1])
      if (t != null) {
        entries.push({ time: t, text: m[2].trim() })
        continue
      }
    }
    if (entries.length > 0) entries[entries.length - 1].text += ` ${line}`
  }
  return entries
    .filter((e) => e.text.length > 0)
    .map((e, i, arr) => {
      const next = arr[i + 1]
      const end = next ? Math.max(e.time + 0.5, next.time - 0.05) : e.time + 3
      return { start: e.time, end, text: e.text }
    })
}

export function cuesToTranscriptResult(cues: RawCue[], language: string | null = null): TranscriptResult {
  // Merge micro-cues into more substantial segments (min 1.2s / 20 chars)
  const merged: RawCue[] = []
  for (const cue of cues) {
    const prev = merged[merged.length - 1]
    if (prev && (prev.text.length < 20 || prev.end - prev.start < 1.2) && cue.start - prev.end < 0.4) {
      prev.end = cue.end
      prev.text = `${prev.text} ${cue.text}`.replace(/\s+/g, ' ')
    } else {
      merged.push({ ...cue })
    }
  }
  return {
    language,
    segments: merged.map((c) => ({ start: c.start, end: c.end, text: c.text }))
  }
}

/** Detect + parse a transcript file by extension and content. */
export function parseTranscriptFile(filename: string, content: string): TranscriptResult {
  const ext = filename.toLowerCase().split('.').pop() ?? ''
  let result: TranscriptResult

  if (ext === 'json') {
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      throw new AppError('TRANSCRIPT_INVALID_JSON', 'The transcript JSON file could not be parsed.', 'Open the file in a text editor and verify it is valid JSON, or import an SRT/VTT instead.')
    }
    const validated = transcriptResultSchema.safeParse(parsed)
    if (!validated.success) {
      throw new AppError(
        'TRANSCRIPT_INVALID_SCHEMA',
        'The JSON file does not match the expected transcript format.',
        'Expected: { "segments": [{ "start": 0.0, "end": 4.2, "text": "..." }] }',
        validated.error.message
      )
    }
    result = validated.data as TranscriptResult
    if (result.segments.some((s) => s.end <= s.start)) {
      throw new AppError('TRANSCRIPT_INVALID_RANGES', 'Some transcript segments have end times before their start times.')
    }
    return result
  }

  if (ext === 'vtt') result = cuesToTranscriptResult(parseVtt(content))
  else if (ext === 'srt') result = cuesToTranscriptResult(parseSrt(content))
  else result = cuesToTranscriptResult(parseTimestampedText(content))

  if (result.segments.length === 0) {
    throw new AppError(
      'TRANSCRIPT_EMPTY',
      'No timestamped lines were found in this file.',
      'Supported: SRT, WebVTT, Clipwright JSON, or plain text with [hh:mm:ss] prefixes.'
    )
  }
  return result
}
