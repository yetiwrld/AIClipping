import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatClock } from '@shared/utils/time'
import type { CaptionCue } from '@shared/captions/segmentation'

/**
 * Timeline: ruler with time labels, source track with clip range, draggable
 * in/out handles, playhead, and a caption-timing strip (spec §25).
 * Dragging updates the clip range in real time.
 */
export function Timeline(props: {
  duration: number
  startTime: number
  endTime: number
  currentTime: number
  onSeek: (t: number) => void
  onChangeRange: (start: number, end: number) => void
  targetRange?: { min: number; max: number } | null
  cues?: CaptionCue[]
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState<'start' | 'end' | 'playhead' | null>(null)

  const pct = (t: number) => Math.min(100, Math.max(0, (t / Math.max(0.001, props.duration)) * 100))

  const timeAt = useCallback(
    (clientX: number): number => {
      const rect = trackRef.current?.getBoundingClientRect()
      if (!rect) return 0
      const ratio = (clientX - rect.left) / rect.width
      return Math.min(props.duration, Math.max(0, ratio * props.duration))
    },
    [props.duration]
  )

  useEffect(() => {
    if (!dragging) return
    const move = (e: PointerEvent) => {
      const t = timeAt(e.clientX)
      if (dragging === 'start') {
        props.onChangeRange(Math.min(t, props.endTime - 0.5), props.endTime)
      } else if (dragging === 'end') {
        props.onChangeRange(props.startTime, Math.max(t, props.startTime + 0.5))
      } else {
        props.onSeek(t)
      }
    }
    const up = () => setDragging(null)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [dragging, timeAt, props])

  const { majors, minors } = buildTicks(props.duration)
  const activeCue = useMemo(
    () => (props.cues ? props.cues.find((c) => props.currentTime >= c.startTime && props.currentTime <= c.endTime) : undefined),
    [props.cues, props.currentTime]
  )
  const inTarget = props.targetRange
    ? props.endTime - props.startTime >= props.targetRange.min * 0.65 && props.endTime - props.startTime <= props.targetRange.max * 1.35
    : true

  return (
    <div className="timeline">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 5 }}>
        <span className="tiny">
          clip <span className="mono" style={{ color: 'var(--text-2)' }}>{formatClock(props.startTime)} → {formatClock(props.endTime)}</span>
          <span style={{ color: 'var(--text-2)' }}> · {(props.endTime - props.startTime).toFixed(1)}s</span>
          {props.targetRange && (
            <span style={{ marginLeft: 8, color: inTarget ? 'var(--success)' : 'var(--warn)' }}>
              target {props.targetRange.min}–{props.targetRange.max}s
            </span>
          )}
        </span>
        <span className="tiny mono">source {formatClock(props.duration)}</span>
      </div>

      <div className="timeline-ruler">
        {majors.map((t) => (
          <span key={t} className="ruler-label" style={{ left: `${pct(t)}%` }}>
            {formatClock(t)}
          </span>
        ))}
      </div>

      <div
        ref={trackRef}
        className="timeline-track"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).dataset.handle) return
          props.onSeek(timeAt(e.clientX))
          setDragging('playhead')
        }}
      >
        {minors.map((t) => (
          <div key={`m${t}`} className="timeline-tick" style={{ left: `${pct(t)}%` }} />
        ))}
        {majors.map((t) => (
          <div key={`M${t}`} className="timeline-tick major" style={{ left: `${pct(t)}%` }} />
        ))}

        <div className="timeline-range" style={{ left: `${pct(props.startTime)}%`, width: `${pct(props.endTime) - pct(props.startTime)}%` }} />

        <div
          className="timeline-handle"
          data-handle="start"
          role="slider"
          aria-label="Clip start"
          aria-valuemin={0}
          aria-valuemax={props.duration}
          aria-valuenow={props.startTime}
          tabIndex={0}
          style={{ left: `${pct(props.startTime)}%` }}
          onPointerDown={(e) => {
            e.stopPropagation()
            setDragging('start')
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') props.onChangeRange(Math.max(0, props.startTime - (e.shiftKey ? 1 : 0.1)), props.endTime)
            if (e.key === 'ArrowRight') props.onChangeRange(Math.min(props.endTime - 0.5, props.startTime + (e.shiftKey ? 1 : 0.1)), props.endTime)
          }}
        />

        <div
          className="timeline-handle"
          data-handle="end"
          role="slider"
          aria-label="Clip end"
          aria-valuemin={0}
          aria-valuemax={props.duration}
          aria-valuenow={props.endTime}
          tabIndex={0}
          style={{ left: `${pct(props.endTime)}%` }}
          onPointerDown={(e) => {
            e.stopPropagation()
            setDragging('end')
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') props.onChangeRange(props.startTime, Math.max(props.startTime + 0.5, props.endTime - (e.shiftKey ? 1 : 0.1)))
            if (e.key === 'ArrowRight') props.onChangeRange(props.startTime, Math.min(props.duration, props.endTime + (e.shiftKey ? 1 : 0.1)))
          }}
        />

        <div className="timeline-playhead" style={{ left: `${pct(props.currentTime)}%` }} />
      </div>

      {props.cues && (
        <div className="timeline-captions" aria-hidden>
          {props.cues.map((cue) => (
            <div
              key={cue.key}
              className={`timeline-caption ${activeCue?.key === cue.key ? 'active' : ''}`}
              style={{ left: `${pct(cue.startTime)}%`, width: `${Math.max(0.4, pct(cue.endTime) - pct(cue.startTime))}%` }}
              title={`${formatClock(cue.startTime)} — ${cue.text}`}
            >
              {cue.text}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function buildTicks(duration: number): { majors: number[]; minors: number[] } {
  const targetCount = 8
  const rawStep = duration / targetCount
  const niceSteps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]
  const step = niceSteps.find((s) => s >= rawStep) ?? 3600
  const majors: number[] = []
  for (let t = 0; t <= duration; t += step) majors.push(t)
  const minorStep = step / 4
  const minors: number[] = []
  for (let t = 0; t <= duration; t += minorStep) {
    if (!majors.some((m) => Math.abs(m - t) < minorStep * 0.25)) minors.push(t)
  }
  return { majors, minors }
}
