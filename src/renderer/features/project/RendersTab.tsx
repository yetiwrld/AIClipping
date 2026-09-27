import React from 'react'
import { RotateCcw, X, FolderOpen, ListVideo } from 'lucide-react'
import { api, errMessage, mediaUrl } from '../../api/client'
import { useAppStore } from '../../stores/app'
import { useDataStore } from '../../stores/data'
import { EmptyState, ErrorBox, ProgressBar } from '../../components/ui'
import type { RenderJob } from '@shared/types'

export function RendersTab() {
  return <RenderList scopedToProject />
}

/**
 * Render jobs grouped by state — Rendering / Queued / Completed / Failed —
 * so the queue reads like a production task monitor, not a card feed.
 */
export function RenderList({ scopedToProject }: { scopedToProject?: boolean }) {
  const app = useAppStore()
  const data = useDataStore()
  const projectId = scopedToProject ? app.projectId : undefined
  const renders = projectId ? data.renders.filter((r) => r.projectId === projectId) : data.renders
  const clipsById = new Map(data.clips.map((c) => [c.id, c]))
  const projectsById = new Map(data.projects.map((p) => [p.id, p.name]))

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
      <div className="empty" style={{ padding: '72px 20px' }}>
        <ListVideo size={28} className="empty-icon" />
        <div style={{ fontWeight: 600, fontSize: 13.5 }}>No renders yet</div>
        <div className="muted" style={{ maxWidth: 400, fontSize: 12.5, lineHeight: 1.55 }}>
          Render a clip to produce a vertical MP4 with burned-in captions. Renders run locally with FFmpeg — you can queue
          several and keep working.
        </div>
      </div>
    )
  }

  const order = (a: RenderJob, b: RenderJob) => b.createdAt.localeCompare(a.createdAt)
  const rendering = renders.filter((r) => r.status === 'rendering' || r.status === 'preparing').sort(order)
  const queued = renders.filter((r) => r.status === 'queued').sort(order)
  const completed = renders.filter((r) => r.status === 'completed').sort(order)
  const failed = renders.filter((r) => r.status === 'failed' || r.status === 'cancelled').sort(order)

  return (
    <div>
      {rendering.length > 0 && (
        <div className="queue-group">
          <div className="queue-group-title">Rendering</div>
          {rendering.map((r) => (
            <RenderRow key={r.id} render={r} clipTitle={clipsById.get(r.clipId)?.title} projectName={projectId ? undefined : projectsById.get(r.projectId)} onCancel={() => void cancel(r.id)} />
          ))}
        </div>
      )}

      {queued.length > 0 && (
        <div className="queue-group">
          <div className="queue-group-title">Queued</div>
          {queued.map((r) => (
            <RenderRow key={r.id} render={r} clipTitle={clipsById.get(r.clipId)?.title} projectName={projectId ? undefined : projectsById.get(r.projectId)} onCancel={() => void cancel(r.id)} />
          ))}
        </div>
      )}

      {completed.length > 0 && (
        <div className="queue-group">
          <div className="queue-group-title">Completed · {completed.length}</div>
          {completed.map((r) => (
            <RenderRow key={r.id} render={r} clipTitle={clipsById.get(r.clipId)?.title} projectName={projectId ? undefined : projectsById.get(r.projectId)} onRetry={() => void retry(r.id)} />
          ))}
        </div>
      )}

      {failed.length > 0 && (
        <div className="queue-group">
          <div className="queue-group-title" style={{ color: 'var(--danger)' }}>Failed · {failed.length}</div>
          {failed.map((r) => (
            <RenderRow key={r.id} render={r} clipTitle={clipsById.get(r.clipId)?.title} projectName={projectId ? undefined : projectsById.get(r.projectId)} onRetry={() => void retry(r.id)} />
          ))}
        </div>
      )}
    </div>
  )
}

function RenderRow({
  render,
  clipTitle,
  projectName,
  onCancel,
  onRetry
}: {
  render: RenderJob
  clipTitle?: string
  projectName?: string
  onCancel?: () => void
  onRetry?: () => void
}) {
  const app = useAppStore()
  const busy = render.status === 'rendering' || render.status === 'preparing' || render.status === 'queued'
  const isCompleted = render.status === 'completed'

  return (
    <div className="queue-row">
      <div style={{ minWidth: 0 }}>
        <div className="q-title">
          {clipTitle || 'Clip'}
          {render.preview && <span className="tl-badge preview" style={{ marginLeft: 6 }}>preview</span>}
        </div>
        {projectName && <div className="tiny" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{projectName}</div>}
      </div>

      <div className="q-meta">
        {busy ? (
          <div className="q-progress">
            <ProgressBar value={render.progress} />
            <span className="tiny">{Math.round(render.progress * 100)}% · {render.stage ?? 'working'}</span>
          </div>
        ) : render.status === 'failed' && render.error ? (
          <div className="tiny" style={{ color: 'var(--danger)' }}>
            {render.error.message}
            {render.error.hint && <span style={{ color: 'var(--text-3)' }}> — {render.error.hint}</span>}
          </div>
        ) : (
          <span>
            <span className={`status ${isCompleted ? 'success' : render.status === 'cancelled' ? 'warn' : 'danger'}`}>
              <span className="dot" /> {render.status}
            </span>
            <span className="tiny" style={{ marginLeft: 8 }}>{new Date(render.createdAt).toLocaleString()}</span>
          </span>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        {isCompleted && render.outputPath && (
          <video src={mediaUrl(render.outputPath)} style={{ width: 34, height: 60, borderRadius: 3, background: '#000', border: '1px solid var(--border)' }} muted preload="metadata" title="Rendered preview" />
        )}
      </div>

      <div className="q-actions">
        {onCancel && busy && (
          <button className="btn sm" onClick={onCancel}>
            <X size={12} /> Cancel
          </button>
        )}
        {onRetry && !busy && (
          <button className="btn sm" onClick={onRetry}>
            <RotateCcw size={12} /> Retry
          </button>
        )}
        {isCompleted && render.outputPath && (
          <button
            className="btn ghost sm icon"
            title="Open containing folder"
            onClick={() => void api['system.revealPath']({ path: render.outputPath! }).catch((e) => app.toast({ level: 'warn', ...errMessage(e) }))}
          >
            <FolderOpen size={12} />
          </button>
        )}
      </div>
    </div>
  )
}
