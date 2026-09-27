import type { AspectRatioId, DurationPresetId, OutputQualityId, OutputResolutionId, PlatformPresetId } from '../types'

/**
 * Built-in caption style presets. Original designs (not copied from any
 * product). Each maps onto the ASS renderer and the DOM preview through the
 * same shared segmentation + style parameters.
 */
export interface CaptionStylePreset {
  id: string
  label: string
  description: string
  /** Template browser grouping. */
  category: 'clean' | 'editorial' | 'bold' | 'high-contrast' | 'highlight' | 'kinetic' | 'minimal' | 'lower-third' | 'boxed' | 'center'
  fontFile: string
  /** Base font size as % of output height (e.g. 4.2 → ~81px at 1920) */
  fontSizePct: number
  textColor: string
  highlightColor: string
  outlineColor: string
  outlineWidth: number
  boxColor: string
  boxOpacity: number
  shadow: number
  uppercase: boolean
  emphasis: boolean
  maxWordsPerCue: number
  maxCharsPerLine: number
  maxLines: number
  /** Vertical anchor 0..1 (0.5 = middle) */
  positionY: number
}

export const CAPTION_STYLES: CaptionStylePreset[] = [
  {
    id: 'classic',
    label: 'Classic',
    category: 'clean',
    description: 'White text with a crisp dark outline. The safe default.',
    fontFile: 'Inter_600SemiBold.ttf',
    fontSizePct: 4.2,
    textColor: '#FFFFFF',
    highlightColor: '#FFD84D',
    outlineColor: '#000000',
    outlineWidth: 3.5,
    boxColor: '#000000',
    boxOpacity: 0,
    shadow: 0,
    uppercase: false,
    emphasis: true,
    maxWordsPerCue: 5,
    maxCharsPerLine: 18,
    maxLines: 2,
    positionY: 0.72
  },
  {
    id: 'bold',
    label: 'Bold',
    category: 'bold',
    description: 'Heavy type with a warm highlight on the active word.',
    fontFile: 'Inter_800ExtraBold.ttf',
    fontSizePct: 4.8,
    textColor: '#FFFFFF',
    highlightColor: '#FF8A3D',
    outlineColor: '#101010',
    outlineWidth: 4,
    boxColor: '#000000',
    boxOpacity: 0,
    shadow: 0,
    uppercase: false,
    emphasis: true,
    maxWordsPerCue: 4,
    maxCharsPerLine: 16,
    maxLines: 2,
    positionY: 0.7
  },
  {
    id: 'minimal',
    label: 'Minimal',
    category: 'minimal',
    description: 'No outline, no box — relies on a soft shadow. Clean and modern.',
    fontFile: 'Inter_400Regular.ttf',
    fontSizePct: 3.8,
    textColor: '#FFFFFF',
    highlightColor: '#FFFFFF',
    outlineColor: '#000000',
    outlineWidth: 0,
    boxColor: '#000000',
    boxOpacity: 0,
    shadow: 2.5,
    uppercase: false,
    emphasis: false,
    maxWordsPerCue: 6,
    maxCharsPerLine: 22,
    maxLines: 2,
    positionY: 0.78
  },
  {
    id: 'high-impact',
    label: 'High Impact',
    category: 'high-contrast',
    description: 'All caps, boxed, punchy. For loud moments.',
    fontFile: 'Inter_900Black.ttf',
    fontSizePct: 5.2,
    textColor: '#FFFFFF',
    highlightColor: '#63E6BE',
    outlineColor: '#000000',
    outlineWidth: 0,
    boxColor: '#000000',
    boxOpacity: 0.55,
    shadow: 0,
    uppercase: true,
    emphasis: true,
    maxWordsPerCue: 3,
    maxCharsPerLine: 14,
    maxLines: 2,
    positionY: 0.68
  },
  {
    id: 'podcast',
    label: 'Podcast',
    category: 'lower-third',
    description: 'Rounded box behind slightly smaller text. Comfortable for talking heads.',
    fontFile: 'Inter_600SemiBold.ttf',
    fontSizePct: 3.6,
    textColor: '#FFFFFF',
    highlightColor: '#7C6CFF',
    outlineColor: '#000000',
    outlineWidth: 0,
    boxColor: '#0B0D12',
    boxOpacity: 0.72,
    shadow: 0,
    uppercase: false,
    emphasis: true,
    maxWordsPerCue: 7,
    maxCharsPerLine: 24,
    maxLines: 3,
    positionY: 0.8
  },
  {
    id: 'clean',
    label: 'Clean',
    category: 'clean',
    description: 'Medium weight, subtle highlight, generous spacing.',
    fontFile: 'Inter_700Bold.ttf',
    fontSizePct: 4.0,
    textColor: '#F4F6FB',
    highlightColor: '#B9FF63',
    outlineColor: '#14161C',
    outlineWidth: 2.5,
    boxColor: '#000000',
    boxOpacity: 0,
    shadow: 1,
    uppercase: false,
    emphasis: true,
    maxWordsPerCue: 5,
    maxCharsPerLine: 20,
    maxLines: 2,
    positionY: 0.75
  },
  {
    id: 'editorial',
    label: 'Editorial',
    description: 'Elegant serif-weight look for documentary and interview footage.',
    category: 'editorial',
    fontFile: 'Inter_400Regular.ttf',
    fontSizePct: 3.9,
    textColor: '#F5F1E8',
    highlightColor: '#F5F1E8',
    outlineColor: '#000000',
    outlineWidth: 0,
    boxColor: '#000000',
    boxOpacity: 0,
    shadow: 3.5,
    uppercase: false,
    emphasis: false,
    maxWordsPerCue: 8,
    maxCharsPerLine: 26,
    maxLines: 2,
    positionY: 0.82
  },
  {
    id: 'highlight',
    label: 'Highlight',
    description: 'Selective word emphasis with a soft tinted underline block.',
    category: 'highlight',
    fontFile: 'Inter_700Bold.ttf',
    fontSizePct: 4.4,
    textColor: '#FFFFFF',
    highlightColor: '#FFD84D',
    outlineColor: '#14161C',
    outlineWidth: 3,
    boxColor: '#000000',
    boxOpacity: 0,
    shadow: 1.5,
    uppercase: false,
    emphasis: true,
    maxWordsPerCue: 5,
    maxCharsPerLine: 18,
    maxLines: 2,
    positionY: 0.74
  },
  {
    id: 'kinetic',
    label: 'Kinetic',
    description: 'Smooth active-word color transition — subtle motion that aids reading.',
    category: 'kinetic',
    fontFile: 'Inter_800ExtraBold.ttf',
    fontSizePct: 4.6,
    textColor: '#FFFFFF',
    highlightColor: '#63E6BE',
    outlineColor: '#101010',
    outlineWidth: 3.5,
    boxColor: '#000000',
    boxOpacity: 0,
    shadow: 0,
    uppercase: false,
    emphasis: true,
    maxWordsPerCue: 4,
    maxCharsPerLine: 16,
    maxLines: 2,
    positionY: 0.72
  },
  {
    id: 'boxed',
    label: 'Boxed',
    description: 'Controlled dark container — maximum legibility over busy footage.',
    category: 'boxed',
    fontFile: 'Inter_600SemiBold.ttf',
    fontSizePct: 4.0,
    textColor: '#FFFFFF',
    highlightColor: '#FF8A3D',
    outlineColor: '#000000',
    outlineWidth: 0,
    boxColor: '#0B0D12',
    boxOpacity: 0.85,
    shadow: 0,
    uppercase: false,
    emphasis: true,
    maxWordsPerCue: 6,
    maxCharsPerLine: 22,
    maxLines: 2,
    positionY: 0.78
  },
  {
    id: 'center-focus',
    label: 'Center Focus',
    description: 'Large centered captions for short punchy statements.',
    category: 'center',
    fontFile: 'Inter_900Black.ttf',
    fontSizePct: 5.6,
    textColor: '#FFFFFF',
    highlightColor: '#63E6BE',
    outlineColor: '#000000',
    outlineWidth: 4.5,
    boxColor: '#000000',
    boxOpacity: 0,
    shadow: 0,
    uppercase: true,
    emphasis: true,
    maxWordsPerCue: 3,
    maxCharsPerLine: 12,
    maxLines: 2,
    positionY: 0.5
  },
  {
    id: 'high-contrast',
    label: 'High Contrast',
    description: 'Black text on a solid bright band — readable over anything.',
    category: 'high-contrast',
    fontFile: 'Inter_800ExtraBold.ttf',
    fontSizePct: 4.2,
    textColor: '#0B0D12',
    highlightColor: '#FFD84D',
    outlineColor: '#FFFFFF',
    outlineWidth: 0,
    boxColor: '#FFFFFF',
    boxOpacity: 0.95,
    shadow: 0,
    uppercase: false,
    emphasis: true,
    maxWordsPerCue: 5,
    maxCharsPerLine: 20,
    maxLines: 2,
    positionY: 0.76
  }
]

