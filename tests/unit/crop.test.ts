import { describe, it, expect } from 'vitest'
import { computeCrop } from '@shared/video/crop'

describe('computeCrop (shared by preview and render — ADR-009)', () => {
  it('produces a vertical slice from landscape 16:9 → 9:16', () => {
    const out = computeCrop(1280, 720, 1080, 1920, 'center', 0.5, 1)
    expect(out.h).toBe(720)
    // 720 * (9/16) = 405 → floored to even
    expect(out.w).toBe(404)
    expect(out.x).toBe(Math.round((1280 - 404) / 2))
    expect(out.y).toBe(0)
  })

  it('always returns even dimensions (yuv420p requirement)', () => {
    for (const zoom of [1, 1.3, 2, 3]) {
      const out = computeCrop(1279, 719, 1080, 1920, 'center', 0.5, zoom)
      expect(out.w % 2).toBe(0)
      expect(out.h % 2).toBe(0)
    }
  })

  it('keeps the crop window inside the source', () => {
    for (const mode of ['center', 'top', 'bottom', 'manual'] as const) {
      for (const cropX of [0, 0.2, 0.9, 1]) {
        for (const zoom of [1, 2.5, 10]) {
          const out = computeCrop(1280, 720, 1080, 1920, mode, cropX, zoom)
          expect(out.x).toBeGreaterThanOrEqual(0)
          expect(out.y).toBeGreaterThanOrEqual(0)
          expect(out.x + out.w).toBeLessThanOrEqual(1280)
          expect(out.y + out.h).toBeLessThanOrEqual(720)
        }
      }
    }
  })

  it('clamps zoom to 1–3', () => {
    const noZoom = computeCrop(1280, 720, 1080, 1920, 'center', 0.5, 1)
    const clampedLow = computeCrop(1280, 720, 1080, 1920, 'center', 0.5, 0.1)
    const clampedHigh = computeCrop(1280, 720, 1080, 1920, 'center', 0.5, 99)
    expect(clampedLow.w).toBe(noZoom.w) // below-range zoom acts as 1
    expect(clampedHigh.w).toBeLessThan(noZoom.w) // above-range zoom acts as 3
    expect(clampedHigh.w % 2).toBe(0)
  })

  it('manual cropX positions the window horizontally on landscape sources', () => {
    const left = computeCrop(1280, 720, 1080, 1920, 'manual', 0, 1)
    const right = computeCrop(1280, 720, 1080, 1920, 'manual', 1, 1)
    expect(left.x).toBe(0)
    expect(right.x).toBe(1280 - right.w)
    // out-of-range cropX clamps
    const clamped = computeCrop(1280, 720, 1080, 1920, 'manual', 7, 1)
    expect(clamped.x).toBe(1280 - clamped.w)
  })

  it('top/bottom apply vertically on portrait sources with taller targets', () => {
    // 720x1280 portrait → 4:5 (taller aspect than 9:16? no: 0.8 > 0.5625 target is WIDER) — crop height
    const top = computeCrop(720, 1280, 1080, 1350, 'top', 0.5, 1)
    const bottom = computeCrop(720, 1280, 1080, 1350, 'bottom', 0.5, 1)
    expect(top.y).toBe(0)
    expect(bottom.y).toBe(1280 - bottom.h)
    expect(bottom.h).toBeLessThan(1280)
  })

  it('no crop needed when aspects match', () => {
    const out = computeCrop(1080, 1920, 1080, 1920, 'center', 0.5, 1)
    expect(out.w).toBe(1080)
    expect(out.h).toBe(1920)
    expect(out.x).toBe(0)
    expect(out.y).toBe(0)
  })
})
