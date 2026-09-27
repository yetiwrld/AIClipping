import { describe, it, expect } from 'vitest'
import { parseSrt, parseVtt, parseTimestampedText, parseTranscriptFile, cuesToTranscriptResult } from '@shared/transcript/parsers'

const SRT = `1
00:00:01,000 --> 00:00:03,500
Welcome back everyone

2
00:00:04,000 --> 00:00:06,200
Today we do something
different
`

const VTT = `WEBVTT

00:01.000 --> 00:03.500
Welcome back everyone

00:04.000 --> 00:06.200
Today we do something different
`

describe('transcript parsers', () => {
  it('parseSrt reads blocks, tolerates multiline text', () => {
    const cues = parseSrt(SRT)
    expect(cues).toHaveLength(2)
    expect(cues[0].start).toBe(1)
    expect(cues[0].end).toBe(3.5)
    expect(cues[1].text).toBe('Today we do something different')
  })

  it('parseSrt skips malformed blocks instead of throwing', () => {
    const broken = `garbage line

1
not a timestamp --> here
text

2
00:00:01,000 --> 00:00:02,000
valid
`
    const cues = parseSrt(broken)
    expect(cues).toHaveLength(1)
    expect(cues[0].text).toBe('valid')
  })

  it('parseVtt handles WEBVTT header and dot timestamps', () => {
    const cues = parseVtt(VTT)
    expect(cues).toHaveLength(2)
    expect(cues[0].start).toBe(1)
    expect(cues[1].end).toBe(6.2)
  })

  it('parseTimestampedText accepts [mm:ss] / [hh:mm:ss] prefixes', () => {
    const text = `[0:00] Welcome back
[0:04] Today we do something different
`
    const cues = parseTimestampedText(text)
    expect(cues).toHaveLength(2)
    expect(cues[0].start).toBe(0)
    expect(cues[1].start).toBe(4)
    // cue end extends just before the next cue's start
    expect(cues[0].end).toBeCloseTo(3.95, 5)
  })

  it('cuesToTranscriptResult tags language and merges micro-cues', () => {
    const cues = parseSrt(SRT)
    const result = cuesToTranscriptResult(cues, 'en')
    expect(result.language).toBe('en')
    expect(result.segments).toHaveLength(2)
    expect(result.segments[0].text).toBe('Welcome back everyone')
    expect(result.segments[0].start).toBe(1)
    expect(result.segments[0].end).toBe(3.5)
  })

  it('cuesToTranscriptResult merges tiny adjacent cues into substantial segments', () => {
    const tiny = [
      { start: 0, end: 0.4, text: 'a' },        // < 1.2s & < 20 chars
      { start: 0.5, end: 1.0, text: 'b c d' },  // adjacent (< 0.4s gap)
      { start: 3.0, end: 5.0, text: 'separate long enough cue here' }
    ]
    const result = cuesToTranscriptResult(tiny)
    expect(result.segments).toHaveLength(2)
    expect(result.segments[0].text).toBe('a b c d')
    expect(result.segments[1].text).toContain('separate')
  })

  it('parseTranscriptFile dispatches by extension', () => {
    const fromSrt = parseTranscriptFile('a.srt', SRT)
    expect(fromSrt.segments).toHaveLength(2)

    const fromTxt = parseTranscriptFile('a.txt', '[0:01] hello there')
    expect(fromTxt.segments).toHaveLength(1)
    expect(fromTxt.segments[0].text).toBe('hello there')
  })

  it('parseTranscriptFile accepts raw JSON (whisper-style)', () => {
    const json = JSON.stringify({
      language: 'en',
      duration: 6.2,
      segments: [
        { start: 1, end: 3.5, text: 'Welcome back', words: [{ word: 'Welcome', start: 1, end: 2 }, { word: 'back', start: 2, end: 3.5 }] }
      ]
    })
    const result = parseTranscriptFile('a.json', json)
    expect(result.segments).toHaveLength(1)
    expect(result.segments[0].words).toHaveLength(2)
    expect(result.segments[0].words?.[0].word).toBe('Welcome')
  })

  it('rejects unknown transcript extensions', () => {
    expect(() => parseTranscriptFile('a.docx', 'x')).toThrow()
  })
})
