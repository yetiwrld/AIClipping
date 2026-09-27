import type { Rect } from './crop'

/**
 * Saliency-based crop selection (§24-28). Pure math, shared by the main
 * process analysis and unit tests. The analysis is REAL: FFmpeg extracts
 * grayscale frames, this module computes gradient-energy (edge density) via
 * a summed-area table and finds the target-aspect window with the highest
 * content energy plus a center bias. No fake face detection — subject
 * tracking here is honest signal processing over actual frames.
 */

/** Build a summed-area table over per-pixel gradient energy. */
export function buildIntegral(width: number, height: number, gray: Uint8Array): Float64Array {
  const integral = new Float64Array((width + 1) * (height + 1))
  for (let y = 0; y < height; y++) {
    let rowSum = 0
    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      const right = x + 1 < width ? gray[idx + 1] : gray[idx]
      const down = y + 1 < height ? gray[idx + width] : gray[idx]
      const energy = Math.abs(gray[idx] - right) + Math.abs(gray[idx] - down)
      rowSum += energy
      integral[(y + 1) * (width + 1) + (x + 1)] = integral[y * (width + 1) + (x + 1)] + rowSum
    }
  }
  return integral
}

/** Sum of gradient energy inside [x, x+w) × [y, y+h) via the integral table. */
export function windowEnergy(
  integral: Float64Array,
  width: number,
  x: number,
  y: number,
  w: number,
  h: number
): number {
  const W = width + 1
  const x1 = Math.max(0, Math.min(width, x))
  const y1 = Math.max(0, y)
  const x2 = Math.max(0, Math.min(width, x + w))
  const y2 = Math.max(0, y + h)
  const a = integral[y1 * W + x1]
  const b = integral[y1 * W + x2]
  const c = integral[y2 * W + x1]
  const d = integral[y2 * W + x2]
  return Math.max(0, d - b - c + a)
}

export interface WindowChoice {
  x: number
  y: number
  /** Normalized score for diagnostics. */
  score: number
}

/**
 * Find the (width × height) window inside the content area with the most
 * visual energy, with a mild center bias so static noise at the edges never
 * drags the crop around. Coordinates are in FRAME pixels.
 */
export function bestWindow(
  frameWidth: number,
  frameHeight: number,
  gray: Uint8Array,
  windowW: number,
  windowH: number,
  content: Rect
): WindowChoice {
  const integral = buildIntegral(frameWidth, frameHeight, gray)
  const xRange = Math.max(0, content.width - windowW)
  const yRange = Math.max(0, content.height - windowH)
  // slide in steps of ~2% of the frame, minimum 4px
  const stepX = Math.max(4, Math.round(frameWidth * 0.02))
  const stepY = Math.max(4, Math.round(frameHeight * 0.02))
  const cx = content.left + xRange / 2
  const cy = content.top + yRange / 2
  const maxDist = Math.max(1, Math.hypot(xRange, yRange) / 2)

  let best: WindowChoice = { x: content.left + Math.round(xRange / 2), y: content.top + Math.round(yRange / 2), score: 0 }
  let bestScore = -1
  let bestEnergy = -1
  for (let y = content.top; y <= content.top + yRange; y += stepY) {
    for (let x = content.left; x <= content.left + xRange; x += stepX) {
      const energy = windowEnergy(integral, frameWidth, x, y, windowW, windowH)
      const dist = Math.hypot(x + windowW / 2 - cx, y + windowH / 2 - cy)
      const centerBias = 1 - 0.12 * (dist / maxDist)
      const score = energy * centerBias
      if (score > bestScore + 1e-9) {
        bestScore = score
        bestEnergy = energy
        best = { x, y, score: energy / Math.max(1, windowW * windowH) }
      }
    }
  }
  // also evaluate the exact center (always a candidate)
  const centerX = content.left + Math.round(xRange / 2)
  const centerY = content.top + Math.round(yRange / 2)
  const centerEnergy = windowEnergy(integral, frameWidth, centerX, centerY, windowW, windowH)
  if (centerEnergy > bestEnergy * 1.08) {
    best = { x: centerX, y: centerY, score: centerEnergy / Math.max(1, windowW * windowH) }
  }
  return best
}

export interface SmartKeyframe {
  start: number
  end: number
  x: number
  y: number
  w: number
  h: number
}

/**
 * Merge adjacent shots whose crop windows are nearly identical (≤ threshold
 * px) and cap the keyframe count. Cuts only happen where the composition
 * actually changes (§28: no jumps inside a stable composition).
 */
export function mergeKeyframes(
  keyframes: SmartKeyframe[],
  opts: { maxKeyframes?: number; moveThresholdPx?: number } = {}
): SmartKeyframe[] {
  const maxK = opts.maxKeyframes ?? 12
  const threshold = opts.moveThresholdPx ?? 0 // computed by caller as % of dims
  const merged: SmartKeyframe[] = []
  for (const k of keyframes) {
    const last = merged[merged.length - 1]
    if (
      last &&
      Math.abs(last.x - k.x) <= threshold &&
      Math.abs(last.y - k.y) <= threshold &&
      last.w === k.w &&
      last.h === k.h
    ) {
      last.end = k.end
    } else {
      merged.push({ ...k })
    }
  }
  if (merged.length <= maxK) return merged
  // keep the longest spans, then re-sort by time
  const kept = [...merged]
    .sort((a, b) => b.end - b.start - (a.end - a.start))
    .slice(0, maxK)
    .sort((a, b) => a.start - b.start)
  // close the gaps so keyframes cover the full range
  for (let i = 0; i < kept.length - 1; i++) {
    kept[i].end = kept[i + 1].start
  }
  if (kept.length > 0) {
    kept[kept.length - 1].end = merged[merged.length - 1].end
    kept[0].start = merged[0].start
  }
  return kept
}

/** Even-up coordinates for yuv420p crops. */
export function evenKeyframe(k: SmartKeyframe, frameW: number, frameH: number): SmartKeyframe {
  const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2)
  const w = even(Math.min(k.w, frameW))
  const h = even(Math.min(k.h, frameH))
  return {
    start: k.start,
    end: k.end,
    w,
    h,
    x: Math.max(0, Math.min(even(frameW - w), even(k.x))),
    y: Math.max(0, Math.min(even(frameH - h), even(k.y)))
  }
}
