import React from 'react'
import type { CaptionCue } from '@shared/captions/segmentation'
import { cueAt, wordIndexAt } from '@shared/captions/segmentation'
import type { CaptionStylePreset } from '@shared/constants'

/**
 * DOM caption overlay that mirrors the ASS renderer's segmentation, timing,
 * emphasis and layout parameters (ADR-009). Rasterization differs slightly
 * from libass; text/timing/highlight behavior is identical.
 */
export function CaptionPreview(props: {
  cues: CaptionCue[]
  style: CaptionStylePreset
  fontSizePct?: number
  positionY?: number
  emphasis?: boolean
  uppercase?: boolean
  currentTime: number
  /** px height of the preview container */
  containerHeight: number
}) {
  const cue = cueAt(props.cues, props.currentTime)
  if (!cue || props.style.id === 'none') return null

  const emphasis = props.emphasis ?? props.style.emphasis
  const uppercase = props.uppercase ?? props.style.uppercase
  const fontSize = ((props.fontSizePct ?? props.style.fontSizePct) / 100) * props.containerHeight
  const outlineWidth = props.style.outlineWidth * (fontSize / 70)
  const activeIdx = emphasis ? wordIndexAt(cue, props.currentTime) : -1

  const wordStyle = (isActive: boolean): React.CSSProperties => ({
    color: isActive ? props.style.highlightColor : props.style.textColor,
    transition: 'color 90ms linear'
  })

  const boxStyle: React.CSSProperties = {
    position: 'absolute',
    left: '50%',
    transform: 'translateX(-50%)',
    top: `${((props.positionY ?? props.style.positionY) * 100).toFixed(1)}%`,
    width: '86%',
    textAlign: 'center',
    fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
    fontWeight: props.style.fontFile.includes('900') ? 900 : props.style.fontFile.includes('800') ? 800 : props.style.fontFile.includes('700') ? 700 : props.style.fontFile.includes('600') ? 600 : 400,
    fontSize: `${fontSize}px`,
    lineHeight: 1.25,
    textTransform: uppercase ? 'uppercase' : 'none',
    WebkitTextStroke: outlineWidth > 0 ? `${outlineWidth.toFixed(1)}px ${props.style.outlineColor}` : undefined,
    paintOrder: 'stroke fill',
    textShadow: props.style.shadow > 0 ? `0 ${props.style.shadow}px ${props.style.shadow * 2}px rgba(0,0,0,0.75)` : undefined,
    background: props.style.boxOpacity > 0 ? hexToRgba(props.style.boxColor, props.style.boxOpacity) : undefined,
    padding: props.style.boxOpacity > 0 ? `${fontSize * 0.18}px ${fontSize * 0.42}px` : undefined,
    borderRadius: props.style.boxOpacity > 0 ? `${fontSize * 0.22}px` : undefined,
    pointerEvents: 'none',
    whiteSpace: 'pre-wrap'
  }

  return (
    <div style={boxStyle} aria-hidden>
      {emphasis && cue.words.length > 0
        ? cue.words.map((w, i) => (
            <React.Fragment key={i}>
              <span style={wordStyle(i === activeIdx)}>{uppercase ? w.text.toUpperCase() : w.text}</span>
              {i < cue.words.length - 1 ? ' ' : ''}
            </React.Fragment>
          ))
        : cue.lines.join('\n')}
    </div>
  )
}

function hexToRgba(hex: string, opacity: number): string {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r},${g},${b},${opacity})`
}
