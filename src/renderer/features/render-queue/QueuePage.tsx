import React, { useEffect } from 'react'
import { ListVideo, RotateCcw, X, History, Trash2 } from 'lucide-react'
import { api, errMessage } from '../../api/client'
import { useAppStore } from '../../stores/app'
import { useDataStore } from '../../stores/data'
import { RenderList } from '../project/RendersTab'
import { formatClock } from '@shared/utils/time'

/**
 * Global queue view: renders across projects + the task/recovery list.
 * Interrupted work from an unclean shutdown surfaces here with
 * Resume / Discard options (spec §88) — never silent auto-restart.
 */
export function QueuePage() {
  const app = useAppStore()
  const data = useDataStore()

  useEffect(() => {
    void data.loadTasks()
    void data.loadRenders()
    const id = setInterval(() => void data.loadTasks(), 4000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const interrupted = data.tasks.filter((t) => t.state === 'interrupted')
  const running = data.tasks.filter((t) => t.state === 'running' || t.state === 'queued')
  const history = data.tasks.filter((t) => ['completed', 'failed', 'cancelled'].includes(t.state)).slice(0, 25)

  async function resume(id: string) {
    try {
      await api['tasks.resume']({ id })
      await data.loadTasks()
      app.toast({ level: 'info', message: 'Task restarted.' })
    } catch (err) {
      app.toast({ level: 'error', ...errMessage(err) })
    }
  }

  async function discard(id: string) {
    try {
      await api['tasks.discard']({ id })
      await data.loadTasks()
    } catch (err) {
      app.toast({ level: 'error', ...errMessage(err) })
    }
  }

  async function cancel(id: string) {
    try {
      await api['tasks.cancel']({ id })
      await data.loadTasks()
    } catch (err) {
      app.toast({ level: 'error', ...errMessage(err) })
    }
  }

  const projectById = new Map(data.projects.map((p) => [p.id, p.name]))

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Render queue</div>
          <div className="page-subtitle">Renders run locally with FFmpeg. Concurrency is configurable in Settings → Video.</div>
        </div>
      </div>

      {interrupted.length > 0 && (
        <div className="card" style={{ marginBottom: 18, borderColor: 'rgba(229,161,63,0.4)' }}>
          <div className="row" style={{ marginBottom: 8 }}>
            <History size={15} color="var(--warn)" />
            <strong style={{ fontSize: 13.5 }}>Interrupted processing detected</strong>
          </div>
          <div className="field-hint" style={{ marginBottom: 10 }}>
            These operations were in flight when the application last closed. Nothing was corrupted — choose whether to run them
            again.
          </div>
          {interrupted.map((t) => (
            <div className="row" key={t.id} style={{ padding: '7px 0', borderTop: '1px solid var(--border-1)' }}>
              <span className="chip warn">{t.type}</span>
              <span style={{ fontSize: 13 }}>{projectById.get(t.projectId ?? '') ?? t.projectId?.slice(0, 8) ?? '—'}</span>
              <span className="tiny">{t.message ?? ''}</span>
              <span style={{ flex: 1 }} />
              <button className="btn sm primary" onClick={() => void resume(t.id)}>
                <RotateCcw size={12} /> Run again
              </button>
              <button className="btn sm" onClick={() => void discard(t.id)}>
                <Trash2 size={12} /> Discard
              </button>
            </div>
          ))}
        </div>
      )}

      {running.length > 0 && (
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-title">Active now</div>
          {running.map((t) => (
            <div className="row" key={t.id} style={{ padding: '7px 0', borderTop: '1px solid var(--border-1)' }}>
              <span className="chip accent">{t.type}</span>
              <span style={{ fontSize: 13, flex: 1 }}>{t.message ?? t.stage ?? 'Working…'}</span>
              <span className="tiny">{t.progress != null ? `${Math.round(t.progress * 100)}%` : ''}</span>
              <button className="btn sm" onClick={() => void cancel(t.id)}>
                <X size={12} /> Cancel
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginBottom: 18 }}>
        <RenderList />
      </div>

      {history.length > 0 && (
        <div className="card">
          <div className="card-title">Recent operations</div>
          <table className="table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Project</th>
                <th>State</th>
                <th>Message</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {history.map((t) => (
                <tr key={t.id}>
                  <td>{t.type}</td>
                  <td>{projectById.get(t.projectId ?? '') ?? '—'}</td>
                  <td>
                    <span className={`chip ${t.state === 'completed' ? 'success' : t.state === 'failed' ? 'danger' : ''}`}>{t.state}</span>
                  </td>
                  <td className="tiny" style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.error?.message ?? t.message ?? '—'}
                  </td>
                  <td className="tiny">{new Date(t.updatedAt).toLocaleTimeString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.renders.length === 0 && running.length === 0 && (
        <div className="card">
          <div className="empty">
            <ListVideo size={36} className="empty-icon" />
            <strong>Queue is empty</strong>
            <span className="muted" style={{ fontSize: 13 }}>
              Renders you queue from the editor or clip cards appear here with live progress.
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
