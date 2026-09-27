import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ZoomIn, ZoomOut, Maximize2 } from 'lucide-react'
import { formatClock } from '@shared/utils/time'
import type { CaptionCue } from '@shared/captions/segmentation'
import { mediaUrl } from '../../api/client'

/**
 * Professional timeline (§11-21): zoom + pan, FFmpeg-generated filmstrip and
 * waveform, silence-cut visualization, magnetic snapping to cue/cut/second
 * boundaries, large trim handles with live tooltips, and frame-accurate
 * keyboard trimming. All data is real — the filmstrip and waveform come from
 * the backend's FFmpeg passes.
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
  fps?: number | null
  silenceCuts?: Array<{ start: number; end: number }>
  filmstrip?: Array<{ t: number; path: string }> | null
  waveform?: { peaks: number[]; duration: number } | null
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const waveCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const [pxPerSec, setPxPerSec] = useState(0) // 0 = auto-fit (initial)
  const [viewStart, setViewStart] = useState(0) // seconds at the left edge
  const [dragging, setDragging] = useState<'start' | 'end' | 'playhead' | null>(null)
  const [snapLine, setSnapLine] = useState<number | null>(null)
  const [hoverTime, setHoverTime] = useState<number | null>(null)
  const snapEnabledRef = useRef(true)

  const duration = Math.max(0.001, props.duration)

  // Effective px/sec: auto-fit until the user zooms.
  const [fitted, setFitted] = useState(true)
  const containerWidth = scrollRef.current?.clientWidth ?? 0
  const effectivePxPerSec = fitted
    ? Math.max(2, (containerWidth || 800) / duration)
    : pxPerSec
  const contentWidth = duration * effectivePxPerSec

  // Snap targets: cue edges, silence-cut edges, integer seconds, playhead.
  const snapTargets = useMemo(() => {
    const t: number[] = [0, props.currentTime]
    for (const cue of props.cues ?? []) t.push(cue.startTime, cue.endTime)
    for (const cut of props.silenceCuts ?? []) t.push(cut.start, cut.end)
    const step = effectivePxPerSec > 60 ? 0.5 : effectivePxPerSec > 20 ? 1 : 5
    for (let s = 0; s <= duration; s += step) t.push(s)
    return t
  }, [props.cues, props.silenceCuts, props.currentTime, duration, effectivePxPerSec])

  const snapTime = useCallback(
    (t: number, alt: boolean): { t: number; snapped: boolean } => {
      if (alt) return { t, snapped: false }
      const threshold = 8 / effectivePxPerSec // 8px magnetism
      let best: number | null = null
      let bestDist = threshold
      for (const target of snapTargets) {
        const d = Math.abs(target - t)
        if (d < bestDist) {
          best = target
          bestDist = d
        }
      }
      return best !== null ? { t: best, snapped: true } : { t, snapped: false }
    },
    [snapTargets, effectivePxPerSec]
  )

  const timeAtX = useCallback(
    (clientX: number): number => {
      const el = scrollRef.current
      if (!el) return 0
      const rect = el.getBoundingClientRect()
      const x = clientX - rect.left + el.scrollLeft
      return Math.min(duration, Math.max(0, x / effectivePxPerSec))
    },
    [duration, effectivePxPerSec]
  )

  // ------------------------------------------------------------ dragging ---
  useEffect(() => {
    if (!dragging) return
    const move = (e: PointerEvent) => {
      const raw = timeAtX(e.clientX)
      const { t, snapped } = snapTime(raw, e.altKey)
      setSnapLine(snapped ? t : null)
      if (dragging === 'start') {
        props.onChangeRange(Math.min(t, props.endTime - 1 / (props.fps ?? 25)), props.endTime)
      } else if (dragging === 'end') {
        props.onChangeRange(props.startTime, Math.max(t, props.startTime + 1 / (props.fps ?? 25)))
      } else {
        props.onSeek(t)
      }
    }
    const up = () => {
      setDragging(null)
      setSnapLine(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [dragging, timeAtX, snapTime, props, props.fps])

  // ---------------------------------------------------------------- wheel ---
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const anchorTime = timeAtX(e.clientX)
        const factor = e.deltaY < 0 ? 1.25 : 0.8
        const next = Math.min(400, Math.max(1, effectivePxPerSec * factor))
        setPxPerSec(next)
        setFitted(false)
        requestAnimationFrame(() => {
          const el2 = scrollRef.current
          if (el2) el2.scrollLeft = anchorTime * next - (e.clientX - el2.getBoundingClientRect().left)
        })
      } else if (!e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault()
        el.scrollLeft += e.deltaY * (effectivePxPerSec > 30 ? 1.5 : 6)
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [effectivePxPerSec, timeAtX])

  const viewSeconds = (containerWidth || 800) / effectivePxPerSec

  // ------------------------------------------------------------- drawing ---
  const drawWave = useCallback(() => {
    const canvas = waveCanvasRef.current
    const data = props.waveform
    if (!canvas || !data || data.peaks.length === 0) return
    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (w === 0 || h === 0) return
    canvas.width = w * dpr
    canvas.height = h * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, w, h)
    const from = viewStart
    const to = viewStart + viewSeconds
    const n = data.peaks.length
    const t0 = (from / data.duration) * n
    const t1 = (to / data.duration) * n
    const span = Math.max(1, t1 - t0)
    const mid = h / 2
    ctx.fillStyle = 'rgba(120, 170, 255, 0.85)'
    for (let x = 0; x < w; x++) {
      const i0 = Math.floor(t0 + (x / w) * span)
      const i1 = Math.floor(t0 + ((x + 1) / w) * span)
      let peak = 0
      for (let i = Math.max(0, i0); i < Math.min(n, Math.max(i1, i0 + 1)); i++) {
        if (data.peaks[i] > peak) peak = data.peaks[i]
      }
      const hh = Math.max(0.75, peak * (h / 2 - 1))
      ctx.fillRect(x, mid - hh, 1, hh * 2)
    }
    // dim the parts outside the clip range
    ctx.fillStyle = 'rgba(10, 12, 16, 0.55)'
    const xs = (props.startTime / duration) * effectivePxPerSec
    const xe = (props.endTime / duration) * effectivePxPerSec
    if (xs > 0) ctx.fillRect(0, 0, Math.min(xs, w), h)
    if (xe < w) ctx.fillRect(Math.min(xe, w), 0, w - Math.min(xe, w), h)
  }, [props.waveform, props.startTime, props.endTime, viewStart, viewSeconds, effectivePxPerSec, duration])

  useEffect(() => {
    drawWave()
  }, [drawWave])

  // Track scroll → viewStart (for waveform + ruler)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => setViewStart(el.scrollLeft / effectivePxPerSec)
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [effectivePxPerSec])

  // ---------------------------------------------------------------- ticks ---
  const buildTicks = useCallback((from: number, to: number) => {
    const span = to - from
    const targetCount = Math.max(4, Math.min(14, Math.floor(span / 3)))
    const rawStep = span / targetCount
    const niceSteps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]
    const step = niceSteps.find((s) => s >= rawStep) ?? 3600
    const majors: number[] = []
    for (let t = Math.ceil(from / step) * step; t <= to; t += step) majors.push(Math.round(t * 1000) / 1000)
    return { majors, step }
  }, [])

  const { majors, step } = buildTicks(viewStart, viewStart + viewSeconds)
  const pct = (t: number) => (t / duration) * 100

  const frameSec = 1 / (props.fps && props.fps > 0 ? props.fps : 25)
  const inTarget = props.targetRange
    ? props.endTime - props.startTime >= props.targetRange.min * 0.65 && props.endTime - props.startTime <= props.targetRange.max * 1.35
    : true

  const showFilmstrip = (props.filmstrip ?? []).length > 0 && (duration / (props.filmstrip?.length ?? 1)) * effectivePxPerSec > 12

  const keepCutBands = (props.silenceCuts ?? []).filter((c) => c.end > props.startTime && c.start < props.endTime)

  return (
    <div className="timeline">
      <div className="row tl-toolbar">
        <span className="tiny">
          clip{' '}
          <span className="mono" style={{ color: 'var(--text-2)' }}>
            {formatClock(props.startTime, true)} → {formatClock(props.endTime, true)}
          </span>
          <span style={{ color: 'var(--text-2)' }}>
            {' '}
            · {(props.endTime - props.startTime).toFixed(1)}s
            {keepCutBands.length > 0 && (
              <span style={{ color: 'var(--danger)' }}>
                {' '}
                −{keepCutBands.reduce((s, c) => s + (Math.min(c.end, props.endTime) - Math.max(c.start, props.startTime)), 0).toFixed(1)}s silence
              </span>
            )}
          </span>
          {props.targetRange && (
            <span style={{ marginLeft: 8, color: inTarget ? 'var(--success)' : 'var(--warn)' }}>
              target {props.targetRange.min}–{props.targetRange.max}s
            </span>
          )}
        </span>
        <span style={{ flex: 1 }} />
        <span className="tiny" style={{ color: 'var(--text-3)' }}>
          {dragging === 'start' || dragging === 'end' ? (
            <span className="mono">snapping {snapLine !== null ? '●' : '○'} (hold Alt to disable)</span>
          ) : (
            <>scroll = pan · ctrl+scroll = zoom</>
          )}
        </span>
        <button
          className="btn ghost sm icon"
          title="Zoom out"
          aria-label="Zoom out"
          onClick={() => {
            setPxPerSec(Math.max(1, effectivePxPerSec * 0.6))
            setFitted(false)
          }}
        >
          <ZoomOut size={13} />
        </button>
        <button
          className="btn ghost sm icon"
          title="Zoom in"
          aria-label="Zoom in"
          onClick={() => {
            setPxPerSec(Math.min(400, effectivePxPerSec * 1.6))
            setFitted(false)
          }}
        >
          <ZoomIn size={13} />
        </button>
        <button
          className="btn ghost sm icon"
          title="Fit whole source"
          aria-label="Fit whole source"
          onClick={() => {
            setFitted(true)
            if (scrollRef.current) scrollRef.current.scrollLeft = 0
          }}
        >
          <Maximize2 size={13} />
        </button>
      </div>

      <div
        ref={scrollRef}
        className="tl-scroll"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('[data-handle]')) return
          const t = snapTime(timeAtX(e.clientX), e.altKey).t
          props.onSeek(t)
          setDragging('playhead')
        }}
        onPointerMove={(e) => setHoverTime(timeAtX(e.clientX))}
        onPointerLeave={() => setHoverTime(null)}
      >
        <div className="tl-content" style={{ width: contentWidth }}>
          {/* ruler */}
          <div className="tl-ruler">
            {majors.map((t) => (
              <span key={t} className="ruler-label mono" style={{ left: `${pct(t)}%` }}>
                {formatClock(t, true)}
                <i className="tl-ruler-tick" />
              </span>
            ))}
          </div>

          {/* filmstrip */}
          {showFilmstrip && (
            <div className="tl-film" aria-hidden={undefined}>
              {(props.filmstrip ?? []).map((f, i) => (
                <img
                  key={i}
                  src={mediaUrl(f.path)}
                  alt=""
                  draggable={false}
                  style={{ left: `${pct(f.t)}%`, width: `${(duration / (props.filmstrip?.length ?? 1)) * effectivePxPerSec}px` }}
                />
              ))}
            </div>
          )}

          {/* waveform */}
          {props.waveform && props.waveform.peaks.length > 0 && (
            <div className="tl-wave">
              <canvas ref={waveCanvasRef} />
            </div>
          )}

          {/* source track with clip range + silence cuts */}
          <div className="timeline-track tl-track">
            {/* out-of-clip shading */}
            <div className="tl-outside" style={{ left: 0, width: `${pct(props.startTime)}%` }} />
            <div className="tl-outside" style={{ left: `${pct(props.endTime)}%`, right: 0 }} />

            <div
              className="timeline-range"
              style={{ left: `${pct(props.startTime)}%`, width: `${pct(props.endTime) - pct(props.startTime)}%` }}
            />

            {/* silence cuts inside the clip */}
            {keepCutBands.map((c, i) => (
              <div
                key={i}
                className="tl-silence"
                style={{
                  left: `${pct(Math.max(c.start, props.startTime))}%`,
                  width: `${pct(Math.min(c.end, props.endTime)) - pct(Math.max(c.start, props.startTime))}%`
                }}
                title={`Removed silence ${formatClock(c.start, true)} → ${formatClock(c.end, true)}`}
              />
            ))}

            {/* trim handles */}
            <div
              className="tl-handle-big"
              data-handle="start"
              role="slider"
              aria-label="Clip start"
              aria-valuemin={0}
              aria-valuemax={duration}
              aria-valuenow={props.startTime}
              tabIndex={0}
              style={{ left: `calc(${pct(props.startTime)}% - 11px)` }}
              onPointerDown={(e) => {
                e.stopPropagation()
                ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
                setDragging('start')
              }}
              onKeyDown={(e) => {
                const d = (e.shiftKey ? 1 : frameSec) * (e.key === 'ArrowLeft' ? -1 : 1)
                if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                  e.preventDefault()
                  props.onChangeRange(
                    Math.min(Math.max(0, props.startTime + d), props.endTime - frameSec),
                    props.endTime
                  )
                }
              }}
            >
              <i className="tl-handle-grip" />
              {(dragging === 'start' || hoverTime !== null) && (
                <span className="tl-tooltip mono">{formatClock(props.startTime, true)}</span>
              )}
            </div>

            <div
              className="tl-handle-big end"
              data-handle="end"
              role="slider"
              aria-label="Clip end"
              aria-valuemin={0}
              aria-valuemax={duration}
              aria-valuenow={props.endTime}
              tabIndex={0}
              style={{ left: `calc(${pct(props.endTime)}% - 11px)` }}
              onPointerDown={(e) => {
                e.stopPropagation()
                ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
                setDragging('end')
              }}
              onKeyDown={(e) => {
                const d = (e.shiftKey ? 1 : frameSec) * (e.key === 'ArrowRight' ? 1 : -1)
                if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                  e.preventDefault()
                  props.onChangeRange(
                    props.startTime,
                    Math.max(Math.min(duration, props.endTime + d), props.startTime + frameSec)
                  )
                }
              }}
            >
              <i className="tl-handle-grip" />
              {dragging === 'end' && <span className="tl-tooltip mono">{formatClock(props.endTime, true)}</span>}
            </div>

            <div className="timeline-playhead" style={{ left: `${pct(props.currentTime)}%` }} />
            {snapLine !== null && <div className="tl-snapline" style={{ left: `${pct(snapLine)}%` }} />}
          </div>

          {/* caption strip */}
          {props.cues && (
            <div className="timeline-captions" aria-hidden>
              {props.cues.map((cue) => (
                <div
                  key={cue.key}
                  className={`timeline-caption ${
                    props.currentTime >= cue.startTime && props.currentTime <= cue.endTime ? 'active' : ''
                  }`}
                  style={{
                    left: `${pct(cue.startTime)}%`,
                    width: `${Math.max(0.4, pct(cue.endTime) - pct(cue.startTime))}%`
                  }}
                  title={`${formatClock(cue.startTime, true)} — ${cue.text}`}
                >
                  {cue.text}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="row tiny" style={{ justifyContent: 'space-between', marginTop: 4 }}>
        <span style={{ color: 'var(--text-3)' }}>
          {props.fps ? `${props.fps.toFixed(2)} fps · arrow keys step one frame (Shift = 1s)` : ''}
        </span>
        <span className="mono" style={{ color: 'var(--text-3)' }}>
          {formatClock(viewStart, true)} – {formatClock(viewStart + viewSeconds, true)} of {formatClock(duration, true)}
        </span>
      </div>
    </div>
  )
}
