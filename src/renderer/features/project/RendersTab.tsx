import React from 'react'
import { ListVideo, RotateCcw, X, FolderOpen, Play } from 'lucide-react'
import { api, errMessage, mediaUrl } from '../../api/client'
import { useAppStore } from '../../stores/app'
import { useDataStore } from '../../stores/data'
import { EmptyState, ErrorBox, ProgressBar } from '../../components/ui'
import { formatClock } from '@shared/utils/time'

export function RendersTab() {
  return <RenderList scopedToProject />
}

export function RenderList({ scopedToProject }: { scopedToProject?: boolean }) {
  const app = useAppStore()
  const data = useDataStore()
  const projectId = scopedToProject ? app.projectId : undefined
  const renders = projectId ? data.renders.filter((r) => r.projectId === projectId) : data.renders
  const clipsById = new Map(data.clips.map((c) => [c.id, c]))

  async function cancel(id: string) {
    try {
      await api['renders.cancel']({ id })
    } catch (err) {
      app.toast({ level: 'error', ...errMessage(err) })
    }
  }

  async function retry(id: string) {
    try {
      await api['renders.retry']({ id })
    } catch (err) {
      app.toast({ level: 'error', ...errMessage(err) })
    }
  }

  if (renders.length === 0) {
    return (
      <div className="card">
        <EmptyState
          icon={<ListVideo size={38} className="empty-icon" />}
          title="No renders yet"
          hint="Render a clip to produce a vertical MP4 with burned-in captions. Renders happen locally with FFmpeg — the UI stays responsive and you can queue several."
        />
      </div>
    )
  }

  return (
    <div className="stack">
      {renders.map((r) => {
        const clip = clipsById.get(r.clipId)
        const busy = r.status === 'rendering' || r.status === 'preparing' || r.status === 'queued'
        return (
          <div className="card pad-sm" key={r.id}>
            <div className="row wrap">
              <span style={{ fontWeight: 600, fontSize: 13.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 320 }}>
                {clip?.title || 'Clip'}
              </span>
              <span className={`chip ${r.status === 'completed' ? 'success' : busy ? 'accent' : r.status === 'failed' ? 'danger' : ''}`}>{r.status}</span>
              {r.stage && <span className="chip">{r.stage}</span>}
              <span className="tiny">{new Date(r.createdAt).toLocaleString()}</span>
              <span style={{ flex: 1 }} />
              {busy && (
                <button className="btn sm" onClick={() => void cancel(r.id)}>
                  <X size={13} /> Cancel
                </button>
              )}
              {(r.status === 'failed' || r.status === 'cancelled') && (
                <button className="btn sm" onClick={() => void retry(r.id)}>
                  <RotateCcw size={13} /> Retry
                </button>
              )}
              {r.outputPath && (
                <button
                  className="btn ghost sm"
                  title="Open containing folder"
                  onClick={() => void api['system.revealPath']({ path: r.outputPath! }).catch((e) => app.toast({ level: 'warn', ...errMessage(e) }))}
                >
                  <FolderOpen size={13} />
                </button>
              )}
            </div>
            {busy && (
              <div style={{ marginTop: 9 }}>
                <ProgressBar value={r.progress} />
                <div className="tiny" style={{ marginTop: 4 }}>{Math.round(r.progress * 100)}% · {r.stage ?? 'working'}</div>
              </div>
            )}
            {r.status === 'failed' && r.error && (
              <div style={{ marginTop: 9 }}>
                <ErrorBox error={{ message: r.error.message, hint: r.error.hint, code: r.error.code, details: r.error.details }} onRetry={() => void retry(r.id)} retryLabel="Retry render" />
              </div>
            )}
            {r.status === 'completed' && r.outputPath && (
              <video src={mediaUrl(r.outputPath)} controls style={{ width: 220, borderRadius: 8, marginTop: 10, background: '#000' }} preload="metadata" />
            )}
          </div>
        )
      })}
    </div>
  )
}
