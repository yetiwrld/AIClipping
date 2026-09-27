import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Film, Link2, HardDrive, FolderOpen, Trash2, AlertTriangle, Zap, Play, Pause, Volume2, VolumeX, RotateCcw, RotateCw, RefreshCw } from 'lucide-react'
import { api, errMessage, isElectron, mediaUrl } from '../../api/client'
import { pickUpload } from '../../api/upload'
import { useAppStore } from '../../stores/app'
import { useDataStore } from '../../stores/data'
import { Field, formatBytes, Modal, ProgressBar, Spinner } from '../../components/ui'
import { DURATION_RANGES } from '@shared/constants'
import { formatClock } from '@shared/utils/time'
import { relinkProjectSource } from './relink'

/**
 * Source tab (§1-14): the project's media must PLAY here, not just in the
 * editor. Aspect-correct player with real controls, playback-compatibility
 * verdict, FFmpeg proxy workflow, missing-source relink, and honest
 * error states — never a dead black box or an infinite spinner (§76).
 */

type PlaybackStatus = Awaited<ReturnType<typeof api['media.checkPlayback']>> | null

/** Position/volume memory so returning to the tab resumes where you left (§5). */
const playerMemory = new Map<string, { time: number; volume: number; muted: boolean }>()

export function SourceTab() {
  const app = useAppStore()
  const data = useDataStore()
  const project = data.activeProject!
  const [url, setUrl] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  // ---- player state ----
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(project.duration ?? 0)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [rate, setRate] = useState(1)
  const [videoError, setVideoError] = useState<string | null>(null)
  const [playback, setPlayback] = useState<PlaybackStatus>(null)
  const [proxyRunning, setProxyRunning] = useState(false)
  const [relinking, setRelinking] = useState(false)
  const [recheck, setRecheck] = useState(0)

  const importTask = data.tasks.find((t) => t.type === 'download' && t.projectId === project.id && (t.state === 'running' || t.state === 'queued'))
  const importing = project.status === 'importing' || Boolean(importTask)
  const hasMedia = Boolean(project.sourcePath) && project.status !== 'importing' && project.status !== 'created'

  // Playback compatibility + source existence (§4-7, §13-14).
  useEffect(() => {
    if (!hasMedia) return
    void api['media.checkPlayback']({ projectId: project.id })
      .then(setPlayback)
      .catch(() => setPlayback(null))
  }, [project.id, hasMedia, recheck, project.sourcePath, project.status])

  const verdict = playback?.verdict ?? null
  const useProxySrc = verdict === 'proxy' && Boolean(playback?.proxyExists)
  const sourceMissing = verdict === 'missing'

  // Restore remembered position when the media element mounts/changes.
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const mem = playerMemory.get(project.id)
    if (mem) {
      v.volume = mem.volume
      v.muted = mem.muted
      setVolume(mem.volume)
      setMuted(mem.muted)
      const apply = () => {
        if (Number.isFinite(mem.time) && mem.time > 0.5 && mem.time < (v.duration || Infinity) - 0.5) {
          v.currentTime = mem.time
          setCurrent(mem.time)
        }
      }
      if (v.readyState >= 1) apply()
      else v.addEventListener('loadedmetadata', apply, { once: true })
    }
    const onTime = () => setCurrent(v.currentTime)
    const onDur = () => setDuration(v.duration || project.duration || 0)
    const onPlay = () => setPlaying(true)
    const onPause = () => {
      setPlaying(false)
      playerMemory.set(project.id, { time: v.currentTime, volume: v.volume, muted: v.muted })
    }
    v.addEventListener('timeupdate', onTime)
    v.addEventListener('durationchange', onDur)
    v.addEventListener('play', onPlay)
    v.addEventListener('pause', onPause)
    return () => {
      playerMemory.set(project.id, { time: v.currentTime, volume: v.volume, muted: v.muted })
      v.removeEventListener('timeupdate', onTime)
      v.removeEventListener('durationchange', onDur)
      v.removeEventListener('play', onPlay)
      v.removeEventListener('pause', onPause)
    }
  }, [project.id, project.duration, useProxySrc, hasMedia])

  const togglePlay = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) void v.play().catch(() => setVideoError('Playback was blocked. Press play again.'))
    else v.pause()
  }, [])

  const seekBy = useCallback((delta: number) => {
    const v = videoRef.current
    if (!v) return
    v.currentTime = Math.max(0, Math.min((v.duration || project.duration || 0) - 0.05, v.currentTime + delta))
    setCurrent(v.currentTime)
  }, [project.duration])

  const onScrub = (t: number) => {
    const v = videoRef.current
    if (!v) return
    v.currentTime = t
    setCurrent(t)
  }

  // ---------------------------------------------------------- proxy/relink ---
  async function createProxy() {
    setProxyRunning(true)
    try {
      await api['media.renderProxy']({ projectId: project.id })
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 3000))
        try {
          const status = await api['media.checkPlayback']({ projectId: project.id })
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

  async function relink() {
    setRelinking(true)
    try {
      const ok = await relinkProjectSource(app, project.id)
      if (ok) {
        setVideoError(null)
        setRecheck((n) => n + 1)
      }
    } finally {
      setRelinking(false)
    }
  }

  // ------------------------------------------------------------- importing ---
  async function importFile() {
    try {
      if (isElectron) {
        const picked = await api['media.pickSourceFile']()
        if (!picked.filePath) return
        await api['media.importFile']({ projectId: project.id, filePath: picked.filePath })
      } else {
        const uploaded = await pickUpload(['video/*', 'audio/*', '.mkv', '.webm'])
        if (!uploaded) return
        await api['media.importFile']({ projectId: project.id, filePath: uploaded })
      }
      await data.loadProject(project.id)
      await data.refreshProjects()
      setRecheck((n) => n + 1)
    } catch (err) {
      app.toast({ level: 'error', ...errMessage(err) })
      await data.loadProject(project.id)
    }
  }

  async function importUrl() {
    if (!url.trim()) return
    try {
      await api['media.importUrl']({ projectId: project.id, url: url.trim() })
      await data.loadProject(project.id)
    } catch (err) {
      app.toast({ level: 'error', ...errMessage(err) })
      await data.loadProject(project.id)
    }
  }

  async function deleteProject() {
    try {
      await api['projects.delete']({ id: project.id, confirm: true })
      await data.refreshProjects()
      app.navigate('dashboard')
      app.toast({ level: 'info', message: `Project “${project.name}” deleted.` })
    } catch (err) {
      app.toast({ level: 'error', ...errMessage(err) })
    }
  }

  // Aspect-correct player box: use the REAL source geometry, not a fixed 16:9.
  const aspect = project.width && project.height ? `${project.width} / ${project.height}` : '16 / 9'

  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.7fr) minmax(280px, 1fr)', alignItems: 'start' }}>
      <div className="stack">
        <div className="panel flush source-player-panel">
          {hasMedia && !sourceMissing ? (
            <>
              {verdict === 'audio-only' ? (
                <div style={{ aspectRatio: aspect, maxHeight: 420, display: 'grid', placeItems: 'center', background: 'var(--bg-2)' }}>
                  <div className="empty" style={{ padding: 30 }}>
                    <Volume2 size={36} className="empty-icon" />
                    <div style={{ fontWeight: 600 }}>Audio-only source</div>
                    <div className="muted" style={{ fontSize: 13 }}>This file has no video track — it plays as audio.</div>
                  </div>
                </div>
              ) : (
                <video
                  ref={videoRef}
                  key={`${project.sourcePath}-${useProxySrc ? 'proxy' : 'source'}`}
                  src={mediaUrl(project.sourcePath!, { proxy: useProxySrc })}
                  muted={muted}
                  onError={() => {
                    setVideoError(
                      verdict === 'proxy'
                        ? playback?.reason ?? 'This file needs a preview proxy before it can play.'
                        : 'The video could not be loaded. The file may be missing, or its format is not supported for direct playback.'
                    )
                  }}
                  onLoadedData={() => setVideoError(null)}
                  style={{ width: '100%', aspectRatio: aspect, maxHeight: 480, background: '#000', display: 'block', objectFit: 'contain' }}
                  preload="metadata"
                  playsInline
                />
              )}
              {/* playback problem overlay — actionable, never a dead box */}
              {videoError && (
                <div className="playback-error" style={{ aspectRatio: aspect, maxHeight: 480 }}>
                  <div>
                    <AlertTriangle size={26} className="icon-big" />
                    <h4>Playback problem</h4>
                    <p>{videoError}</p>
                    {verdict === 'proxy' && !playback?.proxyExists && (
                      <button className="btn primary sm" onClick={() => void createProxy()} disabled={proxyRunning}>
                        {proxyRunning ? <Spinner size={11} /> : <Zap size={12} />}
                        {proxyRunning ? 'Building proxy…' : 'Create preview proxy'}
                      </button>
                    )}
                    {verdict === 'native' && (
                      <p style={{ marginTop: 8, color: 'var(--text-3)' }}>
                        Transcription, analysis and rendering still work — only in-app preview playback is affected.
                      </p>
                    )}
                  </div>
                </div>
              )}
              {verdict === 'proxy' && !videoError && !useProxySrc && (
                <div className="source-note warn">
                  <Zap size={13} />
                  <span>{playback?.reason} Preview needs a transcoded proxy — rendering always uses the original.</span>
                  <button className="btn sm" onClick={() => void createProxy()} disabled={proxyRunning}>
                    {proxyRunning ? <Spinner size={11} /> : <Zap size={12} />}
                    {proxyRunning ? 'Building…' : 'Build proxy'}
                  </button>
                </div>
              )}
              {useProxySrc && (
                <div className="source-note">
                  <Zap size={13} />
                  <span>Playing the 720p preview proxy. Renders use the original file at full quality.</span>
                </div>
              )}
              {/* real controls (§76: no dead controls) */}
              <div className="source-controls">
                <button className="ctl" onClick={togglePlay} title={playing ? 'Pause (space)' : 'Play (space)'}>
                  {playing ? <Pause size={15} /> : <Play size={15} />}
                </button>
                <button className="ctl" onClick={() => seekBy(-10)} title="Back 10s"><RotateCcw size={14} /></button>
                <button className="ctl" onClick={() => seekBy(10)} title="Forward 10s"><RotateCw size={14} /></button>
                <span className="mono tiny" style={{ minWidth: 86, textAlign: 'center' }}>
                  {formatClock(current, true)} <span className="muted">/ {formatClock(duration || project.duration || 0, true)}</span>
                </span>
                <input
                  className="scrub"
                  type="range"
                  min={0}
                  max={Math.max(0.1, duration || project.duration || 0)}
                  step={0.05}
                  value={Math.min(current, duration || project.duration || 0)}
                  onChange={(e) => onScrub(parseFloat(e.target.value))}
                  style={{ flex: 1 }}
                />
                <button className="ctl" onClick={() => { const v = videoRef.current; if (v) { v.muted = !v.muted; setMuted(v.muted) } }} title={muted ? 'Unmute' : 'Mute'}>
                  {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
                </button>
                <select
                  className="select tiny"
                  value={String(rate)}
                  onChange={(e) => { const r = parseFloat(e.target.value); setRate(r); if (videoRef.current) videoRef.current.playbackRate = r }}
                  title="Playback speed"
                  style={{ width: 62 }}
                >
                  {[0.5, 1, 1.5, 2].map((r) => <option key={r} value={r}>{r}×</option>)}
                </select>
              </div>
            </>
          ) : sourceMissing ? (
            <div style={{ aspectRatio: aspect, maxHeight: 480, display: 'grid', placeItems: 'center', background: 'var(--bg-2)' }}>
              <div className="empty" style={{ padding: 34, maxWidth: 420 }}>
                <AlertTriangle size={36} className="empty-icon" style={{ color: 'var(--warn)' }} />
                <div style={{ fontWeight: 600 }}>Source file missing</div>
                <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
                  {playback?.reason}
                </div>
                <div className="row" style={{ marginTop: 12, gap: 8 }}>
                  <button className="btn primary sm" onClick={() => void relink()} disabled={relinking}>
                    {relinking ? <Spinner size={11} /> : <Link2 size={12} />}
                    {relinking ? 'Relinking…' : 'Relink source file…'}
                  </button>
                  <button className="btn sm" onClick={() => setRecheck((n) => n + 1)} title="Check again">
                    <RefreshCw size={12} />
                  </button>
                </div>
                <div className="field-hint" style={{ marginTop: 10 }}>
                  Relinking accepts only the same media file at a new location. Everything else in the project is kept.
                </div>
              </div>
            </div>
          ) : (
            <div style={{ aspectRatio: aspect, maxHeight: 420, display: 'grid', placeItems: 'center', background: 'var(--bg-2)' }}>
              {importing ? (
                <div style={{ width: '70%' }}>
                  <div className="muted" style={{ textAlign: 'center', marginBottom: 10, fontSize: 13 }}>
                    {importTask?.message ?? 'Importing media…'}
                  </div>
                  {importTask?.progress != null && <ProgressBar value={importTask.progress} />}
                </div>
              ) : (
                <div className="empty" style={{ padding: 30 }}>
                  <Film size={36} className="empty-icon" />
                  <div className="muted" style={{ fontSize: 13 }}>No media imported yet</div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="panel">
          <div className="section-title">Import media</div>
          <div className="row wrap">
            <button className="btn" onClick={() => void importFile()} disabled={importing}>
              <Film size={15} /> From file…
            </button>
            <span className="tiny">MP4 · MOV · MKV · WebM · AVI · common audio</span>
          </div>
          <div className="divider" />
          <div className="row wrap">
            <Link2 size={15} className="muted" />
            <input
              className="input"
              style={{ flex: 1, minWidth: 200 }}
              placeholder="Direct media URL you are authorized to download"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void importUrl()}
            />
            <button className="btn" onClick={() => void importUrl()} disabled={importing || !url.trim()}>
              Download
            </button>
          </div>
        </div>
      </div>

      <div className="stack" style={{ gap: 0 }}>
        <div className="section">
          <div className="section-title">Source information</div>
          {project.status === 'created' ? (
            <div className="muted" style={{ fontSize: 13 }}>Import media to see duration, resolution, codecs and audio status.</div>
          ) : (
            <table className="table">
              <tbody>
                <MetaRow k="File" v={project.sourceFilename ?? '—'} />
                <MetaRow k="Duration" v={project.duration != null ? formatDuration(project.duration) : '—'} />
                <MetaRow k="Resolution" v={project.width && project.height ? `${project.width} × ${project.height}` : '—'} />
                <MetaRow k="Frame rate" v={project.fps != null ? `${project.fps} fps` : '—'} />
                <MetaRow k="Video codec" v={project.videoCodec ?? '—'} />
                <MetaRow k="Audio" v={project.hasAudio ? `${project.audioCodec ?? 'yes'}` : 'No audio track'} warn={!project.hasAudio} />
                <MetaRow
                  k="Content area"
                  v={
                    project.contentRect
                      ? `${project.contentRect.width} × ${project.contentRect.height} at ${project.contentRect.left},${project.contentRect.top}`
                      : 'Full frame (no bars detected)'
                  }
                  warn={Boolean(
                    project.contentRect &&
                    project.width && project.height &&
                    (project.contentRect.width < project.width - 2 || project.contentRect.height < project.height - 2)
                  )}
                />
                <MetaRow k="Size" v={project.sizeBytes ? formatBytes(project.sizeBytes) : '—'} />
                <MetaRow k="Imported via" v={project.sourceType === 'url' ? 'URL download' : 'Local file'} />
              </tbody>
            </table>
          )}
          {project.contentRect && project.width && project.height && (project.contentRect.width < project.width - 2 || project.contentRect.height < project.height - 2) && (
            <div className="field-hint" style={{ marginTop: 8 }}>
              Baked-in letterbox/pillarbox bars were detected — crops and smart-crop analyze inside the real content area, so exports fill the frame without bars.
            </div>
          )}
        </div>

        <div className="section">
          <div className="section-title">Discovery settings</div>
          <Field label="Target clip duration" hint="Applied when analyzing. Candidates outside the window (±35%) are rejected.">
            <select
              className="select"
              value={project.settings.durationPreset}
              onChange={(e) => void updateProjectSettings(e.target.value as 'short' | 'medium' | 'long' | 'mixed')}
            >
              {DURATION_RANGES.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </Field>
          <div style={{ marginTop: 10 }}>
            <Field label="Max candidates" hint="How many moments the analyzer may propose.">
              <input
                className="input"
                type="number"
                min={1}
                max={40}
                value={project.settings.maxCandidates}
                onChange={(e) => void updateProjectSettings(undefined, parseInt(e.target.value, 10))}
              />
            </Field>
          </div>
        </div>

        {data.storage && (
          <div className="section">
            <div className="section-title">
              <span className="row">
                <HardDrive size={13} /> Project storage
              </span>
            </div>
            <table className="table">
              <tbody>
                <MetaRow k="Source media" v={formatBytes(data.storage.source)} />
                <MetaRow k="Renders" v={formatBytes(data.storage.renders)} />
                <MetaRow k="Thumbnails" v={formatBytes(data.storage.thumbnails)} />
                <MetaRow k="Cache" v={formatBytes(data.storage.cache)} />
              </tbody>
            </table>
            {project.sourcePath && (
              <button
                className="btn sm"
                style={{ marginTop: 10 }}
                onClick={() => void api['system.revealPath']({ path: data.activeProject!.sourcePath! }).catch((e) => app.toast({ level: 'warn', ...errMessage(e) }))}
              >
                <FolderOpen size={13} /> Reveal source file
              </button>
            )}
          </div>
        )}

        <div className="section">
          <button className="btn danger sm" onClick={() => setConfirmDelete(true)}>
            <Trash2 size={13} /> Delete project…
          </button>
        </div>
      </div>

      {confirmDelete && (
        <Modal
          title="Delete project?"
          onClose={() => setConfirmDelete(false)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
              <button className="btn danger" onClick={() => void deleteProject()}>
                <Trash2 size={14} /> Delete permanently
              </button>
            </>
          }
        >
          <div style={{ fontSize: 13.5, lineHeight: 1.6 }}>
            <strong>“{project.name}”</strong> and all of its imported media, transcripts, clips and renders will be removed from
            the workspace. Files already exported to the exports folder are kept.
          </div>
          <div className="field-hint">This cannot be undone.</div>
        </Modal>
      )}
    </div>
  )

  async function updateProjectSettings(durationPreset?: 'short' | 'medium' | 'long' | 'mixed', maxCandidates?: number) {
    try {
      const updated = await api['projects.updateSettings']({
        id: project.id,
        settings: { durationPreset, maxCandidates }
      })
      useDataStore.setState((s) => ({ activeProject: updated }))
    } catch (err) {
      app.toast({ level: 'error', ...errMessage(err) })
    }
  }
}

function MetaRow({ k, v, warn }: { k: string; v: string; warn?: boolean }) {
  return (
    <tr>
      <td style={{ color: 'var(--text-3)', width: '42%' }}>{k}</td>
      <td style={{ wordBreak: 'break-all', color: warn ? 'var(--warn)' : undefined }}>{v}</td>
    </tr>
  )
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  if (m >= 60) {
    const h = Math.floor(m / 60)
    return `${h}h ${m % 60}m`
  }
  return `${m}m ${s}s`
}
