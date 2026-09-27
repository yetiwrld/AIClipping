import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ScanEye,
  Link,
  ArrowLeft, Play, Pause, Volume2, VolumeX, SkipBack, Type, Crop, Tags, Copy,
  ChevronRight, Scissors, Wand2, Save, Undo2, Redo2, AlertTriangle, ShieldCheck,
  Gauge, Film, AudioLines, Eraser, RotateCcw, Zap
} from 'lucide-react'
import { api, errMessage, mediaUrl, copyText } from '../../api/client'
import { useAppStore } from '../../stores/app'
import { useDataStore } from '../../stores/data'
import { ErrorBox, Field, Spinner, Switch } from '../../components/ui'
import { buildCues, cueAt } from '@shared/captions/segmentation'
import { computeCrop, contentRectOf, smartWindowAt } from '@shared/video/crop'
import { keptSegments, keptDuration } from '@shared/video/segments'
import {
  ASPECT_RATIOS, CAPTION_STYLES, RESOLUTION_PRESETS, QUALITY_PRESETS, estimateRenderSizeMb,
  getCaptionStyle, getDurationRange, getPlatformPreset, PLATFORM_PRESETS, resolutionFor
} from '@shared/constants'
import type { CaptionOverrides, Clip, Project, TranscriptSegment } from '@shared/types'
import { formatClock } from '@shared/utils/time'
import { relinkProjectSource } from '../project/relink'
import { Timeline } from './Timeline'
import { CaptionPreview } from './CaptionPreview'

/**
 * Clip editor — professional workspace layout:
 * top bar (identity + undo/redo + render) / stage + inspector / timeline + transport.
 * Playback has explicit error states with a real FFmpeg proxy workflow (§4-8),
 * JKL + frame-accurate shortcuts (§9-10), silence-cut preview skipping (§40),
 * and per-clip output settings (§49-56).
 */

type PlaybackStatus = {
  verdict: 'native' | 'proxy' | 'audio-only' | 'missing'
  reason: string
  proxyExists: boolean
  proxyPath: string | null
  sourceExists: boolean
  sourcePath: string | null
} | null

const SNAPSHOT_EXCLUDE = new Set(['id', 'projectId', 'candidateId', 'status', 'createdAt', 'updatedAt'])
type ClipSnapshot = Partial<Clip>

