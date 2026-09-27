import React, { useEffect, useMemo, useRef, useState } from 'react'
import { FileText, Upload, Cpu, Cloud, Search, Copy, Play } from 'lucide-react'
import { api, errMessage, isElectron, copyText, mediaUrl } from '../../api/client'
import { pickUpload } from '../../api/upload'
import { useAppStore } from '../../stores/app'
import { useDataStore } from '../../stores/data'
import { ErrorBox, Spinner } from '../../components/ui'
import { formatClock } from '@shared/utils/time'

/**
 * Synchronized transcript viewer (spec §13): timestamps, click-to-seek,
 * follow-playback highlighting, search, copy.
 */
export function TranscriptTab() {
  const app = useAppStore()
  const data = useDataStore()
  const project = data.activeProject!
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [follow, setFollow] = useState(true)
  const [currentTime, setCurrentTime] = useState(0)
  const videoRef = useRef<HTMLVideoElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const activeRowRef = useRef<HTMLDivElement>(null)

  const transcribeTask = data.tasks.find(
    (t) => t.type === 'transcribe' && t.projectId === project.id && (t.state === 'running' || t.state === 'queued')
  )
  const transcribing = project.status === 'transcribing' || Boolean(transcribeTask)

  const providers = app.dependencies.filter((d) => d.id === 'faster-whisper-local' || d.id === 'openai-compatible')
  const localAvailable = providers.find((p) => p.id === 'faster-whisper-local')?.available ?? false
  const cloudAvailable = providers.find((p) => p.id === 'openai-compatible')?.available ?? false

  // keep currentTime fresh but re-render friendly (~4x/s)
  useEffect(() => {
    const id = setInterval(() => {
      if (videoRef.current) setCurrentTime(videoRef.current.currentTime)
    }, 250)
    return () => clearInterval(id)
  }, [])

  // follow-playback auto-scroll
  useEffect(() => {
    if (!follow || !activeRowRef.current || !listRef.current) return
    const row = activeRowRef.current
    const list = listRef.current
    const rowTop = row.offsetTop - list.offsetTop
    if (rowTop < list.scrollTop + 40 || rowTop > list.scrollTop + list.clientHeight - 80) {
      list.scrollTo({ top: Math.max(0, rowTop - list.clientHeight / 2.6), behavior: 'smooth' })
    }
  }, [currentTime, follow])

  async function transcribe(providerId: 'faster-whisper-local' | 'openai-compatible') {
    setError(null)
    setBusy(true)
    try {
      await api['transcript.start']({ projectId: project.id, providerId })
      app.toast({
        level: 'info',
        message:
          providerId === 'faster-whisper-local'
            ? 'Local transcription started — it runs fully offline on this machine.'
            : 'Cloud transcription started — the extracted audio track is being sent to your configured endpoint.'
      })
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  async function importTranscript() {
    setError(null)
    try {
      let filePath: string | null = null
      if (isElectron) {
        const picked = await api['media.pickTranscriptFile']()
        filePath = picked.filePath
      } else {
        filePath = await pickUpload(['.srt', '.vtt', '.json', '.txt'])
      }
      if (!filePath) return
      const result = await api['transcript.import']({ projectId: project.id, filePath })
      await data.loadTranscript(project.id)
      await data.loadProject(project.id)
      app.toast({ level: 'success', message: `Imported ${result.segments} transcript segments.` })
    } catch (err) {
      setError(err)
    }
  }

  const filtered = useMemo(() => {
    if (!query.trim()) return data.transcript
    const q = query.toLowerCase()
    return data.transcript.filter((s) => s.text.toLowerCase().includes(q))
  }, [data.transcript, query])

  const activeSegmentId = useMemo(() => {
    for (const seg of data.transcript) {
      if (currentTime >= seg.startTime && currentTime <= seg.endTime) return seg.id
    }
    return null
  }, [currentTime, data.transcript])

  async function copyAll() {
    const text = data.transcript.map((s) => `[${formatClock(s.startTime)}] ${s.text}`).join('\n')
    const ok = await copyText(text)
    app.toast(ok ? { level: 'success', message: 'Transcript copied to clipboard.' } : { level: 'warn', message: 'Copy failed.' })
  }

  return (
    <div className="stack">
      <div className="toolbar" style={{ borderBottom: 'none', paddingBottom: 0, marginBottom: 10 }}>
        <div className="row wrap">
          <div className="row" style={{ flex: 1, minWidth: 200 }}>
            <Search size={14} className="muted" />
            <input
              className="input"
              placeholder="Search transcript…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              disabled={data.transcript.length === 0}
            />
          </div>
          <button className="btn" onClick={() => void transcribe('faster-whisper-local')} disabled={transcribing || busy || !localAvailable}
            title={localAvailable ? 'Run local Whisper — fully offline' : 'faster-whisper is not installed on this machine'}>
            <Cpu size={14} /> {transcribing ? 'Transcribing…' : 'Transcribe locally'}
          </button>
          <button className="btn" onClick={() => void transcribe('openai-compatible')} disabled={transcribing || busy || !cloudAvailable}
            title={cloudAvailable ? 'Send the audio track to your configured endpoint' : 'Configure an audio-capable provider in Settings → AI'}>
            <Cloud size={14} /> Via cloud
          </button>
          <button className="btn" onClick={() => void importTranscript()} disabled={transcribing || busy}>
            <Upload size={14} /> Import file…
          </button>
          <button className="btn ghost" onClick={() => void copyAll()} disabled={data.transcript.length === 0} title="Copy full transcript">
            <Copy size={14} />
          </button>
        </div>
        {transcribing && transcribeTask && (
          <div className="row" style={{ marginTop: 10 }}>
            <Spinner />
            <span className="muted" style={{ fontSize: 12.5 }}>
              {transcribeTask.message ?? 'Working…'} {transcribeTask.progress != null && `· ${Math.round(transcribeTask.progress * 100)}%`}
            </span>
          </div>
        )}
        {!localAvailable && !transcribing && (
          <div className="tiny" style={{ marginTop: 8 }}>
            Local Whisper unavailable here — install with <span className="kbd">pip install faster-whisper</span>, or import an
            existing SRT/VTT/JSON transcript.
          </div>
        )}
      </div>

      {error ? <ErrorBox error={error} onRetry={() => setError(null)} retryLabel="Dismiss" /> : null}

      {data.transcript.length === 0 && !transcribing ? (
        <div className="empty" style={{ padding: '72px 20px' }}>
          <FileText size={28} className="empty-icon" />
          <div style={{ fontWeight: 600, fontSize: 13.5 }}>{project.hasAudio ? 'No transcript yet' : 'This video has no audio track'}</div>
          <div className="muted" style={{ maxWidth: 420, fontSize: 12.5, lineHeight: 1.55 }}>
            {project.hasAudio
              ? 'Transcribe the video (locally with Whisper, or via your cloud provider), or import an existing SRT/VTT/JSON transcript. Moment discovery, captions and editing all work from this transcript.'
              : 'Speech transcription needs audio. You can still import an existing transcript file to continue the workflow.'}
          </div>
        </div>
      ) : (
        <div className="grid" style={{ gridTemplateColumns: 'minmax(260px, 380px) minmax(0, 1fr)', alignItems: 'start' }}>
          <div className="panel" style={{ padding: 10, position: 'sticky', top: 0 }}>
            <video
              ref={videoRef}
              src={project.sourcePath ? mediaUrl(project.sourcePath) : undefined}
              controls
              style={{ width: '100%', borderRadius: 8, background: '#000', aspectRatio: '16/9' }}
              preload="metadata"
            />
            <div className="row" style={{ justifyContent: 'space-between', marginTop: 8, padding: '0 2px' }}>
              <span className="tiny">{formatClock(currentTime)}</span>
              <label className="row tiny" style={{ gap: 6, cursor: 'pointer', userSelect: 'none' }}>
                <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow playback
              </label>
            </div>
          </div>

          <div className="panel" ref={listRef} style={{ maxHeight: '64vh', overflowY: 'auto', padding: '10px 6px' }}>
            <div className="transcript-list">
              {filtered.map((seg) => (
                <TranscriptRow
                  key={seg.id}
                  segment={seg}
                  query={query}
                  active={seg.id === activeSegmentId}
                  rowRef={seg.id === activeSegmentId ? activeRowRef : undefined}
                  onSeek={(t) => {
                    if (videoRef.current) {
                      videoRef.current.currentTime = t
                      void videoRef.current.play()
                    }
                  }}
                />
              ))}
              {filtered.length === 0 && (
                <div className="muted" style={{ padding: 20, textAlign: 'center' }}>No matches for “{query}”.</div>
              )}
            </div>
            {filtered.length > 0 && (
              <div className="row" style={{ justifyContent: 'center', paddingTop: 8 }}>
                <span className="tiny">
                  {filtered.length} segment{filtered.length === 1 ? '' : 's'}
                  {query && ` of ${data.transcript.length}`} · click a line to play from there
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function TranscriptRow({
  segment,
  query,
  active,
  onSeek,
  rowRef
}: {
  segment: import('@shared/types').TranscriptSegment
  query: string
  active: boolean
  onSeek: (t: number) => void
  rowRef?: React.RefObject<HTMLDivElement | null>
}) {
  const [copied, setCopied] = useState(false)
  const text = segment.text
  const marked = query.trim()
    ? text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')).map((part, i) =>
        part.toLowerCase() === query.toLowerCase() ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>
      )
    : text

  return (
    <div
      className={`transcript-row ${active ? 'active' : ''}`}
      ref={rowRef}
      onClick={() => onSeek(segment.startTime)}
      title="Play from this timestamp"
    >
      <span className="ts">
        <Play size={8} style={{ verticalAlign: 1, marginRight: 3, opacity: active ? 1 : 0.35 }} />
        {formatClock(segment.startTime)}
      </span>
      <span
        className="seg-text"
        onClick={async (e) => {
          if (window.getSelection()?.toString()) return
          e.stopPropagation()
          const ok = await copyText(`[${formatClock(segment.startTime)}] ${text}`)
          setCopied(ok)
          setTimeout(() => setCopied(false), 1200)
        }}
        title="Click line: play · click text: copy"
      >
        {copied ? <span style={{ color: 'var(--success)' }}>copied · </span> : null}
        {marked}
      </span>
    </div>
  )
}

