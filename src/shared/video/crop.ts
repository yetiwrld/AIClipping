import type { Clip } from '../types'

/**
 * Crop-window math shared by the FFmpeg render pipeline and the editor's
 * live preview — the preview shows exactly the region that will be rendered
 * (ADR-009). All values are in source pixel coordinates.
 */

export function computeCrop(
  sourceWidth: number,
  sourceHeight: number,
  targetW: number,
  targetH: number,
  cropMode: Clip['cropMode'],
  cropX: number,
  zoom: number
): { w: number; h: number; x: number; y: number } {
  const z = Math.min(3, Math.max(1, zoom))
  const sourceAR = sourceWidth / sourceHeight
  const targetAR = targetW / targetH

  let w: number
  let h: number
  if (sourceAR > targetAR) {
    // Landscape source → vertical slice
    h = sourceHeight
    w = sourceHeight * targetAR
  } else {
    // Portrait/square source → horizontal slice (crop height)
    w = sourceWidth
    h = sourceWidth / targetAR
  }
  w = Math.min(sourceWidth, w / z)
  h = Math.min(sourceHeight, h / z)

  // keep even dimensions for yuv420p
  w = Math.max(2, Math.floor(w / 2) * 2)
  h = Math.max(2, Math.floor(h / 2) * 2)

  let x: number
  let y: number
  if (sourceAR > targetAR) {
    x =
      cropMode === 'manual'
        ? Math.round(Math.min(1, Math.max(0, cropX)) * (sourceWidth - w))
        : Math.round((sourceWidth - w) / 2)
    y = Math.round((sourceHeight - h) / 2)
  } else {
    x = Math.round((sourceWidth - w) / 2)
    y =
      cropMode === 'top'
        ? 0
        : cropMode === 'bottom'
          ? sourceHeight - h
          : cropMode === 'manual'
            ? Math.round(Math.min(1, Math.max(0, cropX)) * (sourceHeight - h))
            : Math.round((sourceHeight - h) / 2)
  }
  x = Math.max(0, Math.min(sourceWidth - w, x))
  y = Math.max(0, Math.min(sourceHeight - h, y))
  return { w, h, x, y }
}
