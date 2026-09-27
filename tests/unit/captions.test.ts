import { describe, it, expect } from 'vitest'
import { buildCues, cueAt, wordIndexAt, segmentToWords } from '@shared/captions/segmentation'
import { buildAssDocument } from '@shared/captions/ass'
import { buildSrtDocument } from '@shared/captions/srt'
import { CAPTION_STYLES, getCaptionStyle } from '@shared/constants'
import type { CaptionCue } from '@shared/captions/segmentation'

// TranscriptSegment.words uses WordTiming {word, start, end}
const seg = (id: number, start: number, end: number, text: string) => ({
  id, startTime: start, endTime: end, text,
  words: text.split(' ').map((w, i, arr) => ({
    word: w,
    start: start + ((end - start) * i) / arr.length,
    end: start + ((end - start) * (i + 1)) / arr.length
  }))
})

const SEGMENTS = [
  seg(0, 0, 2.0, 'welcome back everyone'),
  seg(1, 2.0, 4.5, 'today we do something different')
]

function boxedStyle() {
  return CAPTION_STYLES.find((s) => s.boxOpacity > 0) ?? CAPTION_STYLES[0]
}

describe('caption segmentation', () => {
  it('segmentToWords uses word timings when present', () => {
    const words = segmentToWords(SEGMENTS[0])
    expect(words).toHaveLength(3)
    expect(words[0].text).toBe('welcome')
    expect(words[0].start).toBe(0)
    expect(words[2].end).toBeCloseTo(2.0, 5)
  })

  it('segmentToWords synthesizes even timings when a segment has no words', () => {
    const bare = { ...SEGMENTS[0], words: [] }
    const words = segmentToWords(bare)
    expect(words).toHaveLength(3)
    expect(words[1].start).toBeGreaterThan(0)
  })

  it('segmentToWords falls back to segment bounds on malformed word timings', () => {
    const broken = { ...SEGMENTS[0], words: [{ word: 'welcome' }, { word: 'back' }] as never[] }
    const words = segmentToWords(broken)
    expect(words).toHaveLength(3)
    for (const w of words) {
      expect(w.start).toBeGreaterThanOrEqual(SEGMENTS[0].startTime)
      expect(w.end).toBeLessThanOrEqual(SEGMENTS[0].endTime + 0.001)
    }
  })

  it('buildCues groups up to maxWordsPerCue words', () => {
    const cues = buildCues(SEGMENTS, { maxWordsPerCue: 2, maxCharsPerLine: 30, maxLines: 2 })
    expect(cues.length).toBeGreaterThanOrEqual(3)
    for (const cue of cues) {
      expect(cue.words.length).toBeLessThanOrEqual(2)
      expect(cue.endTime).toBeGreaterThan(cue.startTime)
    }
  })

  it('buildCues clamps to a trim window', () => {
    const cues = buildCues(SEGMENTS, { maxWordsPerCue: 1, maxCharsPerLine: 30, maxLines: 1, fromTime: 2.0, toTime: 4.5 })
    expect(cues.length).toBeGreaterThan(0)
    for (const cue of cues) {
      // a word overlapping the from-boundary is kept whole (no mid-word cuts)
      expect(cue.startTime).toBeGreaterThanOrEqual(1.3)
      expect(cue.endTime).toBeLessThanOrEqual(4.5 + 0.05)
    }
  })

  it('applies user text edits keyed by cue key', () => {
    const cues = buildCues(SEGMENTS, { maxWordsPerCue: 2, maxCharsPerLine: 40, maxLines: 2 })
    const key = cues[0].key
    const edited = buildCues(SEGMENTS, {
      maxWordsPerCue: 2, maxCharsPerLine: 40, maxLines: 2,
      textEdits: { [key]: 'WELCOME BACK!' }
    })
    expect(edited[0].text).toBe('WELCOME BACK!')
    expect(edited[0].lines.join(' ')).toBe('WELCOME BACK!')
  })

  it('cueAt finds the active cue and null outside ranges', () => {
    const cues: CaptionCue[] = [
      { key: 'c0', startTime: 1, endTime: 2, text: 'a', words: [], lines: ['a'] },
      { key: 'c1', startTime: 3, endTime: 4, text: 'b', words: [], lines: ['b'] }
    ]
    expect(cueAt(cues, 1.5)?.key).toBe('c0')
    expect(cueAt(cues, 3.999)?.key).toBe('c1')
    expect(cueAt(cues, 2.5)).toBeNull()
    expect(cueAt(cues, 0)).toBeNull()
  })

  it('wordIndexAt tracks karaoke position inside a cue', () => {
    const cue: CaptionCue = {
      key: 'c', startTime: 0, endTime: 3, text: 'one two three', lines: [],
      words: [
        { text: 'one', start: 0, end: 1 },
        { text: 'two', start: 1, end: 2 },
        { text: 'three', start: 2, end: 3 }
      ]
    }
    expect(wordIndexAt(cue, 0.2)).toBe(0)
    expect(wordIndexAt(cue, 1.5)).toBe(1)
    expect(wordIndexAt(cue, 2.9)).toBe(2)
    expect(wordIndexAt(cue, 9)).toBe(2) // clamped
  })
})

