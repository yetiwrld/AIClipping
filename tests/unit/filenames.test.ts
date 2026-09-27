import { describe, it, expect } from 'vitest'
import { sanitizeFilename, slugify, uniqueName, formatExportFilename } from '@shared/utils/filenames'

describe('sanitizeFilename (Windows-primary)', () => {
  it('strips characters illegal on Windows/macOS/Linux', () => {
    const out = sanitizeFilename('a<b>c:d"e/f\\g|h?i*j')
    expect(out).not.toMatch(/[<>:"/\\|?*]/)
    expect(out.startsWith('a')).toBe(true)
    expect(out.endsWith('j')).toBe(true)
  })

  it('removes control characters including 0x7f', () => {
    const out = sanitizeFilename('bad\x00\x1f\x7fname')
    expect(out).toBe('bad name') // replaced with space, then collapsed
    expect(out).not.toContain('\u007f')
  })

  it('trims trailing dots and spaces (Windows quirk)', () => {
    expect(sanitizeFilename('name. ')).toBe('name')
    expect(sanitizeFilename('name..')).toBe('name')
  })

  it('blocks Windows reserved device names', () => {
    expect(sanitizeFilename('CON')).toMatch(/^_con$/i)
    expect(sanitizeFilename('aux.txt')).toMatch(/^_aux\.txt$/i)
    expect(sanitizeFilename('NUL')).toMatch(/^_nul$/i)
    // normal names containing these substrings are fine
    expect(sanitizeFilename('console.mp4')).toBe('console.mp4')
  })

  it('collapses whitespace and enforces length', () => {
    expect(sanitizeFilename('  a   b  ')).toBe('a b')
    const long = 'x'.repeat(300)
    expect(sanitizeFilename(long, 80).length).toBeLessThanOrEqual(80)
  })

  it('never returns an empty string for arbitrary input', () => {
    expect(sanitizeFilename('???').length).toBeGreaterThan(0)
    expect(sanitizeFilename('')).toBe('untitled')
  })

  it('keeps unicode letters where filesystems allow', () => {
    expect(sanitizeFilename('café über.mp4')).toBe('café über.mp4')
  })
})

describe('slugify', () => {
  it('produces URL-safe lowercase slugs', () => {
    expect(slugify('Hello World!')).toBe('hello-world')
    expect(slugify(' 10 Tips & Tricks — Vol. 2 ')).toBe('10-tips-tricks-vol-2')
  })

  it('transliterates common accented characters', () => {
    expect(slugify('café naïve')).toBe('cafe-naive')
  })

  it('enforces max length without trailing hyphens', () => {
    const out = slugify('a very long title that goes on and on and on', 10)
    expect(out.length).toBeLessThanOrEqual(10)
    expect(out.endsWith('-')).toBe(false)
  })

  it('falls back to "clip" for symbol-only input', () => {
    expect(slugify('???')).toBe('clip')
  })
})

describe('uniqueName', () => {
  it('returns base when unused', () => {
    expect(uniqueName('clip.mp4', () => false)).toBe('clip.mp4')
  })

  it('appends " (n)" suffixes on collision (used for export folder names)', () => {
    const taken = new Set(['My Project', 'My Project (2)'])
    expect(uniqueName('My Project', (n) => taken.has(n))).toBe('My Project (3)')
  })
})

describe('formatExportFilename', () => {
  it('interpolates placeholders and indexes', () => {
    const out = formatExportFilename('{index}_{slug}', { index: 3, title: 'My Best Clip', slug: 'my-best-clip' })
    expect(out).toBe('03_my-best-clip')
  })

  it('sanitizes user template placeholders results', () => {
    const out = formatExportFilename('{title}.mp4', { index: 1, title: 'What? A <test>', slug: 'x' })
    expect(out).not.toMatch(/[<>?]/)
  })

  it('supports {date} placeholder', () => {
    const out = formatExportFilename('{date}_{slug}', { index: 1, title: 't', slug: 't' })
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}_/)
  })
})
