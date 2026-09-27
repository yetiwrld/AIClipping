import type { Clip } from '../types'

/**
 * Crop-window math shared by the FFmpeg render pipeline and the editor's
 * live preview — the preview shows exactly the region that will be rendered
 * (ADR-009). All values are in source pixel coordinates (display orientation:
 * width/height are the rotation-swapped project dims).
 *
 * Black-bar awareness (§29): when the project has a detected contentRect
 * (FFmpeg cropdetect at import), every fill/smart crop is computed INSIDE the
 * real content area, so baked-in letterbox/pillarbox bars never survive into
 * a vertical export. `fit` deliberately shows the whole content (letterboxed
 * by the renderer) — it is the user's explicit choice, never the default.
 */

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

export interface CropWindow {
  w: number
  h: number
  x: number
  y: number
}

/** Content area of the source, falling back to the whole frame. */
export function contentRectOf(
  project: { width: number | null; height: number | null; contentRect: Rect | null },
  fallbackW: number,
  fallbackH: number
): Rect {
  const w = project.width ?? fallbackW
  const h = project.height ?? fallbackH
  const r = project.contentRect
  if (!r || r.width < 16 || r.height < 16) return { left: 0, top: 0, width: w, height: h }
  // clamp the stored rect into the frame (source may have been re-inspected)
  const left = Math.max(0, Math.min(r.left, w - 16))
  const top = Math.max(0, Math.min(r.top, h - 16))
  return {
    left,
    top,
    width: Math.min(r.width, w - left),
    height: Math.min(r.height, h - top)
  }
}

export function computeCrop(
  sourceWidth: number,
  sourceHeight: number,
  targetW: number,
  targetH: number,
  cropMode: Clip['cropMode'],
  cropX: number,
  zoom: number,
  contentRect?: Rect | null
): CropWindow {
  const content = contentRectOf(
    { width: sourceWidth, height: sourceHeight, contentRect: contentRect ?? null },
    sourceWidth,
    sourceHeight
  )

  // fit: the entire content is shown; the renderer letterboxes (pad) —
  // preview equivalence is objectFit: contain.
  if (cropMode === 'fit') {
    return { w: content.width, h: content.height, x: content.left, y: content.top }
  }

  const z = Math.min(3, Math.max(1, zoom))
  const contentAR = content.width / content.height
  const targetAR = targetW / targetH

  let w: number
  let h: number
  if (contentAR > targetAR) {
    // Content is wider than the target → vertical slice of the content
    h = content.height
    w = content.height * targetAR
  } else {
    // Content is taller than the target (or equal) → horizontal slice
    w = content.width
    h = content.width / targetAR
  }
  w = Math.min(content.width, w / z)
  h = Math.min(content.height, h / z)

  // keep even dimensions for yuv420p
  w = Math.max(2, Math.floor(w / 2) * 2)
  h = Math.max(2, Math.floor(h / 2) * 2)

  const xRange = content.width - w
  const yRange = content.height - h
  let x: number
  let y: number
  if (cropMode === 'manual') {
    // manual uses cropX for the dominant axis (the one being cropped)
    if (xRange > 0) x = content.left + Math.round(Math.min(1, Math.max(0, cropX)) * xRange)
    else x = content.left + Math.round(xRange / 2)
    if (yRange > 0) y = content.top + Math.round(Math.min(1, Math.max(0, cropX)) * yRange)
    else y = content.top + Math.round(yRange / 2)
  } else if (cropMode === 'top') {
    x = content.left + Math.round(xRange / 2)
    y = content.top
  } else if (cropMode === 'bottom') {
    x = content.left + Math.round(xRange / 2)
    y = content.top + yRange
  } else {
    // center (default fill)
    x = content.left + Math.round(xRange / 2)
    y = content.top + Math.round(yRange / 2)
  }
  x = Math.max(content.left, Math.min(content.left + xRange, x))
  y = Math.max(content.top, Math.min(content.top + yRange, y))
  return { w, h, x, y }
}

/**
 * The smart-crop window active at a given source time. Falls back to a
 * centered fill window (inside the content rect) when the clip has no
 * keyframes yet, so preview and render never disagree about the mode.
 */
export function smartWindowAt(
  time: number,
  keyframes: Clip['smartCropKeyframes'],
  fallback: CropWindow
): CropWindow {
  if (!keyframes || keyframes.length === 0) return fallback
  for (const k of keyframes) {
    if (time >= k.start - 0.001 && time <= k.end + 0.001) {
      return { w: k.w, h: k.h, x: k.x, y: k.y }
    }
  }
  // outside keyframe coverage → nearest keyframe
  let nearest = keyframes[0]
  let bestDist = Math.abs(time - (nearest.start + nearest.end) / 2)
  for (const k of keyframes) {
    const d = Math.abs(time - (k.start + k.end) / 2)
    if (d < bestDist) {
      nearest = k
      bestDist = d
    }
  }
  return { w: nearest.w, h: nearest.h, x: nearest.x, y: nearest.y }
}
