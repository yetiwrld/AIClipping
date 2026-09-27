import React, { useState } from 'react'
import { Scissors, Pencil, Play, Package, Trash2, Copy, Sparkles, FolderOpen } from 'lucide-react'
import { api, errMessage, mediaUrl, copyText } from '../../api/client'
import { useAppStore } from '../../stores/app'
import { useDataStore } from '../../stores/data'
import { EmptyState, ErrorBox, Spinner } from '../../components/ui'
import { getCaptionStyle } from '@shared/constants'
import { formatClock } from '@shared/utils/time'

export function ClipsTab() {
  const app = useAppStore()
  const data = useDataStore()
  const project = data.activeProject!
  const [busyClipId, setBusyClipId] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)

  async function render(clipId: string) {
    setBusyClipId(clipId)
    setError(null)
    try {
      await api['renders.queue']({ clipId })
      await data.loadRenders(project.id)
      app.toast({ level: 'info', message: 'Render queued — watch progress in the Render queue.' })
    } catch (err) {
      setError(err)
    } finally {
      setBusyClipId(null)
    }
  }

  async function remove(clipId: string) {
    try {
      await api['clips.delete']({ id: clipId })
      await data.loadClips(project.id)
      await data.loadRenders(project.id)
    } catch (err) {
      app.toast({ level: 'error', ...errMessage(err) })
    }
  }

  async function exportClips(clipIds: string[]) {
    try {
      const result = await api['exports.run']({ clipIds, includeMetadata: true })
      app.toast({
        level: 'success',
        message: `Exported ${clipIds.length} clip${clipIds.length === 1 ? '' : 's'} with metadata.`,
        actionLabel: 'Reveal folder',
        action: () => void api['system.revealPath']({ path: result.dir }).catch(() => undefined)
      })
    } catch (err) {
      app.toast({ level: 'error', ...errMessage(err) })
    }
  }

  if (data.clips.length === 0) {
    return (
      <div className="card">
        <EmptyState
          icon={<Scissors size={38} className="empty-icon" />}
          title="No clips yet"
          hint="Create a clip from a discovered moment in the Moments tab, then trim, caption and render it here."
        />
      </div>
    )
  }

  const renderable = data.clips.filter((c) => {
    const latest = data.renders.find((r) => r.clipId === c.id && r.status === 'completed')
    return latest != null
  })

  return (
    <div className="stack">
      {error ? <ErrorBox error={error} /> : null}
      {renderable.length > 0 && (
        <div className="row">
          <span className="tiny">{renderable.length} rendered clip{renderable.length === 1 ? '' : 's'} ready to export</span>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={() => void exportClips(renderable.map((c) => c.id))}>
            <Package size={14} /> Export all rendered
          </button>
        </div>
      )}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(430px, 1fr))' }}>
        {data.clips.map((clip) => (
          <ClipCard
            key={clip.id}
            clip={clip}
            busy={busyClipId === clip.id}
            renders={data.renders.filter((r) => r.clipId === clip.id)}
            onRender={() => void render(clip.id)}
            onEdit={() => app.openEditor(clip.id, clip.projectId)}
            onDelete={() => void remove(clip.id)}
            onExport={() => void exportClips([clip.id])}
          />
        ))}
      </div>
    </div>
  )
}


function ClipCard({
  clip,
  busy,
  renders,
  onRender,
  onEdit,
  onDelete,
  onExport
}: {
  clip: import('@shared/types').Clip
  busy: boolean
  renders: import('@shared/types').RenderJob[]
  onRender: () => void
  onEdit: () => void
  onDelete: () => void
  onExport: () => void
}) {
  const app = useAppStore()
  const data = useDataStore()
  const activeRender = renders.find((r) => r.status === 'rendering' || r.status === 'preparing' || r.status === 'queued')
  const doneRender = renders.find((r) => r.status === 'completed')
  const failedRender = renders.find((r) => r.status === 'failed')
  const style = getCaptionStyle(clip.captionStyleId)

  async function copyDescription() {
    const text = [clip.title, '', clip.description, clip.cta ? `\n${clip.cta}` : '', '', clip.hashtags.join(' ')].join('\n').trim()
    const ok = await copyText(text)
    app.toast(ok ? { level: 'success', message: 'Description + hashtags copied.' } : { level: 'warn', message: 'Copy failed.' })
  }

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div
          style={{
            width: 58,
            height: 103,
            borderRadius: 7,
            background: 'var(--bg-2)',
            border: '1px solid var(--border-1)',
            overflow: 'hidden',
            flexShrink: 0,
            display: 'grid',
            placeItems: 'center'
          }}
        >
          {doneRender?.outputPath ? (
            <video src={mediaUrl(doneRender.outputPath)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} muted preload="metadata" />
          ) : (
            <Play size={16} className="empty-icon" />
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 650, fontSize: 13.5, lineHeight: 1.35 }}>
            {clip.title || <span className="muted">Untitled clip</span>}
          </div>
          <div className="row wrap" style={{ marginTop: 5, gap: 6 }}>
            <span className="chip">{formatClock(clip.startTime)} → {formatClock(clip.endTime)}</span>
            <span className="chip">{Math.round(clip.endTime - clip.startTime)}s</span>
            <span className="chip" title={`Caption style: ${style.label}`}>{style.label}</span>
            <span className={`chip ${clip.status === 'rendered' ? 'success' : ''}`}>{clip.status}</span>
          </div>
          <div className="tiny" style={{ marginTop: 6, lineHeight: 1.55 }}>
            {clip.description ? clip.description.slice(0, 130) + (clip.description.length > 130 ? '…' : '') : <span className="muted">No description yet — generate or write one in the editor.</span>}
          </div>
        </div>
      </div>

      {activeRender && (
        <div className="row" style={{ fontSize: 12.5 }}>
          <Spinner /> <span className="muted">Rendering… {Math.round(activeRender.progress * 100)}%</span>
        </div>
      )}
      {failedRender && !activeRender && !doneRender && failedRender.error && (
        <ErrorBox
          error={{ message: failedRender.error.message, hint: failedRender.error.hint, code: failedRender.error.code, details: failedRender.error.details }}
          onRetry={() => void api['renders.retry']({ id: failedRender.id })}
          retryLabel="Retry render"
        />
      )}

      <div className="row wrap" style={{ marginTop: 'auto' }}>
        <button className="btn sm" onClick={onEdit}>
          <Pencil size={13} /> Edit
        </button>
        <button className="btn primary sm" onClick={onRender} disabled={busy || Boolean(activeRender)}>
          {busy || activeRender ? <Spinner size={12} /> : <Play size={13} />} Render
        </button>
        {doneRender && (
          <>
            <button className="btn sm" onClick={onExport}>
              <Package size={13} /> Export
            </button>
            <button
              className="btn ghost sm"
              title="Open containing folder"
              onClick={() => void api['system.revealPath']({ path: doneRender.outputPath! }).catch((e) => app.toast({ level: 'warn', ...errMessage(e) }))}
            >
              <FolderOpen size={13} />
            </button>
          </>
        )}
        <button className="btn ghost sm" onClick={() => void copyDescription()} title="Copy title + description + hashtags">
          <Copy size={13} />
        </button>
        <span style={{ flex: 1 }} />
        <button className="btn ghost sm danger" onClick={onDelete} title="Delete clip">
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  )
}