describe('ASS document builder', () => {
  const cues: CaptionCue[] = [
    {
      key: 'c0', startTime: 0.5, endTime: 2.5, text: 'hello world', lines: ['hello world'],
      words: [
        { text: 'hello', start: 0.5, end: 1.5 },
        { text: 'world', start: 1.5, end: 2.5 }
      ]
    }
  ]

  it('emits script info with default 1080x1920 play res', () => {
    const doc = buildAssDocument(cues, { style: getCaptionStyle('classic') })
    expect(doc).toContain('PlayResX: 1080')
    expect(doc).toContain('PlayResY: 1920')
    expect(doc).toContain('[Events]')
    expect(doc).toContain('WrapStyle: 2')
  })

  it('uses karaoke tags when emphasis is on', () => {
    const doc = buildAssDocument(cues, { style: getCaptionStyle('classic'), emphasis: true })
    expect(doc).toContain('\\kf')
  })

  it('plain (non-emphasis) dialogue has no karaoke tags', () => {
    const doc = buildAssDocument(cues, { style: getCaptionStyle('classic'), emphasis: false })
    expect(doc).not.toContain('\\kf')
  })

  it('uses BorderStyle 3 (box) only for box styles, else 1 (outline)', () => {
    const boxed = buildAssDocument(cues, { style: boxedStyle() })
    expect(boxed).toMatch(/BorderStyle: 3|,3,/)

    const outlined = buildAssDocument(cues, { style: { ...getCaptionStyle('classic'), boxOpacity: 0 } })
    expect(outlined).toMatch(/,1,/)
  })

  it('encodes colors as ASS &HAABBGGRR (BGR order)', () => {
    const doc = buildAssDocument(cues, {
      style: { ...getCaptionStyle('classic'), textColor: '#FF0000', boxOpacity: 0 }
    })
    // #FF0000 (pure red) → BBGGRR = 0000FF
    expect(doc).toMatch(/&H[0-9A-F]{2}0000FF/i)
  })

  it('uppercases text when requested', () => {
    const doc = buildAssDocument(cues, { style: getCaptionStyle('classic'), uppercase: true, emphasis: false })
    expect(doc).toContain('HELLO WORLD')
  })

  it('times dialogue lines in ASS format and positions them', () => {
    const doc = buildAssDocument(cues, { style: getCaptionStyle('classic') })
    expect(doc).toMatch(/Dialogue: 0,0:00:00\.50,0:00:02\.50,Main/)
    expect(doc).toContain('{\\pos(540,')
  })

  it('scales font size from % of play height', () => {
    const doc = buildAssDocument(cues, { style: { ...getCaptionStyle('classic'), fontSizePct: 5 } })
    // 5% of 1920 = 96
    expect(doc).toMatch(/Main,Inter[^,]*,96,/)
  })
})

describe('SRT document builder', () => {
  it('renders numbered blocks with comma timestamps', () => {
    const cues: CaptionCue[] = [
      { key: 'c0', startTime: 0, endTime: 1.5, text: 'first', words: [], lines: ['first'] },
      { key: 'c1', startTime: 2, endTime: 3.25, text: 'second', words: [], lines: ['second'] }
    ]
    const doc = buildSrtDocument(cues)
    expect(doc).toContain('1\n00:00:00,000 --> 00:00:01,500\nfirst')
    expect(doc).toContain('2\n00:00:02,000 --> 00:00:03,250\nsecond')
  })
})

describe('caption style catalog', () => {
  it('exposes six distinct presets with unique ids', () => {
    expect(CAPTION_STYLES.length).toBe(6)
    const ids = new Set(CAPTION_STYLES.map((s) => s.id))
    expect(ids.size).toBe(6)
  })

  it('getCaptionStyle falls back for unknown ids', () => {
    const style = getCaptionStyle('does-not-exist')
    expect(style).toBeDefined()
    expect(CAPTION_STYLES.some((s) => s.id === style.id)).toBe(true)
  })
})
