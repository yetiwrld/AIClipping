import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Play, Pause, Volume2, VolumeX, Scissors, Type, Crop, Tags, Save, Rocket, Sparkles, Copy } from 'lucide-react'
import { api, errMessage, mediaUrl, copyText } from '../../api/client'
import { useAppStore } from '../../stores/app'
import { useDataStore } from '../../stores/data'
import { ErrorBox, Field, Spinner, Switch } from '../../components/ui'
import { buildCues, cueAt } from '@shared/captions/segmentation'
import { computeCrop } from '@shared/video/crop'
import { CAPTION_STYLES, getCaptionStyle, getDurationRange, getPlatformPreset, PLATFORM_PRESETS } from '@shared/constants'
import type { CaptionOverrides, Clip, TranscriptSegment } from '@shared/types'
import { formatClock } from '@shared/utils/time'
import { Timeline } from './Timeline'
import { CaptionPreview } from './CaptionPreview'

type Panel = 'trim' | 'captions' | 'crop' | 'metadata'

export function EditorPage() {
  const app = useAppStore()
  const data = useDataStore()
  const clipId = app.editorClipId
  const projectId = app.projectId

  const [clip, setClip] = useState<Clip | null>(null)
  const [segments, setSegments] = useState<TranscriptSegment[]>([])
  const [error, setError] = useState<unknown>(null)
  const [panel, setPanel] = useState<Panel>('trim')
  const [currentTime, setCurrentTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty'>('saved')
  const [renderQueued, setRenderQueued] = useState(false)

  const videoRef = useRef<HTMLVideoElement>(null)
  const previewBoxRef = useRef<HTMLDivElement>(null)
  const [previewHeight, setPreviewHeight] = useState(420)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadedRef = useRef<string | null>(null)

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
      } catch (err) {
        setError(err)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipId, projectId])

  // ------------------------------------------------------------- autosave ---
  const updateClip = useCallback((patch: Partial<Clip>, immediate = false) => {
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

  // ------------------------------------------------------------- playback ---
  useEffect(() => {
    const id = setInterval(() => {
      if (videoRef.current) setCurrentTime(videoRef.current.currentTime)
    }, 120)
    return () => clearInterval(id)
  }, [])

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

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    v.addEventListener('play', onPlay)
    v.addEventListener('pause', onPause)
    return () => {
      v.removeEventListener('play', onPlay)
      v.removeEventListener('pause', onPause)
    }
  }, [clip])

  // Preview during playback: loop within the clip range
  useEffect(() => {
    const v = videoRef.current
    if (!v || !clip) return
    const onTime = () => {
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable) return
      if (!clip) return
      const v = videoRef.current
      if (e.code === 'Space') {
        e.preventDefault()
        togglePlay()
      } else if (e.key === 'i' || e.key === 'I') {
        updateClip({ startTime: Math.min(currentTime, clip.endTime - 0.5) })
      } else if (e.key === 'o' || e.key === 'O') {
        updateClip({ endTime: Math.max(currentTime, clip.startTime + 0.5) })
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        if (v) {
          v.currentTime = Math.max(0, v.currentTime - (e.shiftKey ? 5 : 1))
          setCurrentTime(v.currentTime)
        }
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        if (v) {
          v.currentTime = Math.min(clip ? data.activeProject?.duration ?? v.duration : v.duration, v.currentTime + (e.shiftKey ? 5 : 1))
          setCurrentTime(v.currentTime)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [clip, currentTime, togglePlay, updateClip, data.activeProject])

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
      fromTime: clip.startTime,
      toTime: clip.endTime
    })
  }, [segments, clip, style])

  const crop = useMemo(() => {
    if (!clip || !project?.width || !project?.height) return null
    return computeCrop(project.width, project.height, 1080, 1920, clip.cropMode, clip.cropX, clip.zoom)
  }, [clip, project])

  // Measure the preview box for caption scaling
  useEffect(() => {
    const el = previewBoxRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setPreviewHeight(entry.contentRect.height)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [clip])

  // ---------------------------------------------------------------- render ---
  async function queueRender() {
    if (!clip) return
    setRenderQueued(true)
    try {
      if (saveState !== 'saved') {
        if (saveTimer.current) clearTimeout(saveTimer.current)
        await saveNow(clip as unknown as Partial<Clip>)
      }
      await api['renders.queue']({ clipId: clip.id })
      await data.loadRenders(clip.projectId)
      app.toast({
        level: 'success',
        message: 'Render queued. Progress appears in the Render queue.',
        actionLabel: 'Open queue',
        action: () => app.navigate('queue')
      })
    } catch (err) {
      app.toast({ level: 'error', ...errMessage(err) })
    } finally {
      setRenderQueued(false)
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
        <Spinner size={22} />
      </div>
    )
  }

  const activeCue = cueAt(cues, currentTime)
  const targetRange = getDurationRange(project.settings.durationPreset)

  return (
    <div className="page" style={{ paddingBottom: 30 }}>
      <div className="page-header">
        <button className="btn ghost" onClick={() => app.openProject(project.id)} aria-label="Back to project">
          <ArrowLeft size={16} />
        </button>
        <div style={{ minWidth: 0, flex: 1 }}>
          <input
            className="input"
            style={{ fontWeight: 650, fontSize: 15, background: 'transparent', border: '1px solid transparent', padding: '4px 8px' }}
            value={clip.title}
            placeholder="Clip title"
            onChange={(e) => updateClip({ title: e.target.value })}
          />
          <div className="tiny" style={{ padding: '0 8px' }}>
            <Save size={10} style={{ verticalAlign: -1 }} /> {saveState === 'saved' ? 'All changes saved' : saveState === 'saving' ? 'Saving…' : 'Unsaved changes'}
            <span style={{ margin: '0 7px', opacity: 0.5 }}>|</span>
            shortcuts: <span className="kbd">space</span> play <span className="kbd">I</span>/<span className="kbd">O</span> trim <span className="kbd">←</span>/<span className="kbd">→</span> seek
          </div>
        </div>
        <button className="btn primary lg" onClick={() => void queueRender()} disabled={renderQueued}>
          {renderQueued ? <Spinner size={14} /> : <Rocket size={15} />} Render clip
        </button>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(300px, 460px) minmax(340px, 1fr)', alignItems: 'start', gap: 22 }}>
        {/* ------------------------------------------------------ preview -- */}
        <div className="stack">
          <div
            ref={previewBoxRef}
            style={{
              position: 'relative',
              width: '100%',
              aspectRatio: '9/16',
              maxHeight: '62vh',
              margin: '0 auto',
              borderRadius: 12,
              overflow: 'hidden',
              background: '#000',
              border: '1px solid var(--border-2)'
            }}
          >
            <video
              ref={videoRef}
              src={project.sourcePath ? mediaUrl(project.sourcePath) : undefined}
              muted={muted}
              style={
                crop
                  ? {
                      position: 'absolute',
                      width: `${(project.width! / crop.w) * 100}%`,
                      height: `${(project.height! / crop.h) * 100}%`,
                      left: `${-(crop.x / crop.w) * 100}%`,
                      top: `${-(crop.y / crop.h) * 100}%`,
                      objectFit: 'fill'
                    }
                  : { width: '100%', height: '100%' }
              }
              preload="metadata"
              playsInline
            />
            {clip.captionStyleId !== 'none' && (
              <CaptionPreview
                cues={cues}
                style={style}
                fontSizePct={clip.captionOverrides.fontSizePct}
                positionY={clip.captionOverrides.positionY}
                emphasis={clip.captionOverrides.emphasis}
                uppercase={clip.captionOverrides.uppercase}
                currentTime={currentTime}
                containerHeight={previewHeight}
              />
            )}
            <div className="tiny" style={{ position: 'absolute', top: 8, left: 10, background: 'rgba(5,7,10,0.65)', borderRadius: 6, padding: '2px 8px', pointerEvents: 'none' }}>
              {formatClock(currentTime, true)} / {formatClock(clip.endTime, true)}
            </div>
          </div>

          <div className="row" style={{ justifyContent: 'center', gap: 12 }}>
            <button className="btn" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>
              {playing ? <Pause size={16} /> : <Play size={16} />}
            </button>
            <button className="btn ghost" onClick={() => setMuted(!muted)} aria-label={muted ? 'Unmute' : 'Mute'}>
              {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
            </button>
            <button className="btn sm" onClick={() => { if (videoRef.current) { videoRef.current.currentTime = clip.startTime; setCurrentTime(clip.startTime) } }}>
              ⟲ start
            </button>
            <span className="tiny">{cues.length} caption cues</span>
          </div>

          <Timeline
            duration={project.duration ?? 1}
            startTime={clip.startTime}
            endTime={clip.endTime}
            currentTime={currentTime}
            onSeek={(t) => {
              if (videoRef.current) videoRef.current.currentTime = t
              setCurrentTime(t)
            }}
            onChangeRange={(start, end) => updateClip({ startTime: start, endTime: end })}
            targetRange={{ min: targetRange.min, max: targetRange.max }}
          />
        </div>

        {/* -------------------------------------------------------- panel -- */}
        <div className="stack">
          <div className="tabs">
            <button className={`tab ${panel === 'trim' ? 'active' : ''}`} onClick={() => setPanel('trim')}>
              <Scissors size={14} /> Trim
            </button>
            <button className={`tab ${panel === 'captions' ? 'active' : ''}`} onClick={() => setPanel('captions')}>
              <Type size={14} /> Captions
            </button>
            <button className={`tab ${panel === 'crop' ? 'active' : ''}`} onClick={() => setPanel('crop')}>
              <Crop size={14} /> Crop
            </button>
            <button className={`tab ${panel === 'metadata' ? 'active' : ''}`} onClick={() => setPanel('metadata')}>
              <Tags size={14} /> Metadata
            </button>
          </div>

          {panel === 'trim' && <TrimPanel clip={clip} currentTime={currentTime} updateClip={updateClip} cues={cues} onSeek={(t) => { if (videoRef.current) videoRef.current.currentTime = t; setCurrentTime(t) }} />}
          {panel === 'captions' && <CaptionsPanel clip={clip} cues={cues} updateClip={updateClip} />}
          {panel === 'crop' && <CropPanel clip={clip} updateClip={updateClip} />}
          {panel === 'metadata' && <MetadataPanel clip={clip} updateClip={updateClip} />}
        </div>
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
}) {
  const { clip, currentTime } = props
  const nudge = (field: 'startTime' | 'endTime', delta: number) => {
    if (field === 'startTime') {
      props.updateClip({ startTime: Math.min(Math.max(0, clip.startTime + delta), clip.endTime - 0.5) }, true)
    } else {
      props.updateClip({ endTime: Math.max(clip.endTime + delta, clip.startTime + 0.5) }, true)
    }
  }
  return (
    <div className="card stack">
      <div className="row">
        <div className="field" style={{ flex: 1 }}>
          <label className="field-label">Start (set with <span className="kbd">I</span>)</label>
          <div className="row">
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
          Set start at playhead
        </button>
      </div>

      <div className="row">
        <div className="field" style={{ flex: 1 }}>
          <label className="field-label">End (set with <span className="kbd">O</span>)</label>
          <div className="row">
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
          Set end at playhead
        </button>
      </div>

      <div className="divider" />
      <div className="card-title" style={{ marginBottom: 8 }}>Captions in range (click to seek & edit)</div>
      <div style={{ maxHeight: 240, overflowY: 'auto' }} className="stack sm">
        {props.cues.map((cue) => (
          <button
            key={cue.key}
            className="btn ghost"
            style={{ justifyContent: 'flex-start', textAlign: 'left', fontSize: 12.5, padding: '5px 8px' }}
            onClick={() => props.onSeek(cue.startTime + 0.05)}
            title="Seek to this caption"
          >
            <span className="mono tiny" style={{ width: 46, flexShrink: 0 }}>{formatClock(cue.startTime, true)}</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {clip.captionTextEdits[cue.key] ?? cue.words.map((w) => w.text).join(' ')}
            </span>
          </button>
        ))}
        {props.cues.length === 0 && <div className="tiny">No captions in this range — the transcript may not cover it.</div>}
      </div>
    </div>
  )
}

// ======================================================== captions panel ===

function CaptionsPanel(props: {
  clip: Clip
  cues: import('@shared/captions/segmentation').CaptionCue[]
  updateClip: (patch: Partial<Clip>, immediate?: boolean) => void
}) {
  const { clip } = props
  const overrides: CaptionOverrides = clip.captionOverrides
  const style = getCaptionStyle(clip.captionStyleId)

  function setOverride(patch: CaptionOverrides) {
    props.updateClip({ captionOverrides: { ...overrides, ...patch } })
  }

  return (
    <div className="card stack">
      <div className="card-title">Caption style</div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: 8 }}>
        {[...CAPTION_STYLES, { id: 'none', label: 'Off' } as { id: string; label: string }].map((s) => (
          <button
            key={s.id}
            className={`btn sm ${clip.captionStyleId === s.id ? 'primary' : ''}`}
            style={{ flexDirection: 'column', padding: '10px 4px', height: 62 }}
            onClick={() => props.updateClip({ captionStyleId: s.id })}
            title={s.id === 'none' ? 'Render without captions' : getCaptionStyle(s.id).description}
          >
            <Type size={13} style={{ marginBottom: 4 }} />
            {s.label}
          </button>
        ))}
      </div>
      <div className="field-hint" style={{ marginTop: -4 }}>{style.description}</div>

      {clip.captionStyleId !== 'none' && (
        <>
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
          <div className="card-title">Caption text</div>
          <div className="field-hint" style={{ marginTop: -6, marginBottom: 6 }}>
            Fix transcription errors per caption. Edits apply to preview and render; timing is unaffected.
          </div>
          <div className="stack sm" style={{ maxHeight: 260, overflowY: 'auto' }}>
            {props.cues.slice(0, 40).map((cue) => (
              <div key={cue.key} className="field">
                <label className="field-label mono" style={{ fontSize: 10.5 }}>{formatClock(cue.startTime, true)}</label>
                <input
                  className="input"
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
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ============================================================ crop panel ===

function CropPanel(props: { clip: Clip; updateClip: (patch: Partial<Clip>, immediate?: boolean) => void }) {
  const { clip } = props
  return (
    <div className="card stack">
      <div className="card-title">Reframe — 9:16 vertical</div>
      <div className="field">
        <label className="field-label">Crop mode</label>
        <select className="select" value={clip.cropMode} onChange={(e) => props.updateClip({ cropMode: e.target.value as Clip['cropMode'] })}>
          <option value="center">Center crop — safe default</option>
          <option value="top">Top-biased crop (taller sources)</option>
          <option value="bottom">Bottom-biased crop (taller sources)</option>
          <option value="manual">Manual — drag the focus point</option>
        </select>
        <div className="field-hint">
          Face-aware and speaker-tracking crops are planned but not yet available — the preview shows exactly what the renderer
          produces, so you can frame the subject manually.
        </div>
      </div>

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
          <option value="9:16">9:16 · 1080×1920 (recommended)</option>
          <option value="4:5">4:5 · 1080×1350</option>
          <option value="1:1">1:1 · 1080×1080</option>
          <option value="16:9">16:9 · 1920×1080 (keep horizontal)</option>
        </select>
      </Field>
    </div>
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
    <div className="card stack">
      <div className="row">
        <div className="card-title" style={{ marginBottom: 0 }}>Description & packaging</div>
        <span style={{ flex: 1 }} />
        <button className="btn sm" onClick={() => void copyAll()}>
          <Copy size={13} /> Copy all
        </button>
        <button className="btn primary sm" onClick={() => void generate()} disabled={generating}>
          {generating ? <Spinner size={12} /> : <Sparkles size={13} />} Generate
        </button>
      </div>
      <div className="field-hint">
        Target preset: <strong>{preset.label}</strong> — title ≤ {preset.maxTitleLength} chars, {preset.hashtagCount} hashtags.
        {clip.metadataProvider && ` Last generated by ${clip.metadataProvider}.`}
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
    </div>
  )
}
