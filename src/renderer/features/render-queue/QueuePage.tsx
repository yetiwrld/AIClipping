import React, { useEffect } from 'react'
import { RotateCcw, History, Trash2, X } from 'lucide-react'
import { api, errMessage } from '../../api/client'
import { useAppStore } from '../../stores/app'
import { useDataStore } from '../../stores/data'
import { RenderList } from '../project/RendersTab'

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
        <div className="queue-group">
          <div className="queue-group-title" style={{ color: 'var(--warn)' }}>
            <History size={12} /> Interrupted processing · {interrupted.length}
          </div>
          <div className="tiny" style={{ padding: '6px 6px 8px', maxWidth: 560 }}>
            These operations were in flight when the application last closed. Nothing was corrupted — choose whether to run them
            again.
          </div>
          {interrupted.map((t) => (
            <div className="queue-row" key={t.id}>
              <div style={{ minWidth: 0 }}>
                <div className="q-title">{projectById.get(t.projectId ?? '') ?? t.projectId?.slice(0, 8) ?? '—'}</div>
                <div className="tiny">{t.type}</div>
              </div>
              <div className="q-meta tiny">{t.message ?? ''}</div>
              <div />
              <div className="q-actions">
                <button className="btn sm primary" onClick={() => void resume(t.id)}>
                  <RotateCcw size={12} /> Run again
                </button>
                <button className="btn sm" onClick={() => void discard(t.id)}>
                  <Trash2 size={12} /> Discard
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {running.length > 0 && (
        <div className="queue-group">
          <div className="queue-group-title">Active now</div>
          {running.map((t) => (
            <div className="queue-row" key={t.id}>
              <div style={{ minWidth: 0 }}>
                <div className="q-title">{t.type}</div>
                <div className="tiny">{projectById.get(t.projectId ?? '') ?? '—'}</div>
              </div>
              <div className="q-meta tiny">
                <span className="status working"><span className="dot" /> {t.message ?? t.stage ?? 'Working…'}</span>
              </div>
              <div className="tiny" style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                {t.progress != null ? `${Math.round(t.progress * 100)}%` : ''}
              </div>
              <div className="q-actions">
                <button className="btn sm" onClick={() => void cancel(t.id)}>
                  <X size={12} /> Cancel
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginBottom: 20 }}>
        <RenderList />
      </div>

      {history.length > 0 && (
        <div className="queue-group">
          <div className="queue-group-title">Recent operations</div>
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
                    <span className={`status ${t.state === 'completed' ? 'success' : t.state === 'failed' ? 'danger' : 'warn'}`}>
                      <span className="dot" /> {t.state}
                    </span>
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
    </div>
  )
}