export const DEFAULT_CAPTION_STYLE_ID = 'classic'

export function getCaptionStyle(id: string): CaptionStylePreset {
  return CAPTION_STYLES.find((s) => s.id === id) ?? CAPTION_STYLES[0]
}

// ---------------------------------------------------------------------------

export interface DurationRange {
  id: DurationPresetId
  label: string
  min: number
  max: number
}

export const DURATION_RANGES: DurationRange[] = [
  { id: 'short', label: 'Short · 15–30s', min: 15, max: 30 },
  { id: 'medium', label: 'Medium · 30–60s', min: 30, max: 60 },
  { id: 'long', label: 'Long · 60–90s', min: 60, max: 90 },
  { id: 'mixed', label: 'Mixed · 15–90s', min: 15, max: 90 }
]

/** Tolerance around the configured range before a candidate is rejected. */
export const DURATION_TOLERANCE = 0.35

export function getDurationRange(id: DurationPresetId): DurationRange {
  return DURATION_RANGES.find((r) => r.id === id) ?? DURATION_RANGES[1]
}

// ---------------------------------------------------------------------------

export interface PlatformPreset {
  id: PlatformPresetId
  label: string
  description: string
  aspectRatio: AspectRatioId
  maxTitleLength: number
  descriptionFormat: 'short' | 'medium'
  hashtagCount: number
}

