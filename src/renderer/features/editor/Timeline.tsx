import React, { useCallback, useEffect, useRef, useState } from 'react'
import { formatClock } from '@shared/utils/time'

/**
 * Timeline: source duration, clip range, draggable in/out handles,
 * playhead. Dragging updates the clip range in real time (spec §25).
 */
export function Timeline(props: {
  duration: number
  startTime: number
  endTime: number
  currentTime: number
  onSeek: (t: number) => void
  onChangeRange: (start: number, end: number) => void
  targetRange?: { min: number; max: number } | null
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

  const ticks = buildTicks(props.duration)

  return (
    <div className="timeline" style={{ userSelect: 'none' }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
        <span className="tiny">{formatClock(props.currentTime, true)}</span>
        <span className="tiny">
          clip {formatClock(props.startTime)} → {formatClock(props.endTime)} · {(props.endTime - props.startTime).toFixed(1)}s
          {props.targetRange && (
            <span style={{ marginLeft: 6, color: inTarget(props.endTime - props.startTime, props.targetRange) ? 'var(--success)' : 'var(--warn)' }}>
              target {props.targetRange.min}–{props.targetRange.max}s
            </span>
          )}
        </span>
        <span className="tiny">{formatClock(props.duration)}</span>
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
        {ticks.map((t) => (
          <div key={t} className="timeline-tick" style={{ left: `${pct(t)}%` }} />
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
    </div>
  )
}

function inTarget(dur: number, target: { min: number; max: number }): boolean {
  return dur >= target.min * 0.65 && dur <= target.max * 1.35
}

function buildTicks(duration: number): number[] {
  const targetCount = 10
  const rawStep = duration / targetCount
  const niceSteps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800]
  const step = niceSteps.find((s) => s >= rawStep) ?? 3600
  const ticks: number[] = []
  for (let t = 0; t <= duration; t += step) ticks.push(t)
  return ticks
}
