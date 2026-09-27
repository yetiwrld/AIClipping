import { describe, it, expect } from 'vitest'
import { buildIntegral, windowEnergy, bestWindow, mergeKeyframes, evenKeyframe, type SmartKeyframe } from '@shared/video/saliency'

/**
 * Saliency math for smart crop (§24-28) — pure, deterministic, no FFmpeg.
 * The integration counterpart (real decoded frames) lives in forensic.test.ts.
 */

function frame(width: number, height: number, paint: (x: number, y: number) => number): Uint8Array {
  const g = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) g[y * width + x] = paint(x, y)
  }
  return g
}

describe('buildIntegral + windowEnergy', () => {
  it('a flat frame has zero energy everywhere', () => {
    const w = 32
    const h = 32
    const gray = frame(w, h, () => 128)
    const integral = buildIntegral(w, h, gray)
    expect(windowEnergy(integral, w, 0, 0, w, h)).toBe(0)
  })

  it('a bright box in the corner concentrates energy there', () => {
    const w = 40
    const h = 40
    const gray = frame(w, h, (x, y) => (x < 10 && y < 10 ? 240 : 10))
    const integral = buildIntegral(w, h, gray)
    const corner = windowEnergy(integral, w, 0, 0, 10, 10)
    const elsewhere = windowEnergy(integral, w, 20, 20, 10, 10)
    expect(corner).toBeGreaterThan(elsewhere * 10)
  })

  it('window sums are consistent with brute force', () => {
    const w = 24
    const h = 24
    const gray = frame(w, h, (x, y) => (x * 7 + y * 13) % 251)
    const integral = buildIntegral(w, h, gray)
    let brute = 0
    for (let y = 5; y < 15; y++) {
      for (let x = 3; x < 19; x++) {
        const idx = y * w + x
        const right = x + 1 < w ? gray[idx + 1] : gray[idx]
        const down = y + 1 < h ? gray[idx + w] : gray[idx]
        brute += Math.abs(gray[idx] - right) + Math.abs(gray[idx] - down)
      }
    }
    expect(windowEnergy(integral, w, 3, 5, 16, 10)).toBe(brute)
  })
})

describe('bestWindow', () => {
  it('locks onto the highest-energy region inside the content area', () => {
    const w = 96
    const h = 128
    // busy texture on the right third, flat elsewhere
    const gray = frame(w, h, (x, y) => (x > 64 ? ((x * 31 + y * 17) % 200) + 40 : 20))
    const choice = bestWindow(w, h, gray, 32, 48, { left: 0, top: 0, width: w, height: h })
    expect(choice.x).toBeGreaterThanOrEqual(48)
  })

  it('never returns a window outside the content bounds', () => {
    const w = 96
    const h = 128
    const gray = frame(w, h, () => 128)
    const content = { left: 20, top: 30, width: 40, height: 50 }
    const choice = bestWindow(w, h, gray, 20, 24, content)
    expect(choice.x).toBeGreaterThanOrEqual(content.left)
    expect(choice.y).toBeGreaterThanOrEqual(content.top)
    expect(choice.x).toBeLessThanOrEqual(content.left + content.width - 20)
    expect(choice.y).toBeLessThanOrEqual(content.top + content.height - 24)
  })
})

describe('mergeKeyframes + evenKeyframe', () => {
  const kf = (start: number, end: number, x: number, y: number): SmartKeyframe => ({ start, end, x, y, w: 606, h: 1080 })

  it('merges adjacent shots with nearly identical windows (no jump cuts in a stable composition)', () => {
    const merged = mergeKeyframes([kf(0, 2, 100, 246), kf(2, 4, 102, 247), kf(4, 8, 500, 300)], { moveThresholdPx: 12 })
    expect(merged.length).toBe(2)
    expect(merged[0]).toMatchObject({ start: 0, end: 4, x: 100 })
    expect(merged[1]).toMatchObject({ start: 4, end: 8, x: 500 })
  })

  it('caps keyframes and closes the gaps so coverage is complete', () => {
    const many = Array.from({ length: 20 }, (_, i) => kf(i, i + 1, i * 100, 246))
    const merged = mergeKeyframes(many, { maxKeyframes: 5, moveThresholdPx: 0 })
    expect(merged.length).toBe(5)
    expect(merged[0].start).toBe(0)
    expect(merged[merged.length - 1].end).toBe(20)
    for (let i = 0; i < merged.length - 1; i++) {
      expect(merged[i].end).toBe(merged[i + 1].start)
    }
  })

  it('evenKeyframe produces even, in-frame coordinates', () => {
    const out = evenKeyframe({ start: 0, end: 1, x: 7, y: 247, w: 607, h: 1079 }, 1080, 1920)
    expect(out.x % 2).toBe(0)
    expect(out.y % 2).toBe(0)
    expect(out.w % 2).toBe(0)
    expect(out.h % 2).toBe(0)
    expect(out.x + out.w).toBeLessThanOrEqual(1080)
    expect(out.y + out.h).toBeLessThanOrEqual(1920)
  })
})
