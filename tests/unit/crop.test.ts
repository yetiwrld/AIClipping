import { describe, it, expect } from 'vitest'
import { computeCrop, smartWindowAt } from '@shared/video/crop'

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

describe('computeCrop with contentRect — baked-in bars never survive (§22/§29)', () => {
  // The §22 forensic source: 1080x1920 with content 1080x1440 at y=246.
  const forensic = { left: 0, top: 246, width: 1080, height: 1440 }

  it('crops inside the content area, not the padded frame', () => {
    const out = computeCrop(1080, 1920, 1080, 1920, 'center', 0.5, 1, forensic)
    // content is 1080x1440 (3:4), target 9:16 is taller → horizontal slice of content
    expect(out.h).toBe(1440)
    expect(out.w).toBe(Math.floor((1440 * 9) / 16 / 2) * 2)
    expect(out.y).toBe(246)
    expect(out.x + out.w).toBeLessThanOrEqual(1080)
  })

  it('top/bottom respect the content bounds', () => {
    const top = computeCrop(1080, 1920, 1080, 1920, 'top', 0.5, 1, forensic)
    const bottom = computeCrop(1080, 1920, 1080, 1920, 'bottom', 0.5, 1, forensic)
    expect(top.y).toBe(246)
    expect(bottom.y).toBe(246 + 1440 - bottom.h)
  })

  it('fit returns the entire content area (letterboxed by the renderer)', () => {
    const out = computeCrop(1080, 1920, 1080, 1920, 'fit', 0.5, 1, forensic)
    expect(out).toEqual({ w: 1080, h: 1440, x: 0, y: 246 })
  })

  it('a degenerate/too-small contentRect falls back to the full frame', () => {
    const out = computeCrop(1080, 1920, 1080, 1920, 'center', 0.5, 1, { left: 0, top: 0, width: 8, height: 8 })
    expect(out.h).toBe(1920)
  })

  it('smartWindowAt picks the keyframe covering the time (and falls back)', () => {
    const kfs = [
      { start: 0, end: 4, x: 0, y: 246, w: 606, h: 1080 },
      { start: 4, end: 9.5, x: 400, y: 300, w: 606, h: 1080 }
    ]
    expect(smartWindowAt(1, kfs, { w: 0, h: 0, x: 0, y: 0 })).toEqual({ w: 606, h: 1080, x: 0, y: 246 })
    expect(smartWindowAt(5, kfs, { w: 0, h: 0, x: 0, y: 0 })).toEqual({ w: 606, h: 1080, x: 400, y: 300 })
    // outside coverage → nearest
    expect(smartWindowAt(20, kfs, { w: 1, h: 1, x: 9, y: 9 }).x).toBe(400)
    // no keyframes → fallback window
    expect(smartWindowAt(1, [], { w: 7, h: 7, x: 1, y: 2 })).toEqual({ w: 7, h: 7, x: 1, y: 2 })
  })
})