export const PLATFORM_PRESETS: PlatformPreset[] = [
  {
    id: 'tiktok',
    label: 'TikTok',
    description: 'Vertical 9:16, punchy captions, trending-style hashtags.',
    aspectRatio: '9:16',
    maxTitleLength: 80,
    descriptionFormat: 'short',
    hashtagCount: 5
  },
  {
    id: 'reels',
    label: 'Instagram Reels',
    description: 'Vertical 9:16, hook-first description, moderate hashtags.',
    aspectRatio: '9:16',
    maxTitleLength: 90,
    descriptionFormat: 'short',
    hashtagCount: 6
  },
  {
    id: 'shorts',
    label: 'YouTube Shorts',
    description: 'Vertical 9:16, title-style summary, fewer hashtags.',
    aspectRatio: '9:16',
    maxTitleLength: 100,
    descriptionFormat: 'medium',
    hashtagCount: 3
  },
  {
    id: 'generic',
    label: 'Generic Vertical',
    description: 'Platform-neutral vertical export.',
    aspectRatio: '9:16',
    maxTitleLength: 100,
    descriptionFormat: 'medium',
    hashtagCount: 4
  }
]

export function getPlatformPreset(id: PlatformPresetId): PlatformPreset {
  return PLATFORM_PRESETS.find((p) => p.id === id) ?? PLATFORM_PRESETS[3]
}

// ---------------------------------------------------------------------------

export const ASPECT_RATIOS: Record<AspectRatioId, { w: number; h: number; label: string; shortLabel: string; vertical: boolean }> = {
  '9:16': { w: 1080, h: 1920, label: '9:16 · Vertical', shortLabel: 'vertical', vertical: true },
  '1:1': { w: 1080, h: 1080, label: '1:1 · Square', shortLabel: 'square', vertical: false },
  '4:5': { w: 1080, h: 1350, label: '4:5 · Portrait', shortLabel: 'portrait', vertical: true },
  '16:9': { w: 1920, h: 1080, label: '16:9 · Landscape', shortLabel: 'landscape', vertical: false }
}