export function EditorPage() {
  const app = useAppStore()
  const data = useDataStore()
  const clipId = app.editorClipId
  const projectId = app.projectId

  const [clip, setClip] = useState<Clip | null>(null)
  const [segments, setSegments] = useState<TranscriptSegment[]>([])
  const [error, setError] = useState<unknown>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty'>('saved')
  const [renderQueued, setRenderQueued] = useState(false)
  const [previewQueued, setPreviewQueued] = useState(false)

  // playback compatibility + proxy workflow
  const [playback, setPlayback] = useState<PlaybackStatus>(null)
  const [videoError, setVideoError] = useState<string | null>(null)
  const [proxyRunning, setProxyRunning] = useState(false)
  const [relinking, setRelinking] = useState(false)

  // timeline visuals (real, FFmpeg-generated)
  const [filmstrip, setFilmstrip] = useState<Array<{ t: number; path: string }> | null>(null)
  const [waveform, setWaveform] = useState<{ peaks: number[]; duration: number } | null>(null)

  const videoRef = useRef<HTMLVideoElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 })
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadedRef = useRef<string | null>(null)
  const clipRef = useRef<Clip | null>(null)
  const historyRef = useRef<{ past: ClipSnapshot[]; future: ClipSnapshot[]; lastPush: number }>({
    past: [], future: [], lastPush: 0
  })
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false })

  useEffect(() => {
    clipRef.current = clip
  }, [clip])

  // ---------------------------------------------------------------- load ---
  useEffect(() => {
    if (!clipId || !projectId) {
      app.navigate('dashboard')
      return
    }
    if (loadedRef.current === clipId) return
    loadedRef.current = clipId
    void (async () => {
      try {
        const [allClips, transcript] = await Promise.all([
          api['clips.list']({ projectId }),
          api['transcript.get']({ projectId })
        ])
        const found = allClips.find((c) => c.id === clipId)
        if (!found) throw new Error('This clip no longer exists.')
        setClip(found)
        setSegments(transcript)
        setCurrentTime(found.startTime)
        historyRef.current = { past: [], future: [], lastPush: 0 }
      } catch (err) {
        setError(err)
      }
    })()
    // Playback compatibility (§4-7): decide direct vs proxy before playback.
    void api['media.checkPlayback']({ projectId }).then(setPlayback).catch(() => setPlayback(null))
    // Timeline visuals — real FFmpeg output, loaded in the background.
    void api['media.filmstrip']({ projectId, count: 24 })
      .then((r) => setFilmstrip(r.frames))
      .catch(() => setFilmstrip(null))
    void api['media.waveform']({ projectId })
      .then((r) => (r.silent || r.peaks.length === 0 ? setWaveform(null) : setWaveform({ peaks: r.peaks, duration: r.duration })))
      .catch(() => setWaveform(null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipId, projectId])

  // ------------------------------------------------------------- autosave ---
  const snapshotOf = (c: Clip): ClipSnapshot => {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(c) as Array<keyof Clip>) {
      if (!SNAPSHOT_EXCLUDE.has(key)) out[key] = c[key]
    }
    return out as ClipSnapshot
  }

  const pushHistory = useCallback(() => {
    const prev = clipRef.current
    if (!prev) return
    const h = historyRef.current
    const now = Date.now()
    if (now - h.lastPush > 900 || h.past.length === 0) {
      h.past.push(snapshotOf(prev))
      if (h.past.length > 50) h.past.shift()
    }
    h.future = []
    h.lastPush = now
    setHistoryState({ canUndo: h.past.length > 0, canRedo: false })
  }, [])

  const updateClip = useCallback((patch: Partial<Clip>, immediate = false, history = true) => {
    if (history) pushHistory()
    setClip((prev) => (prev ? { ...prev, ...patch } : prev))
    setSaveState('dirty')
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(
      () => void saveNow(patch),
      immediate ? 0 : 700
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function saveNow(patch: Partial<Clip>) {
    if (!clipId) return
    setSaveState('saving')
    try {
      const saved = await api['clips.update']({ id: clipId, patch: patch as Record<string, unknown> })
      setClip((prev) => (prev ? { ...prev, ...saved } : saved))
      setSaveState('saved')
      void data.loadClips(saved.projectId)
    } catch (err) {
      setSaveState('dirty')
      app.toast({ level: 'error', ...errMessage(err) })
    }
  }

  // ------------------------------------------------------------ undo/redo ---
  const undo = useCallback(() => {
    const h = historyRef.current
    const prevSnap = h.past.pop()
    const cur = clipRef.current
    if (!prevSnap || !cur) return
    h.future.push(snapshotOf(cur))
    h.lastPush = 0
    setHistoryState({ canUndo: h.past.length > 0, canRedo: h.future.length > 0 })
    setClip({ ...cur, ...prevSnap })
    setSaveState('dirty')
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => void saveNow(prevSnap), 300)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const redo = useCallback(() => {
    const h = historyRef.current
    const nextSnap = h.future.pop()
    const cur = clipRef.current
    if (!nextSnap || !cur) return
    h.past.push(snapshotOf(cur))
    h.lastPush = 0
    setHistoryState({ canUndo: h.past.length > 0, canRedo: h.future.length > 0 })
    setClip({ ...cur, ...nextSnap })
    setSaveState('dirty')
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => void saveNow(nextSnap), 300)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ------------------------------------------------------------- playback ---
  useEffect(() => {
    const id = setInterval(() => {
      if (videoRef.current) setCurrentTime(videoRef.current.currentTime)
    }, 120)
    return () => clearInterval(id)
  }, [])

  const useProxySrc = playback?.verdict === 'proxy' && playback.proxyExists

  const togglePlay = useCallback(() => {
    const v = videoRef.current
    if (!v || !clip) return
    if (v.paused) {
      if (currentTime < clip.startTime || currentTime > clip.endTime) {
        v.currentTime = clip.startTime
        setCurrentTime(clip.startTime)
      }
      void v.play()
    } else {
      v.pause()
    }
  }, [clip, currentTime])

  /** J = rewind (Chromium can't play backwards; we step back at speed). */
  const rewind = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    v.pause()
    const step = 0.34
    v.currentTime = Math.max(0, v.currentTime - step)
    setCurrentTime(v.currentTime)
  }, [])

  /** L = play; repeated presses speed up (1× → 1.5× → 2×). */
  const playForward = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) {
      v.playbackRate = 1
      void v.play()
    } else if (v.playbackRate < 2) {
      v.playbackRate = v.playbackRate === 1 ? 1.5 : 2
    }
  }, [])

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const onPlay = () => setPlaying(true)
    const onPause = () => {
      setPlaying(false)
      v.playbackRate = 1
    }
    const onRate = () => {
      if (v.playbackRate === 1) return
    }
    v.addEventListener('play', onPlay)
    v.addEventListener('pause', onPause)
    v.addEventListener('ratechange', onRate)
    return () => {
      v.removeEventListener('play', onPlay)
      v.removeEventListener('pause', onPause)
      v.removeEventListener('ratechange', onRate)
    }
  }, [clip, useProxySrc])

  /** Seek that respects silence cuts: landing inside a removed range jumps to
   *  its start boundary, exactly like the rendered output behaves (§40). */
  const seekTo = useCallback((t: number) => {
    const v = videoRef.current
    const c = clipRef.current
    if (!v) return
    let target = t
    if (c) {
      const cut = (c.silenceCuts ?? []).find((x) => t > x.start + 0.02 && t < x.end - 0.02)
      if (cut) target = cut.start
    }
    v.currentTime = Math.max(0, target)
    setCurrentTime(v.currentTime)
  }, [])

  // Preview during playback: skip removed silence, loop within the clip range.
  useEffect(() => {
    const v = videoRef.current
    if (!v || !clip) return
    const onTime = () => {
      const cuts = clip.silenceCuts ?? []
      const inCut = cuts.find((c) => v.currentTime >= c.start && v.currentTime < c.end && c.end <= clip.endTime)
      if (inCut) {
        v.currentTime = inCut.end
        return
      }
      if (v.currentTime > clip.endTime) {
        if (playing) {
          v.currentTime = clip.startTime
        } else {
          v.pause()
        }
      }
    }
    v.addEventListener('timeupdate', onTime)
    return () => v.removeEventListener('timeupdate', onTime)
  }, [clip, playing])

  // ------------------------------------------------------ keyboard shortcuts --
  const frameStep = useCallback((dir: 1 | -1) => {
    const v = videoRef.current
    if (!v) return
    const fps = data.activeProject?.fps && data.activeProject.fps > 0 ? data.activeProject.fps : 25
    v.pause()
    seekTo(v.currentTime + dir / fps)
  }, [data.activeProject, seekTo])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable) return
      if (!clip) return
      const v = videoRef.current
      const fps = data.activeProject?.fps && data.activeProject.fps > 0 ? data.activeProject.fps : 25
      if (e.code === 'Space') {
        e.preventDefault()
        togglePlay()
      } else if (e.key === 'j' || e.key === 'J') {
        e.preventDefault()
        rewind()
      } else if (e.key === 'k' || e.key === 'K') {
        e.preventDefault()
        v?.pause()
      } else if (e.key === 'l' || e.key === 'L') {
        e.preventDefault()
        playForward()
      } else if (e.key === ',') {
        frameStep(-1)
      } else if (e.key === '.') {
        frameStep(1)
      } else if (e.key === 'i' || e.key === 'I') {
        updateClip({ startTime: Math.min(currentTime, clip.endTime - 1 / fps) })
      } else if (e.key === 'o' || e.key === 'O') {
        updateClip({ endTime: Math.max(currentTime, clip.startTime + 1 / fps) })
      } else if (e.key === 'Home') {
        e.preventDefault()
        seekTo(clip.startTime)
      } else if (e.key === 'End') {
        e.preventDefault()
        seekTo(clip.endTime - 1 / fps)
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        if (v) seekTo(v.currentTime - (e.shiftKey ? 5 : 1))
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        if (v) seekTo(v.currentTime + (e.shiftKey ? 5 : 1))
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [clip, currentTime, togglePlay, updateClip, rewind, playForward, frameStep, seekTo, undo, redo, data.activeProject])

  // ------------------------------------------------------------- captions ---
  const project = data.activeProject
  const style = getCaptionStyle(clip?.captionStyleId ?? 'classic')
  const cues = useMemo(() => {
    if (!clip) return []
    return buildCues(segments, {
      maxWordsPerCue: clip.captionOverrides.maxWordsPerCue ?? style.maxWordsPerCue,
      maxCharsPerLine: style.maxCharsPerLine,
      maxLines: style.maxLines,
      textEdits: clip.captionTextEdits,
      splits: clip.captionCueSplits,
      merges: clip.captionCueMerges,
      timingOffsets: clip.captionTimingOffsets,
      fromTime: clip.startTime,
      toTime: clip.endTime
    })
  }, [segments, clip, style])

  // Mirror of the render plan: crop toward the selected output target so the
  // preview shows exactly what FFmpeg produces (plan.ts buildRenderPlan).
  // Content-rect aware: baked-in source bars are excluded from every fill /
  // smart crop; `fit` shows the whole content letterboxed (§29).
  const target = clip ? resolutionFor(clip.aspectRatio, clip.outputResolution) : { w: 1080, h: 1920 }
  const baseCrop = useMemo(() => {
    if (!clip || !project?.width || !project?.height) return null
    return computeCrop(
      project.width, project.height, target.w, target.h,
      clip.cropMode === 'smart' ? 'center' : clip.cropMode,
      clip.cropX, clip.zoom, project.contentRect
    )
  }, [clip, project, target])
  const smartKeyframes = clip?.cropMode === 'smart' ? clip.smartCropKeyframes ?? [] : []
  const crop =
    baseCrop && clip && smartKeyframes.length > 0
      ? smartWindowAt(Math.min(Math.max(currentTime, clip.startTime), clip.endTime), smartKeyframes, baseCrop)
      : baseCrop
  const isFitCrop = clip?.cropMode === 'fit'

  /**
   * Video element geometry inside the output frame.
   * fill/smart: scale the frame so the crop window fills the frame (exact
   * FFmpeg crop+scale). fit: scale so the CONTENT area fits inside with
   * letterboxing — exactly the render plan's pad chain (§68 parity).
   */
  const videoStyle = useMemo(() => {
    if (!project?.width || !project.height || !crop) {
      return { width: '100%', height: '100%', objectFit: 'contain' as const }
    }
    if (isFitCrop) {
      const content = contentRectOf(project, project.width, project.height)
      const s = Math.min(target.w / content.width, target.h / content.height)
      const dispW = content.width * s
      const dispH = content.height * s
      const leftPx = (target.w - dispW) / 2 - content.left * s
      const topPx = (target.h - dispH) / 2 - content.top * s
      return {
        position: 'absolute' as const,
        width: `${(project.width * s * 100) / target.w}%`,
        height: `${(project.height * s * 100) / target.h}%`,
        left: `${(leftPx * 100) / target.w}%`,
        top: `${(topPx * 100) / target.h}%`,
        objectFit: 'fill' as const
      }
    }
    return {
      position: 'absolute' as const,
      width: `${(project.width / crop.w) * 100}%`,
      height: `${(project.height / crop.h) * 100}%`,
      left: `${-(crop.x / crop.w) * 100}%`,
      top: `${-(crop.y / crop.h) * 100}%`,
      objectFit: 'fill' as const
    }
  }, [project, crop, isFitCrop, target])

  // Measure the stage; the preview frame is sized from it so it always fits
  // and always honors the output aspect ratio exactly.
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setStageSize({ w: entry.contentRect.width, h: entry.contentRect.height })
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // --------------------------------------------------------- proxy actions ---
  async function createProxy() {
    if (!projectId) return
    setProxyRunning(true)
    try {
      await api['media.renderProxy']({ projectId })
      // Poll until the proxy file appears (the transcode runs as a task).
      for (let i = 0; i < 80; i++) {
        await new Promise((r) => setTimeout(r, 3000))
        try {
          const status = await api['media.checkPlayback']({ projectId })
          setPlayback(status)
          if (status.proxyExists) {
            setVideoError(null)
            app.toast({
              level: 'success',
              message: 'Preview proxy ready — playback switched to the proxy copy.',
              hint: 'Renders still use the original file at full quality.'
            })
            return
          }
        } catch {
          /* keep polling */
        }
      }
      app.toast({ level: 'warn', message: 'The proxy is still transcoding. Playback will use it once finished.' })
    } catch (err) {
      app.toast({ level: 'error', ...errMessage(err) })
    } finally {
      setProxyRunning(false)
    }
  }

  // ---------------------------------------------------------------- render ---
  async function queueRender(preview: boolean) {
    if (!clip) return
    if (preview) setPreviewQueued(true)
    else setRenderQueued(true)
    try {
      if (saveState !== 'saved') {
        if (saveTimer.current) clearTimeout(saveTimer.current)
        await saveNow(clip as unknown as Partial<Clip>)
      }
      await api['renders.queue']({ clipId: clip.id, preview })
      await data.loadRenders(clip.projectId)
      app.toast({
        level: 'success',
        message: preview
          ? 'Quick preview render queued (720p draft).'
          : 'Render queued. Progress appears in the Render queue.',
        actionLabel: 'Open queue',
        action: () => app.navigate('queue')
      })
    } catch (err) {
      app.toast({ level: 'error', ...errMessage(err) })
    } finally {
      setRenderQueued(false)
      setPreviewQueued(false)
    }
  }

  if (error) {
    return (
      <div className="page">
        <ErrorBox error={error} onRetry={() => app.navigate('project')} retryLabel="Back to project" />
      </div>
    )
  }

  if (!clip || !project) {
    return (
      <div className="page" style={{ display: 'grid', placeItems: 'center' }}>
        <Spinner size={20} />
      </div>
    )
  }

  const activeCue = cueAt(cues, currentTime)
  const targetRange = getDurationRange(project.settings.durationPreset)
  const kept = keptSegments(clip.startTime, clip.endTime, clip.silenceCuts ?? [])
  const outputSeconds = keptDuration(kept)

  // Fit the output-ratio frame inside the stage (letterboxed, never distorted).
  const ratio = target.w / target.h
  const frame =
    stageSize.w > 0 && stageSize.h > 0
      ? (() => {
          const w = Math.min(stageSize.w, stageSize.h * ratio)
          return { w, h: w / ratio }
        })()
      : { w: 0, h: 0 }

  return (
    <div className="editor-shell">
      {/* ------------------------------------------------------- top bar -- */}
      <div className="editor-topbar">
        <button className="btn ghost icon" onClick={() => app.openProject(project.id)} aria-label="Back to project">
          <ArrowLeft size={15} />
        </button>
        <input
          className="clip-title-input"
          value={clip.title}
          placeholder="Clip title"
          onChange={(e) => updateClip({ title: e.target.value })}
        />
        <span className={`save-state ${saveState === 'dirty' ? 'dirty' : ''}`}>
          {saveState === 'saving' && <Spinner size={11} />}
          {saveState === 'saved' ? 'Saved' : saveState === 'saving' ? 'Saving…' : 'Unsaved changes'}
        </span>
        <button
          className="btn ghost sm icon"
          onClick={undo}
          disabled={!historyState.canUndo}
          title="Undo (Ctrl+Z)"
          aria-label="Undo"
        >
          <Undo2 size={13} />
        </button>
        <button
          className="btn ghost sm icon"
          onClick={redo}
          disabled={!historyState.canRedo}
          title="Redo (Ctrl+Shift+Z)"
          aria-label="Redo"
        >
          <Redo2 size={13} />
        </button>
        <span style={{ flex: 1 }} />
        <span className="tiny" style={{ marginRight: 6 }}>
          <span className="kbd">J</span>/<span className="kbd">K</span>/<span className="kbd">L</span> ·{' '}
          <span className="kbd">, .</span> frame · <span className="kbd">I</span>/<span className="kbd">O</span> trim
        </span>
        <button className="btn primary" onClick={() => void queueRender(false)} disabled={renderQueued}>
          {renderQueued ? <Spinner size={12} /> : <Play size={13} />} Render clip
        </button>
      </div>

      {/* ---------------------------------------------------- stage + insp -- */}
      <div className="editor-body">
        <div className="editor-stage" ref={stageRef}>
          <div
            className="editor-frame"
            style={{ width: frame.w || undefined, height: frame.h || undefined }}
            title={`Preview frame: ${target.w}×${target.h} (${clip.aspectRatio} @ ${clip.outputResolution})`}
          >
            <video
              ref={videoRef}
              key={useProxySrc ? 'proxy' : 'source'}
              src={project.sourcePath ? mediaUrl(project.sourcePath, { proxy: useProxySrc }) : undefined}
              muted={muted}
              onError={() => {
                setVideoError(
                  playback?.verdict === 'proxy'
                    ? playback.reason
                    : playback?.verdict === 'missing'
                      ? playback.reason
                      : 'The video could not be loaded. The file may be missing, or its format is not supported for direct playback.'
                )
              }}
              onLoadedData={() => setVideoError(null)}
              style={videoStyle}
              preload="metadata"
              playsInline
            />
            {videoError && (
              <div className="playback-error">
                <div>
                  <AlertTriangle size={26} className="icon-big" />
                  <h4>Playback problem</h4>
                  <p>{videoError}</p>
                  {playback?.verdict === 'proxy' && !playback.proxyExists && (
                    <button className="btn primary sm" onClick={() => void createProxy()} disabled={proxyRunning}>
                      {proxyRunning ? <Spinner size={11} /> : <Zap size={12} />}
                      {proxyRunning ? 'Building proxy…' : 'Create preview proxy'}
                    </button>
                  )}
                  {playback?.verdict === 'proxy' && playback.proxyExists && (
                    <p style={{ marginTop: 8 }}>
                      A proxy exists — reloading the preview.
                      <br />
                      <button className="btn sm" style={{ marginTop: 6 }} onClick={() => setVideoError(null)}>
                        Retry playback
                      </button>
                    </p>
                  )}
                  {playback?.verdict === 'missing' && (
                    <div style={{ marginTop: 4 }}>
                      <button
                        className="btn primary sm"
                        onClick={() => {
                          setRelinking(true)
                          void relinkProjectSource(app, clip.projectId)
                            .then((ok) => {
                              if (ok) {
                                setVideoError(null)
                                void api['media.checkPlayback']({ projectId: clip.projectId }).then(setPlayback).catch(() => undefined)
                              }
                            })
                            .finally(() => setRelinking(false))
                        }}
                        disabled={relinking}
                      >
                        {relinking ? <Spinner size={11} /> : <Link size={12} />}
                        {relinking ? 'Relinking…' : 'Relink source file…'}
                      </button>
                      <p style={{ marginTop: 8, color: 'var(--text-3)' }}>
                        Relinking accepts only the same media file at a new location.
                      </p>
                    </div>
                  )}
                  {playback?.verdict === 'native' && (
                    <p style={{ marginTop: 8, color: 'var(--text-3)' }}>
                      Rendering and silence detection still work — only in-app preview playback is affected.
                    </p>
                  )}
                </div>
              </div>
            )}
            {clip.captionStyleId !== 'none' && (
              <CaptionPreview
                cues={cues}
                style={style}
                fontSizePct={clip.captionOverrides.fontSizePct}
                positionY={clip.captionOverrides.positionY}
                emphasis={clip.captionOverrides.emphasis}
                uppercase={clip.captionOverrides.uppercase}
                textColor={clip.captionOverrides.textColor}
                highlightColor={clip.captionOverrides.highlightColor}
                boxOpacity={clip.captionOverrides.boxOpacity}
                outlineWidth={clip.captionOverrides.outlineWidth}
                shadow={clip.captionOverrides.shadow}
                currentTime={currentTime}
                containerHeight={frame.h}
              />
            )}
            <div className="mono" style={{ position: 'absolute', top: 8, left: 10, background: 'rgba(0,0,0,0.55)', borderRadius: 3, padding: '2px 7px', pointerEvents: 'none', fontSize: 11 }}>
              {formatClock(currentTime, true)}
              {useProxySrc && <span style={{ color: 'var(--warn)' }}> · proxy</span>}
            </div>
          </div>
        </div>

        <div className="editor-inspector">
          <details className="inspector-section" open>
            <summary>
              <Scissors size={12} /> Trim <ChevronRight size={13} className="chev" />
            </summary>
            <div className="inspector-body">
              <TrimPanel
                clip={clip}
                currentTime={currentTime}
                updateClip={updateClip}
                cues={cues}
                onSeek={seekTo}
                segments={segments}
                onOptimize={async () => {
                  try {
                    if (saveTimer.current) clearTimeout(saveTimer.current)
                    if (saveState !== 'saved') await saveNow(clip as unknown as Partial<Clip>)
                    const result = await api['clips.optimizeBoundaries']({ clipId: clip.id })
                    pushHistory()
                    setClip(result.clip)
                    historyRef.current.lastPush = Date.now()
                    app.toast({
                      level: 'success',
                      message: result.adjusted
                        ? `Boundaries optimized (quality ${Math.round(result.quality.before.score * 100)}% → ${Math.round(result.quality.after.score * 100)}%).`
                        : 'Boundaries were already clean — nothing to change.',
                      hint: `${result.startReason}; ${result.endReason}`
                    })
                  } catch (err) {
                    app.toast({ level: 'error', ...errMessage(err) })
                  }
                }}
              />
            </div>
          </details>

          <details className="inspector-section" open>
            <summary>
              <Eraser size={12} /> Silence removal <ChevronRight size={13} className="chev" />
            </summary>
            <div className="inspector-body">
              <SilencePanel clip={clip} updateClip={updateClip} onCutsChanged={(c) => updateClip({ silenceCuts: c }, true)} />
            </div>
          </details>

          <details className="inspector-section" open>
            <summary>
              <Type size={12} /> Captions <ChevronRight size={13} className="chev" />
            </summary>
            <div className="inspector-body">
              <CaptionsPanel clip={clip} cues={cues} updateClip={updateClip} />
            </div>
          </details>

          <details className="inspector-section">
            <summary>
              <Crop size={12} /> Crop &amp; framing <ChevronRight size={13} className="chev" />
            </summary>
            <div className="inspector-body">
              <CropPanel clip={clip} project={project} updateClip={updateClip} />
            </div>
          </details>

          <details className="inspector-section" open>
            <summary>
              <Gauge size={12} /> Output &amp; quality <ChevronRight size={13} className="chev" />
            </summary>
            <div className="inspector-body">
              <OutputPanel
                clip={clip}
                project={project}
                outputSeconds={outputSeconds}
                updateClip={updateClip}
                onQuickPreview={() => void queueRender(true)}
                previewQueued={previewQueued}
              />
            </div>
          </details>

          <details className="inspector-section">
            <summary>
              <Tags size={12} /> Metadata <ChevronRight size={13} className="chev" />
            </summary>
            <div className="inspector-body">
              <MetadataPanel clip={clip} updateClip={updateClip} />
            </div>
          </details>
        </div>
      </div>

      {/* -------------------------------------------------- timeline + tp -- */}
      <div className="editor-bottom">
        <div className="transport">
          <button className="btn sm icon" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>
            {playing ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <button
            className="btn ghost sm icon"
            onClick={() => seekTo(clip.startTime)}
            aria-label="Return to clip start"
            title="Go to clip start (Home)"
          >
            <SkipBack size={13} />
          </button>
          <button className="btn ghost sm icon" onClick={() => setMuted(!muted)} aria-label={muted ? 'Unmute' : 'Mute'}>
            {muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
          </button>
          <span className="timecode">
            {formatClock(currentTime, true)} <span className="total">/ {formatClock(project.duration ?? 0, true)}</span>
          </span>
          {playing && videoRef.current && videoRef.current.playbackRate > 1 && (
            <span className="tl-badge preview">{videoRef.current.playbackRate}×</span>
          )}
          <span style={{ flex: 1 }} />
          <span className="tiny">
            {cues.length} caption cues{activeCue ? ` · “${activeCue.text.slice(0, 40)}${activeCue.text.length > 40 ? '…' : ''}”` : ''}
          </span>
        </div>

        <Timeline
          duration={project.duration ?? 1}
          startTime={clip.startTime}
          endTime={clip.endTime}
          currentTime={currentTime}
          onSeek={seekTo}
          onChangeRange={(start, end) => updateClip({ startTime: start, endTime: end })}
          targetRange={{ min: targetRange.min, max: targetRange.max }}
          cues={cues}
          fps={project.fps}
          silenceCuts={clip.silenceCuts}
          filmstrip={filmstrip}
          waveform={waveform}
        />
      </div>
    </div>
  )
}

// ============================================================ trim panel ===

function TrimPanel(props: {
  clip: Clip
  currentTime: number
  updateClip: (patch: Partial<Clip>, immediate?: boolean) => void
  cues: import('@shared/captions/segmentation').CaptionCue[]
  onSeek: (t: number) => void
  segments: TranscriptSegment[]
  onOptimize: () => Promise<void>
}) {
  const [optimizing, setOptimizing] = useState(false)
  const { clip, currentTime } = props
  const nudge = (field: 'startTime' | 'endTime', delta: number) => {
    if (field === 'startTime') {
      props.updateClip({ startTime: Math.min(Math.max(0, clip.startTime + delta), clip.endTime - 0.5) }, true)
    } else {
      props.updateClip({ endTime: Math.max(clip.endTime + delta, clip.startTime + 0.5) }, true)
    }
  }
  return (
    <>
      <div className="row" style={{ marginBottom: 8 }}>
        <button
          className="btn sm"
          style={{ flex: 1 }}
          disabled={optimizing}
          onClick={async () => {
            setOptimizing(true)
            try {
              await props.onOptimize()
            } finally {
              setOptimizing(false)
            }
          }}
          title="Snap the clip edges to sentence boundaries and add lead-in context where the opener needs setup"
        >
          {optimizing ? <Spinner size={11} /> : <Wand2 size={12} />} Optimize boundaries
        </button>
      </div>
      <div className="row">
        <div className="field" style={{ flex: 1 }}>
          <label className="field-label">Start (set with <span className="kbd">I</span>)</label>
          <div className="row" style={{ gap: 4 }}>
            <button className="btn sm" onClick={() => nudge('startTime', -0.5)} aria-label="Nudge start earlier">−0.5s</button>
            <input
              className="input"
              type="number"
              step="0.1"
              value={clip.startTime.toFixed(1)}
              onChange={(e) => props.updateClip({ startTime: Math.max(0, parseFloat(e.target.value) || 0) }, true)}
            />
            <button className="btn sm" onClick={() => nudge('startTime', 0.5)} aria-label="Nudge start later">+0.5s</button>
          </div>
        </div>
        <button className="btn sm" style={{ alignSelf: 'flex-end' }} onClick={() => props.updateClip({ startTime: Math.min(currentTime, clip.endTime - 0.5) }, true)}>
          Set at playhead
        </button>
      </div>

      <div className="row">
        <div className="field" style={{ flex: 1 }}>
          <label className="field-label">End (set with <span className="kbd">O</span>)</label>
          <div className="row" style={{ gap: 4 }}>
            <button className="btn sm" onClick={() => nudge('endTime', -0.5)} aria-label="Nudge end earlier">−0.5s</button>
            <input
              className="input"
              type="number"
              step="0.1"
              value={clip.endTime.toFixed(1)}
              onChange={(e) => props.updateClip({ endTime: Math.max(0.5, parseFloat(e.target.value) || 0) }, true)}
            />
            <button className="btn sm" onClick={() => nudge('endTime', 0.5)} aria-label="Nudge end later">+0.5s</button>
          </div>
        </div>
        <button className="btn sm" style={{ alignSelf: 'flex-end' }} onClick={() => props.updateClip({ endTime: Math.max(currentTime, clip.startTime + 0.5) }, true)}>
          Set at playhead
        </button>
      </div>

      <div className="divider" />
      <div className="section-title" style={{ marginBottom: 8 }}>Captions in range <span style={{ color: 'var(--text-3)', textTransform: 'none', letterSpacing: 0 }}>(click to seek)</span></div>
      <div style={{ maxHeight: 220, overflowY: 'auto' }} className="stack sm">
        {props.cues.map((cue) => (
          <button
            key={cue.key}
            className="btn ghost"
            style={{ justifyContent: 'flex-start', textAlign: 'left', fontSize: 12, padding: '4px 8px', height: 'auto' }}
            onClick={() => props.onSeek(cue.startTime + 0.05)}
            title="Seek to this caption"
          >
            <span className="mono tiny" style={{ width: 46, flexShrink: 0 }}>{formatClock(cue.startTime, true)}</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {props.clip.captionTextEdits[cue.key] ?? cue.words.map((w) => w.text).join(' ')}
            </span>
          </button>
        ))}
        {props.cues.length === 0 && <div className="tiny">No captions in this range — the transcript may not cover it.</div>}
      </div>
    </>
  )
}

// ======================================================== silence panel ===

function SilencePanel(props: {
  clip: Clip
  updateClip: (patch: Partial<Clip>, immediate?: boolean) => void
  onCutsChanged: (cuts: Array<{ start: number; end: number }>) => void
}) {
  const app = useAppStore()
  const [detecting, setDetecting] = useState<string | null>(null)
  const clip = props.clip
  const cuts = clip.silenceCuts ?? []

  async function detect(mode: 'auto' | 'aggressive') {
    setDetecting(mode)
    try {
      const result = await api['analysis.detectSilence']({ clipId: clip.id, mode })
      props.updateClip({ silenceCuts: result.cuts }, true)
      app.toast({
        level: 'success',
        message:
          result.cuts.length === 0
            ? 'No removable silence found in this clip.'
            : `Found ${result.detected.length} silent stretch${result.detected.length === 1 ? '' : 'es'} — removing ${result.savedSec.toFixed(1)}s.`,
        hint: result.cuts.length > 0 ? 'Preview playback now skips the removed ranges; the render cuts them for real.' : undefined
      })
    } catch (err) {
      app.toast({ level: 'error', ...errMessage(err) })
    } finally {
      setDetecting(null)
    }
  }

  return (
    <>
      <div className="field-hint" style={{ marginBottom: 8 }}>
        Detects silent stretches with FFmpeg and removes them from the output. The timeline shows removed
        ranges in red; preview playback skips them.
      </div>
      <div className="row" style={{ marginBottom: 8 }}>
        <button className="btn sm" style={{ flex: 1 }} disabled={detecting !== null} onClick={() => void detect('auto')}>
          {detecting === 'auto' ? <Spinner size={11} /> : <AudioLines size={12} />} Detect (standard)
        </button>
        <button className="btn sm" style={{ flex: 1 }} disabled={detecting !== null} onClick={() => void detect('aggressive')} title="Lower thresholds — removes shorter pauses too">
          {detecting === 'aggressive' ? <Spinner size={11} /> : <AudioLines size={12} />} Aggressive
        </button>
      </div>

      {cuts.length > 0 ? (
        <>
          <div className="row tiny" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
            <span>
              <strong style={{ color: 'var(--text-2)' }}>{cuts.length}</strong> cut{cuts.length === 1 ? '' : 's'} ·{' '}
              <strong style={{ color: 'var(--danger)' }}>
                −{cuts.reduce((s, c) => s + (c.end - c.start), 0).toFixed(1)}s
              </strong>{' '}
              removed
            </span>
            <button className="btn ghost sm" onClick={() => props.onCutsChanged([])}>
              <RotateCcw size={11} /> Restore all
            </button>
          </div>
          <div className="stack sm" style={{ maxHeight: 180, overflowY: 'auto' }}>
            {cuts.map((c, i) => (
              <div key={i} className="row tiny" style={{ justifyContent: 'space-between' }}>
                <span className="mono">
                  {formatClock(c.start, true)} → {formatClock(c.end, true)}
                  <span style={{ color: 'var(--text-3)' }}> ({(c.end - c.start).toFixed(1)}s)</span>
                </span>
                <button className="btn ghost sm" style={{ padding: '1px 6px' }} onClick={() => props.onCutsChanged(cuts.filter((_, j) => j !== i))}>
                  Keep
                </button>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="tiny" style={{ color: 'var(--text-3)' }}>
          No silence cuts on this clip.
        </div>
      )}
    </>
  )
}

// ======================================================== captions panel ===

const CAPTION_CATEGORIES: Array<{ id: string; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'clean', label: 'Clean' },
  { id: 'editorial', label: 'Editorial' },
  { id: 'bold', label: 'Bold' },
  { id: 'high-contrast', label: 'High contrast' },
  { id: 'highlight', label: 'Highlight' },
  { id: 'kinetic', label: 'Kinetic' },
  { id: 'minimal', label: 'Minimal' },
  { id: 'lower-third', label: 'Lower third' },
  { id: 'boxed', label: 'Boxed' },
  { id: 'center', label: 'Center' }
]

function CaptionsPanel(props: {
  clip: Clip
  cues: import('@shared/captions/segmentation').CaptionCue[]
  updateClip: (patch: Partial<Clip>, immediate?: boolean) => void
}) {
  const { clip } = props
  const [category, setCategory] = useState('all')
  const [showSafeArea, setShowSafeArea] = useState(false)
  const overrides: CaptionOverrides = clip.captionOverrides
  const style = getCaptionStyle(clip.captionStyleId)

  const visibleStyles = CAPTION_STYLES.filter((s) => category === 'all' || s.category === category)

  function setOverride(patch: CaptionOverrides) {
    props.updateClip({ captionOverrides: { ...overrides, ...patch } })
  }

  const sampleCue = props.cues[0]
  const sampleText = (sampleCue?.words.slice(0, 3).map((w) => w.text).join(' ')) || 'Your captions here'

  return (
    <>
      <div className="cap-category-tabs">
        {CAPTION_CATEGORIES.map((c) => (
          <button
            key={c.id}
            className={`cap-category-tab ${category === c.id ? 'active' : ''}`}
            onClick={() => setCategory(c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="cap-templates">
        {([
          ...visibleStyles,
          { id: 'none', label: 'Off', description: 'Render without captions' }
        ] as Array<{ id: string; label: string; description?: string }>).map((s) =>
          s.id === 'none' ? (
            <button
              key="none"
              className={`btn sm ${clip.captionStyleId === 'none' ? 'primary' : ''}`}
              style={{ flexDirection: 'column', padding: '8px 4px', height: 86, gap: 3 }}
              onClick={() => props.updateClip({ captionStyleId: 'none' })}
              title="Render without captions"
            >
              <Type size={12} />
              Off
            </button>
          ) : (
            <button
              key={s.id}
              className={`btn sm ${clip.captionStyleId === s.id ? 'primary' : ''}`}
              style={{ flexDirection: 'column', padding: '4px', height: 86, gap: 3, alignItems: 'stretch' }}
              onClick={() => props.updateClip({ captionStyleId: s.id })}
              title={s.description ?? ''}
            >
              <TemplatePreview
                style={CAPTION_STYLES.find((cs) => cs.id === s.id) as import('@shared/constants').CaptionStylePreset}
                text={sampleText}
                safeArea={showSafeArea}
                active={clip.captionStyleId === s.id}
              />
              <span style={{ fontSize: 10 }}>{s.label}</span>
            </button>
          )
        )}
      </div>
      <div className="field-hint">{style.description}</div>

      {clip.captionStyleId !== 'none' && (
        <>
          <Switch
            label="Show platform safe area"
            hint="Editor guide only — never rendered into the output."
            checked={showSafeArea}
            onChange={setShowSafeArea}
          />
          <Field label={`Size — ${Math.round(overrides.fontSizePct ?? style.fontSizePct)}% of frame height`}>
            <input
              type="range"
              min={2}
              max={8}
              step={0.1}
              value={overrides.fontSizePct ?? style.fontSizePct}
              onChange={(e) => setOverride({ fontSizePct: parseFloat(e.target.value) })}
            />
          </Field>
          <Field label={`Vertical position — ${Math.round((overrides.positionY ?? style.positionY) * 100)}%`}>
            <input
              type="range"
              min={0.1}
              max={0.92}
              step={0.01}
              value={overrides.positionY ?? style.positionY}
              onChange={(e) => setOverride({ positionY: parseFloat(e.target.value) })}
            />
          </Field>
          <Field label={`Max words per caption — ${overrides.maxWordsPerCue ?? style.maxWordsPerCue}`}>
            <input
              type="range"
              min={1}
              max={8}
              step={1}
              value={overrides.maxWordsPerCue ?? style.maxWordsPerCue}
              onChange={(e) => setOverride({ maxWordsPerCue: parseInt(e.target.value, 10) })}
            />
          </Field>
          <Switch
            label="Word emphasis highlight"
            hint="Fills each word as it is spoken (uses word timing when available)."
            checked={overrides.emphasis ?? style.emphasis}
            onChange={(v) => setOverride({ emphasis: v })}
          />
          <Switch
            label="UPPERCASE"
            checked={overrides.uppercase ?? style.uppercase}
            onChange={(v) => setOverride({ uppercase: v })}
          />

          <div className="divider" />
          <div className="section-title">Colors &amp; container</div>
          <div className="row" style={{ gap: 10 }}>
            <label className="tiny" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              Text
              <input
                type="color"
                className="color-input"
                value={overrides.textColor ?? style.textColor}
                onChange={(e) => setOverride({ textColor: e.target.value })}
              />
            </label>
            <label className="tiny" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              Highlight
              <input
                type="color"
                className="color-input"
                value={overrides.highlightColor ?? style.highlightColor}
                onChange={(e) => setOverride({ highlightColor: e.target.value })}
              />
            </label>
            {(overrides.textColor !== undefined || overrides.highlightColor !== undefined) && (
              <button
                className="btn ghost sm"
                style={{ padding: '2px 6px' }}
                onClick={() => {
                  const next = { ...overrides }
                  delete next.textColor
                  delete next.highlightColor
                  props.updateClip({ captionOverrides: next })
                }}
              >
                Reset
              </button>
            )}
          </div>
          <Field label={`Box opacity — ${Math.round((overrides.boxOpacity ?? style.boxOpacity) * 100)}%`}>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={overrides.boxOpacity ?? style.boxOpacity}
              onChange={(e) => setOverride({ boxOpacity: parseFloat(e.target.value) })}
            />
          </Field>
          <Field label={`Outline width — ${(overrides.outlineWidth ?? style.outlineWidth).toFixed(1)}`}>
            <input
              type="range"
              min={0}
              max={8}
              step={0.5}
              value={overrides.outlineWidth ?? style.outlineWidth}
              onChange={(e) => setOverride({ outlineWidth: parseFloat(e.target.value) })}
            />
          </Field>
          <Field label={`Shadow — ${(overrides.shadow ?? style.shadow).toFixed(1)}`}>
            <input
              type="range"
              min={0}
              max={8}
              step={0.5}
              value={overrides.shadow ?? style.shadow}
              onChange={(e) => setOverride({ shadow: parseFloat(e.target.value) })}
            />
          </Field>

          <div className="divider" />
          <div className="section-title">Caption cues</div>
          <div className="field-hint">
            Edit text, split or merge cues, and nudge timing. Timing shifts apply to preview and render alike.
          </div>
          <div className="stack sm" style={{ maxHeight: 280, overflowY: 'auto' }}>
            {props.cues.map((cue, idx) => {
              const next = props.cues[idx + 1]
              const split = clip.captionCueSplits?.[cue.key]
              const merged = clip.captionCueMerges?.[cue.key]
              const offset = clip.captionTimingOffsets?.[cue.key]
              const edited = clip.captionTextEdits[cue.key] !== undefined
              return (
                <div key={cue.key} className="field" style={{ marginBottom: 0 }}>
                  <div className="cue-row">
                    <label className="field-label mono" style={{ fontSize: 10, display: 'grid', gap: 2 }}>
                      {formatClock(cue.startTime, true)}
                      {offset !== undefined && <span style={{ color: 'var(--warn)' }}>{offset > 0 ? '+' : ''}{offset.toFixed(1)}s</span>}
                    </label>
                    <input
                      className="input"
                      style={{ borderColor: edited ? 'var(--accent)' : undefined }}
                      defaultValue={clip.captionTextEdits[cue.key] ?? cue.words.map((w) => w.text).join(' ')}
                      onBlur={(e) => {
                        const original = cue.words.map((w) => w.text).join(' ')
                        const value = e.target.value
                        const edits = { ...clip.captionTextEdits }
                        if (value === original) delete edits[cue.key]
                        else edits[cue.key] = value
                        props.updateClip({ captionTextEdits: edits })
                      }}
                    />
                    <div className="cue-actions">
                      <button
                        className="btn ghost sm"
                        title="Split this cue in half"
                        disabled={cue.words.length < 2 || split !== undefined}
                        onClick={() => {
                          const splits = { ...(clip.captionCueSplits ?? {}) }
                          splits[cue.key] = Math.max(1, Math.floor(cue.words.length / 2))
                          props.updateClip({ captionCueSplits: splits })
                        }}
                      >
                        <Scissors size={11} />
                      </button>
                      <button
                        className="btn ghost sm"
                        title="Merge with the next cue"
                        disabled={!next || merged}
                        onClick={() => {
                          const merges = { ...(clip.captionCueMerges ?? {}) }
                          merges[cue.key] = true
                          props.updateClip({ captionCueMerges: merges })
                        }}
                      >
                        <Copy size={11} style={{ transform: 'rotate(90deg)' }} />
                      </button>
                      <button
                        className="btn ghost sm"
                        title="Shift timing 0.1s earlier"
                        onClick={() => {
                          const offsets = { ...(clip.captionTimingOffsets ?? {}) }
                          const cur = offsets[cue.key] ?? 0
                          const nextVal = Math.round((cur - 0.1) * 10) / 10
                          if (nextVal === 0) delete offsets[cue.key]
                          else offsets[cue.key] = nextVal
                          props.updateClip({ captionTimingOffsets: offsets })
                        }}
                      >
                        −
                      </button>
                      <button
                        className="btn ghost sm"
                        title="Shift timing 0.1s later"
                        onClick={() => {
                          const offsets = { ...(clip.captionTimingOffsets ?? {}) }
                          const cur = offsets[cue.key] ?? 0
                          const nextVal = Math.round((cur + 0.1) * 10) / 10
                          if (nextVal === 0) delete offsets[cue.key]
                          else offsets[cue.key] = nextVal
                          props.updateClip({ captionTimingOffsets: offsets })
                        }}
                      >
                        +
                      </button>
                      <button
                        className="btn ghost sm"
                        title="Reset this cue (text, split, merge, timing)"
                        disabled={!edited && split === undefined && !merged && offset === undefined}
                        onClick={() => {
                          const edits = { ...clip.captionTextEdits }
                          const splits = { ...(clip.captionCueSplits ?? {}) }
                          const merges = { ...(clip.captionCueMerges ?? {}) }
                          const offsets = { ...(clip.captionTimingOffsets ?? {}) }
                          // split keys are `${key}/a` `${key}/b`
                          delete edits[cue.key]
                          delete edits[`${cue.key}/a`]
                          delete edits[`${cue.key}/b`]
                          delete splits[cue.key]
                          delete merges[cue.key]
                          delete offsets[cue.key]
                          props.updateClip({
                            captionTextEdits: edits,
                            captionCueSplits: splits,
                            captionCueMerges: merges,
                            captionTimingOffsets: offsets
                          })
                        }}
                      >
                        <RotateCcw size={11} />
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
            {props.cues.length === 0 && <div className="tiny">No cues in this clip's range.</div>}
          </div>
          {(Object.keys(clip.captionCueSplits ?? {}).length > 0 ||
            Object.keys(clip.captionCueMerges ?? {}).length > 0 ||
            Object.keys(clip.captionTimingOffsets ?? {}).length > 0) && (
            <button
              className="btn ghost sm"
              style={{ marginTop: 6 }}
              onClick={() =>
                props.updateClip({ captionCueSplits: {}, captionCueMerges: {}, captionTimingOffsets: {} })
              }
            >
              <RotateCcw size={11} /> Reset all cue structure edits
            </button>
          )}
        </>
      )}
    </>
  )
}

/** Live mini preview of a caption template (mirrors CaptionPreview styling). */
function TemplatePreview(props: {
  style: import('@shared/constants').CaptionStylePreset
  text: string
  safeArea: boolean
  active: boolean
}) {
  const s = props.style
  const fontSize = 11
  const boxOpacity = s.boxOpacity
  return (
    <div className="cap-preview" style={props.active ? { borderColor: 'var(--accent)' } : undefined}>
      {props.safeArea && <span className="safe-area" />}
      <span
        className="cap-preview-text"
        style={{
          color: s.textColor,
          fontWeight: s.fontFile.includes('900') ? 900 : s.fontFile.includes('800') ? 800 : s.fontFile.includes('700') ? 700 : s.fontFile.includes('600') ? 600 : 400,
          fontSize,
          textTransform: s.uppercase ? 'uppercase' : 'none',
          WebkitTextStroke: s.outlineWidth > 0 ? `${Math.min(1.4, s.outlineWidth / 3)}px ${s.outlineColor}` : undefined,
          paintOrder: 'stroke fill',
          textShadow: s.shadow > 0 ? `0 1px 3px rgba(0,0,0,0.8)` : undefined,
          background: boxOpacity > 0 ? `rgba(${parseInt(s.boxColor.slice(1, 3), 16)},${parseInt(s.boxColor.slice(3, 5), 16)},${parseInt(s.boxColor.slice(5, 7), 16)},${boxOpacity})` : undefined,
          padding: boxOpacity > 0 ? '2px 6px' : undefined,
          borderRadius: boxOpacity > 0 ? 3 : undefined
        }}
      >
        {s.emphasis ? (
          <>
            <span style={{ color: s.highlightColor }}>{props.text.split(' ')[0]}</span> {props.text.split(' ').slice(1).join(' ')}
          </>
        ) : (
          props.text
        )}
      </span>
    </div>
  )
}

// =========================================================== output panel ===

function OutputPanel(props: {
  clip: Clip
  project: import('@shared/types').Project
  outputSeconds: number
  updateClip: (patch: Partial<Clip>, immediate?: boolean) => void
  onQuickPreview: () => void
  previewQueued: boolean
}) {
  const { clip, project } = props
  const dims = resolutionFor(clip.aspectRatio, clip.outputResolution)
  const sourceShortSide = project.width && project.height ? Math.min(project.width, project.height) : null
  const upscaling = sourceShortSide !== null && dims.w > sourceShortSide + 2
  const estimateMb = estimateRenderSizeMb(clip.aspectRatio, clip.outputResolution, clip.outputQuality, props.outputSeconds)
  const quality = QUALITY_PRESETS.find((q) => q.id === clip.outputQuality)

  return (
    <>
      <Field label="Resolution">
        <select
          className="select"
          value={clip.outputResolution}
          onChange={(e) => props.updateClip({ outputResolution: e.target.value as Clip['outputResolution'] })}
        >
          {RESOLUTION_PRESETS.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label} — {resolutionFor(clip.aspectRatio, r.id).w}×{resolutionFor(clip.aspectRatio, r.id).h} ({r.hint})
            </option>
          ))}
        </select>
        {upscaling && (
          <div className="field-hint" style={{ color: 'var(--warn)', display: 'flex', gap: 5, alignItems: 'flex-start' }}>
            <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: 1 }} />
            The source is {sourceShortSide}px on its short side — this output would be upscaled and will not add real detail.
          </div>
        )}
      </Field>

      <Field label="Quality">
        <select
          className="select"
          value={clip.outputQuality}
          onChange={(e) => props.updateClip({ outputQuality: e.target.value as Clip['outputQuality'] })}
        >
          {QUALITY_PRESETS.map((q) => (
            <option key={q.id} value={q.id}>
              {q.label} — {q.hint}
            </option>
          ))}
        </select>
        {quality && (
          <div className="field-hint">
            {quality.id === 'draft' ? 'Fast but visible compression.' : quality.id === 'standard' ? 'Balanced delivery quality.' : quality.id === 'high' ? 'High-quality delivery.' : 'Maximum practical quality; larger files, slower renders.'}
          </div>
        )}
      </Field>

      <Field label="Frame rate">
        <select
          className="select"
          value={String(clip.outputFps)}
          onChange={(e) =>
            props.updateClip({
              outputFps: e.target.value === 'source' ? 'source' : (Number(e.target.value) as Clip['outputFps'])
            })
          }
        >
          <option value="source">Match source{project.fps ? ` (${project.fps.toFixed(2)} fps)` : ''}</option>
          <option value="24">24 fps — cinematic</option>
          <option value="25">25 fps — PAL</option>
          <option value="30">30 fps — standard</option>
          <option value="50">50 fps</option>
          <option value="60">60 fps — smooth</option>
        </select>
        <div className="field-hint">
          Output is always constant frame rate — variable-frame-rate sources are normalized automatically.
        </div>
      </Field>

      <div className="divider" />
      <div className="row tiny" style={{ justifyContent: 'space-between' }}>
        <span style={{ color: 'var(--text-3)' }}>Output</span>
        <span className="mono">
          {dims.w}×{dims.h} · {props.outputSeconds.toFixed(1)}s · ~{estimateMb} MB
        </span>
      </div>
      <div className="row tiny" style={{ justifyContent: 'space-between' }}>
        <span style={{ color: 'var(--text-3)' }}>Encoder</span>
        <span>H.264 + AAC 48 kHz</span>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn sm" style={{ flex: 1 }} onClick={() => props.updateClip({ outputResolution: '1080p', outputQuality: 'standard', outputFps: 'source' })}>
          <RotateCcw size={11} /> Reset
        </button>
        <button
          className="btn sm"
          style={{ flex: 2 }}
          disabled={props.previewQueued}
          onClick={props.onQuickPreview}
          title="Render a fast 720p draft to check the cut, captions and framing"
        >
          {props.previewQueued ? <Spinner size={11} /> : <Zap size={11} />} Quick preview render
        </button>
      </div>
    </>
  )
}

// ============================================================ crop panel ===

function CropPanel(props: {
  clip: Clip
  project: Project
  updateClip: (patch: Partial<Clip>, immediate?: boolean) => void
}) {
  const { clip, project } = props
  const app = useAppStore()
  const [analyzing, setAnalyzing] = useState(false)
  const [shotInfo, setShotInfo] = useState<string | null>(null)
  const hasBars =
    project.contentRect != null &&
    project.width != null && project.height != null &&
    (project.contentRect.width < project.width - 2 || project.contentRect.height < project.height - 2)

  async function analyzeSmartCrop() {
    setAnalyzing(true)
    setShotInfo(null)
    try {
      await api['clips.analyzeSmartCrop']({ clipId: clip.id })
      // The analysis runs as a task: poll until the keyframes land on the clip.
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 1500))
        try {
          const clips = await api['clips.list']({ projectId: clip.projectId })
          const fresh = clips.find((c) => c.id === clip.id)
          if (fresh && (fresh.smartCropKeyframes?.length ?? 0) > 0) {
            setShotInfo(`${fresh.smartCropKeyframes!.length} crop window${fresh.smartCropKeyframes!.length === 1 ? '' : 's'} — preview follows the subject per shot.`)
            app.toast({
              level: 'success',
              message: `Smart crop ready: ${fresh.smartCropKeyframes!.length} window${fresh.smartCropKeyframes!.length === 1 ? '' : 's'} across the clip.`
            })
            return
          }
          const tasks = await api['tasks.list']({ projectId: clip.projectId })
          const t = tasks.find((x) => x.type === 'smartcrop' && x.state === 'failed')
          if (t) {
            app.toast({ level: 'error', message: 'Smart crop analysis failed.', hint: typeof t.error === 'string' ? t.error : t.error?.message })
            return
          }
        } catch {
          /* keep polling */
        }
      }
      app.toast({ level: 'warn', message: 'Smart crop analysis is still running. The preview updates when it finishes.' })
    } catch (err) {
      app.toast({ level: 'error', ...errMessage(err) })
    } finally {
      setAnalyzing(false)
    }
  }

  return (
    <>
      <Field label="Crop mode">
        <select className="select" value={clip.cropMode} onChange={(e) => props.updateClip({ cropMode: e.target.value as Clip['cropMode'] })}>
          <option value="center">Center crop — safe default</option>
          <option value="top">Top-biased crop (taller sources)</option>
          <option value="bottom">Bottom-biased crop (taller sources)</option>
          <option value="manual">Manual — drag the focus point</option>
          <option value="smart">Smart — subject-aware per shot</option>
          <option value="fit">Fit — whole content, letterboxed</option>
        </select>
        <div className="field-hint">
          {clip.cropMode === 'fit'
            ? 'Shows the entire content area with letterbox padding — nothing is cropped off.'
            : clip.cropMode === 'smart'
              ? 'FFmpeg shot detection + per-shot saliency pick the highest-energy window. Analyze first; without keyframes smart falls back to a content-aware center crop.'
              : 'The preview shows exactly what the renderer produces.'}
        </div>
      </Field>

      {clip.cropMode === 'smart' && (
        <div className="stack" style={{ gap: 8, marginBottom: 4 }}>
          <button className="btn sm" onClick={() => void analyzeSmartCrop()} disabled={analyzing}>
            {analyzing ? <Spinner size={11} /> : <ScanEye size={12} />}
            {analyzing
              ? 'Analyzing shots…'
              : (clip.smartCropKeyframes?.length ?? 0) > 0
                ? `Re-analyze (${clip.smartCropKeyframes!.length} windows)`
                : 'Analyze smart crop'}
          </button>
          {(clip.smartCropKeyframes?.length ?? 0) > 0 && (
            <div className="field-hint">
              {shotInfo ?? `${clip.smartCropKeyframes!.length} crop window${clip.smartCropKeyframes!.length === 1 ? '' : 's'} stored. The preview follows the active window while you play.`}
            </div>
          )}
          {(clip.smartCropKeyframes?.length ?? 0) > 0 && (
            <button
              className="btn sm ghost"
              onClick={() => props.updateClip({ smartCropKeyframes: [] })}
              title="Clear stored crop keyframes"
            >
              Clear keyframes
            </button>
          )}
        </div>
      )}

      {hasBars && clip.cropMode !== 'fit' && (
        <div className="field-hint" style={{ borderLeft: '2px solid var(--warn)', paddingLeft: 8 }}>
          Baked-in bars detected on this source ({project.contentRect!.width}×{project.contentRect!.height} content in {project.width}×{project.height}).
          All crops exclude them automatically — exports fill the frame.
        </div>
      )}

      {clip.cropMode === 'manual' && (
        <>
          <Field label={`Focus point — ${Math.round(clip.cropX * 100)}%`}>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={clip.cropX}
              onChange={(e) => props.updateClip({ cropX: parseFloat(e.target.value) })}
            />
          </Field>
          <Field label={`Zoom — ${clip.zoom.toFixed(2)}×`}>
            <input
              type="range"
              min={1}
              max={2.5}
              step={0.05}
              value={clip.zoom}
              onChange={(e) => props.updateClip({ zoom: parseFloat(e.target.value) })}
            />
          </Field>
          <div className="field-hint">Zoom crops tighter around the focus point. Movement is intentionally not smoothed here — the render matches this preview exactly.</div>
        </>
      )}

      <div className="divider" />
      <Field label="Aspect ratio">
        <select className="select" value={clip.aspectRatio} onChange={(e) => props.updateClip({ aspectRatio: e.target.value as Clip['aspectRatio'] })}>
          {(Object.keys(ASPECT_RATIOS) as Array<keyof typeof ASPECT_RATIOS>).map((id) => (
            <option key={id} value={id}>
              {ASPECT_RATIOS[id].label} — {resolutionFor(id, clip.outputResolution).w}×{resolutionFor(id, clip.outputResolution).h}
            </option>
          ))}
        </select>
        <div className="field-hint">
          The output frame keeps this ratio at the chosen resolution; the preview mirrors the exact crop the renderer applies.
        </div>
      </Field>
    </>
  )
}

// ======================================================== metadata panel ===

function MetadataPanel(props: { clip: Clip; updateClip: (patch: Partial<Clip>, immediate?: boolean) => void }) {
  const app = useAppStore()
  const [generating, setGenerating] = useState(false)
  const { clip } = props
  const settings = app.settings
  const preset = getPlatformPreset(settings?.export.preset ?? 'generic')

  async function generate() {
    setGenerating(true)
    try {
      const updated = await api['clips.generateMetadata']({ id: clip.id })
      props.updateClip({ ...updated }, true)
      app.toast({
        level: 'success',
        message: `Metadata generated with ${updated.metadataProvider === 'heuristic-local' ? 'the local heuristic (configure an AI provider for better copy)' : updated.metadataProvider}.`,
        hint: 'Everything is editable — nothing is forced.'
      })
    } catch (err) {
      app.toast({ level: 'error', ...errMessage(err) })
    } finally {
      setGenerating(false)
    }
  }

  async function copyAll() {
    const text = [clip.title, '', clip.description, clip.cta ? `\n${clip.cta}` : '', '', clip.hashtags.join(' ')].join('\n').trim()
    const ok = await copyText(text)
    app.toast(ok ? { level: 'success', message: 'Copied title, description and hashtags.' } : { level: 'warn', message: 'Copy failed.' })
  }

  return (
    <>
      <div className="row">
        <span className="tiny">
          Target: <strong style={{ color: 'var(--text-2)' }}>{preset.label}</strong> — title ≤ {preset.maxTitleLength} chars, {preset.hashtagCount} hashtags
          {clip.metadataProvider && ` · last generated by ${clip.metadataProvider}`}
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn sm" onClick={() => void copyAll()}>
          <Copy size={12} /> Copy all
        </button>
        <button className="btn primary sm" onClick={() => void generate()} disabled={generating}>
          {generating ? <Spinner size={11} /> : <Wand2 size={12} />} Generate
        </button>
      </div>

      <Field label="Title">
        <input className="input" value={clip.title} onChange={(e) => props.updateClip({ title: e.target.value })} maxLength={200} />
      </Field>
      <Field label="Description">
        <textarea className="textarea" rows={4} value={clip.description} onChange={(e) => props.updateClip({ description: e.target.value })} maxLength={4000} />
      </Field>
      <Field label="Hashtags (space separated)">
        <input
          className="input"
          value={clip.hashtags.join(' ')}
          onChange={(e) => props.updateClip({ hashtags: e.target.value.split(/\s+/).filter(Boolean).slice(0, 20) })}
        />
      </Field>
      <Field label="Call to action">
        <input className="input" value={clip.cta} onChange={(e) => props.updateClip({ cta: e.target.value })} maxLength={200} placeholder="e.g. Follow for more breakdowns like this." />
      </Field>
      <Field label="Platform preset (affects generation targets & exports)">
        <select
          className="select"
          value={settings?.export.preset ?? 'generic'}
          onChange={(e) => void app.saveSettings({ export: { preset: e.target.value as 'tiktok' | 'reels' | 'shorts' | 'generic' } })}
        >
          {PLATFORM_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>{p.label} — {p.description}</option>
          ))}
        </select>
      </Field>
    </>
  )
}
