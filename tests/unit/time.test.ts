import { describe, it, expect } from 'vitest'
import {
  clamp, formatClock, formatSrtTime, formatVttTime, formatAssTime,
  parseTimestamp, isValidRange, overlapRatio
} from '@shared/utils/time'

describe('time utils', () => {
  it('clamp constrains to bounds', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-1, 0, 10)).toBe(0)
    expect(clamp(11, 0, 10)).toBe(10)
    expect(clamp(NaN, 0, 10)).toBe(NaN)
  })

  it('formatClock renders human-readable timestamps', () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(65.4)).toBe('1:05')
    expect(formatClock(3600)).toBe('1:00:00')
    expect(formatClock(83.456, true)).toBe('1:23.4')
  })

  it('formatSrtTime renders comma-separated milliseconds (SRT spec)', () => {
    expect(formatSrtTime(0)).toBe('00:00:00,000')
    expect(formatSrtTime(3661.5)).toBe('01:01:01,500')
    expect(formatSrtTime(-0.5)).toBe('00:00:00,000')
  })

  it('formatVttTime renders dot-separated milliseconds', () => {
    expect(formatVttTime(75.25)).toBe('00:01:15.250')
  })

  it('formatAssTime truncates to centiseconds (never rounds past the end)', () => {
    expect(formatAssTime(0)).toBe('0:00:00.00')
    expect(formatAssTime(3661.999)).toBe('1:01:01.99')
    expect(formatAssTime(59.995)).toBe('0:00:59.99')
  })

  describe('parseTimestamp', () => {
    it('accepts plain seconds', () => {
      expect(parseTimestamp('42')).toBe(42)
      expect(parseTimestamp('42.5')).toBe(42.5)
    })

    it('accepts mm:ss and hh:mm:ss(.ms)', () => {
      expect(parseTimestamp('1:05')).toBe(65)
      expect(parseTimestamp('01:05.5')).toBe(65.5)
      expect(parseTimestamp('1:02:03')).toBe(3723)
      expect(parseTimestamp('00:00:05,300')).toBe(5.3) // SRT style
    })

    it('accepts numeric input verbatim', () => {
      expect(parseTimestamp(12.25)).toBe(12.25)
    })

    it('rejects garbage', () => {
      expect(parseTimestamp('abc')).toBeNull()
      expect(parseTimestamp('')).toBeNull()
      expect(parseTimestamp('1:2:3:4')).toBeNull()
      expect(parseTimestamp('-5')).toBeNull()
    })
  })

  it('isValidRange enforces ordering, positivity and source bounds', () => {
    expect(isValidRange(10, 20)).toBe(true)
    expect(isValidRange(10, 20, 30)).toBe(true)
    expect(isValidRange(10, 10)).toBe(false) // zero length
    expect(isValidRange(20, 10)).toBe(false) // reversed
    expect(isValidRange(-1, 10)).toBe(false)
    expect(isValidRange(10, 40, 30)).toBe(false) // past source end
    expect(isValidRange(10, 20, 30)).toBe(true)
  })

  it('overlapRatio measures overlap against the shorter range', () => {
    // identical ranges → 1
    expect(overlapRatio(0, 10, 0, 10)).toBe(1)
    // half of the shorter range → 0.5
    expect(overlapRatio(0, 10, 5, 15)).toBe(0.5)
    // no overlap → 0
    expect(overlapRatio(0, 10, 20, 30)).toBe(0)
    // containment → 1 (shorter is fully covered)
    expect(overlapRatio(0, 100, 10, 20)).toBe(1)
    // touching edges → 0
    expect(overlapRatio(0, 10, 10, 20)).toBe(0)
  })
})