/** Resolution tiers: the SHORT side of the output. */
export const RESOLUTION_PRESETS: Array<{ id: OutputResolutionId; shortSide: number; label: string; hint: string }> = [
  { id: '720p', shortSide: 720, label: '720p', hint: 'Fast / smaller files' },
  { id: '1080p', shortSide: 1080, label: '1080p', hint: 'Recommended' },
  { id: '1440p', shortSide: 1440, label: '1440p / 2K', hint: 'Higher detail' },
  { id: '2160p', shortSide: 2160, label: '2160p / 4K', hint: 'Maximum resolution' }
]

/** Exact output dimensions for an aspect ratio at a resolution tier. */
export function resolutionFor(
  aspect: AspectRatioId,
  tier: OutputResolutionId
): { w: number; h: number } {
  const ar = ASPECT_RATIOS[aspect]
  const shortSide = RESOLUTION_PRESETS.find((r) => r.id === tier)?.shortSide ?? 1080
  // Vertical ratios (9:16, 4:5): the short side is the WIDTH.
  // Square: both sides equal. Landscape (16:9): short side is the HEIGHT.
  let w: number
  let h: number
  if (ar.vertical) {
    w = shortSide
    h = Math.round((shortSide * ar.h) / ar.w)
  } else {
    h = shortSide
    w = Math.round((shortSide * ar.w) / ar.h)
  }
  // keep even dimensions for yuv420p
  return { w: Math.floor(w / 2) * 2, h: Math.floor(h / 2) * 2 }
}

export interface QualityPreset {
  id: OutputQualityId
  label: string
  hint: string
  /** CRF for software x264 (lower = better). */
  crf: number
  /** x264 speed preset. */
  x264Preset: string
  /** Multiplier on the tier base bitrate for hardware encoders. */
  hwBitrateFactor: number
}

export const QUALITY_PRESETS: QualityPreset[] = [
  { id: 'draft', label: 'Draft', hint: 'Fast preview quality', crf: 27, x264Preset: 'veryfast', hwBitrateFactor: 0.5 },
  { id: 'standard', label: 'Standard', hint: 'Balanced quality and size', crf: 21, x264Preset: 'medium', hwBitrateFactor: 1 },
  { id: 'high', label: 'High', hint: 'Higher-quality delivery', crf: 18, x264Preset: 'slow', hwBitrateFactor: 1.6 },
  { id: 'maximum', label: 'Maximum', hint: 'Highest practical quality', crf: 15, x264Preset: 'slower', hwBitrateFactor: 2.5 }
]

export function getQualityPreset(id: OutputQualityId): QualityPreset {
  return QUALITY_PRESETS.find((q) => q.id === id) ?? QUALITY_PRESETS[1]
}

/** Rough output-size estimate (MB) for the export panel — honest heuristic. */
export function estimateRenderSizeMb(
  aspect: AspectRatioId,
  tier: OutputResolutionId,
  quality: OutputQualityId,
  seconds: number
): number {
  const { w, h } = resolutionFor(aspect, tier)
  const q = getQualityPreset(quality)
  // bits per pixel per frame model, calibrated around x264 CRF behavior
  const baseBpp = 0.028 * q.hwBitrateFactor
  const bitrateMbps = Math.max(0.6, (w * h * 30 * baseBpp) / 1_000_000)
  const videoMb = (bitrateMbps * seconds) / 8
  return Math.round(videoMb + (seconds * 0.192) / 8) // + audio 192 kbps
}

/** Words that hint at strong moments — used by the local heuristic analyzer. */
export const HOOK_CUE_PATTERNS: RegExp[] = [
  /\bthe (biggest|worst|best|craziest|weirdest|hardest|most)\b/i,
  /\b(never|always|nobody|everyone)\b/i,
  /\bi (learned|realized|discovered|failed|quit|lost|made)\b/i,
  /\b(secret|truth|mistake|lesson|problem|rule)\b/i,
  /\b(you (need|should|must|can't|won't))\b/i,
  /\b(here'?s (why|how|what))\b/i,
  /\b(million|billion|thousand|\d+%|\$\d+)\b/i,
  /\b(listen|look|imagine|trust me|honestly)\b/i
]

export const QUESTION_PATTERN = /\?\s*$/
export const NUMBER_PATTERN = /\b\d[\d,.]*\b/
