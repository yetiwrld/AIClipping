import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Film, Plus, Link2, Clock, MoreHorizontal, FolderOpen, Pencil, Trash2, Clapperboard } from 'lucide-react'
import { api, isElectron, mediaUrl, errMessage } from '../../api/client'
import { pickUpload } from '../../api/upload'
import { useAppStore } from '../../stores/app'
import { useDataStore } from '../../stores/data'
import { EmptyState, Modal, formatRelative } from '../../components/ui'
import { formatClock } from '@shared/utils/time'
import type { ProjectSummary } from '@shared/types'

export function DashboardPage() {
  const app = useAppStore()
  const data = useDataStore()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [importing, setImporting] = useState<'file' | 'url' | null>(null)
  const [url, setUrl] = useState('')
  const [urlCheck, setUrlCheck] = useState<{ ok: boolean; label: string | null; reason: string | null; hint: string | null } | null>(null)

  const activeTasks = data.tasks.filter((t) => t.state === 'running' || t.state === 'queued')

  async function createProject(projectName: string): Promise<string | null> {
    try {
      const project = await api['projects.create']({ name: projectName })
      await data.refreshProjects()
      return project.id
    } catch (err) {
      app.toast({ level: 'error', ...errMessage(err) })
      return null
    }
  }

  async function handleCreate() {
    if (!name.trim()) return
    setCreating(true)
    const id = await createProject(name.trim())
    setCreating(false)
    if (id) {
      setName('')
      app.openProject(id)
    }
  }

  async function handleImportFile() {
    try {
      let filePath: string | null = null
      if (isElectron) {
        const picked = await api['media.pickSourceFile']()
        filePath = picked.filePath
        if (!filePath) return
      }
      setImporting('file')
      // Create a project named after the file, then import into it
      const baseName = filePath ? filePath.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || 'Imported video' : 'Imported video'
      const id = await createProject(baseName)
      if (!id) return
      if (filePath) {
        await api['media.importFile']({ projectId: id, filePath })
      } else {
        // Browser preview: file was uploaded to a temp path by the upload control
        const uploaded = await pickUpload(['video/*', 'audio/*', '.mkv', '.webm'])
        if (!uploaded) {
          app.toast({ level: 'warn', message: 'Import cancelled.' })
          return
        }
        await api['media.importFile']({ projectId: id, filePath: uploaded })
      }
      await data.refreshProjects()
      app.openProject(id)
    } catch (err) {
      app.toast({ level: 'error', ...errMessage(err) })
    } finally {
      setImporting(null)
    }
  }

  async function handleImportUrl() {
    const trimmed = url.trim()
    if (!trimmed) return
    if (urlCheck && !urlCheck.ok) {
      app.toast({ level: 'warn', message: urlCheck.reason ?? 'This URL cannot be imported.', hint: urlCheck.hint ?? undefined })
      return
    }
    setImporting('url')
    let placeholderId: string | null = null
    try {
      // Name the project after the file/link, not a placeholder
      let name = 'URL import'
      try {
        const u = new URL(trimmed)
        const file = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '')
        name = (file.replace(/\.[a-z0-9]{2,5}$/i, '') || u.hostname).slice(0, 80)
      } catch { /* keep placeholder */ }
      const id = await createProject(name)
      if (!id) return
      placeholderId = id
      await api['media.importUrl']({ projectId: id, url: trimmed })
      await data.refreshProjects()
      app.openProject(id)
    } catch (err) {
      // The import was rejected before it started — remove the empty
      // placeholder project so nothing broken is left behind.
      if (placeholderId) {
        await api['projects.delete']({ id: placeholderId, confirm: true }).catch(() => undefined)
        await data.refreshProjects()
      }
      app.toast({ level: 'error', ...errMessage(err) })
    } finally {
      setImporting(null)
    }
  }

  // Pre-flight URL check while typing: tells the user BEFORE creating a project
  // whether the link is importable (direct media vs. page needing yt-dlp).
  useEffect(() => {
    const trimmed = url.trim()
    if (!trimmed) {
      setUrlCheck(null)
      return
    }
    const timer = setTimeout(() => {
      void api['media.checkUrl']({ url: trimmed })
        .then((r) => setUrlCheck(r))
        .catch(() => setUrlCheck(null))
    }, 400)
    return () => clearTimeout(timer)
  }, [url])

  const sorted = useMemo(() => [...data.projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [data.projects])

  return (
    <div className="page">
      <div className="toolbar">
        <input
          id="new-project-name"
          className="input"
          style={{ flex: 1, minWidth: 220, maxWidth: 420 }}
          placeholder="New project name — e.g. “Episode 42 — Founder Interview”"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void handleCreate()}
        />
        <button className="btn primary" onClick={() => void handleCreate()} disabled={creating || !name.trim()}>
          <Plus size={14} /> Create project
        </button>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={() => void handleImportFile()} disabled={importing !== null}>
          <Film size={14} /> {importing === 'file' ? 'Importing…' : 'Import video'}
        </button>
      </div>

      <div className="row wrap" style={{ gap: 8, padding: '10px 8px 14px', borderBottom: '1px solid var(--border-strong)' }}>
        <Link2 size={13} className="muted" />
        <input
          className="input"
          style={{ flex: 1, minWidth: 220, maxWidth: 420 }}
          placeholder="…or paste a direct media URL (.mp4/.webm) you are authorized to use"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void handleImportUrl()}
        />
        <button className="btn" onClick={() => void handleImportUrl()} disabled={importing !== null || !url.trim()}>
          {importing === 'url' ? 'Starting…' : 'Import from URL'}
        </button>
        <span className="tiny" style={{ flex: 1, minWidth: 200 }}>
          {urlCheck == null
            ? 'Direct media links only. Sites that need extraction require yt-dlp on your system — the app never installs tools itself.'
            : urlCheck.ok
              ? <span className="status success"><span className="dot" /> Importable via {urlCheck.label}</span>
              : <span className="status danger"><span className="dot" /> {urlCheck.reason} {urlCheck.hint}</span>}
        </span>
      </div>

      {activeTasks.length > 0 && (
        <div className="section">
          {activeTasks.slice(0, 4).map((t) => (
            <div key={t.id} className="row" style={{ padding: '2px 8px', fontSize: 12.5 }}>
              <span className="status working">
                <span className="dot" /> {t.message ?? `${t.type}…`}
              </span>
              <span className="tiny">{t.stage ?? ''}</span>
            </div>
          ))}
        </div>
      )}

      {sorted.length === 0 ? (
        <div className="empty" style={{ padding: '80px 20px' }}>
          <Clapperboard size={28} className="empty-icon" />
          <div style={{ fontWeight: 600, fontSize: 13.5 }}>No projects yet</div>
          <div className="muted" style={{ maxWidth: 400, fontSize: 12.5, lineHeight: 1.55 }}>
            Create a project and import a long-form video — a podcast, interview, lecture or stream. Clipwright transcribes it,
            finds the strong moments, and helps you turn them into vertical clips.
          </div>
          <button className="btn primary" style={{ marginTop: 6 }} onClick={() => document.getElementById('new-project-name')?.focus()}>
            <Plus size={14} /> New project
          </button>
        </div>
      ) : (
        <div className="project-list">
          {sorted.map((p) => (
            <ProjectRow key={p.id} summary={p} />
          ))}
        </div>
      )}
    </div>
  )
}

function ProjectRow({ summary }: { summary: ProjectSummary }) {
  const app = useAppStore()
  const data = useDataStore()
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(summary.name)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  async function doRename() {
    const next = renameValue.trim()
    setRenaming(false)
    if (!next || next === summary.name) return
    try {
      await api['projects.rename']({ id: summary.id, name: next })
      await data.refreshProjects()
      if (data.activeProject?.id === summary.id) await data.loadProject(summary.id)
    } catch (err) {
      app.toast({ level: 'error', ...errMessage(err) })
    }
  }

  async function doDelete() {
    setConfirmDelete(false)
    try {
      await api['projects.delete']({ id: summary.id, confirm: true })
      await data.refreshProjects()
      app.toast({ level: 'info', message: `Project “${summary.name}” deleted.` })
      if (app.projectId === summary.id) app.navigate('dashboard')
    } catch (err) {
      app.toast({ level: 'error', ...errMessage(err) })
    }
  }

  return (
    <div
      className="project-row"
      role="button"
      tabIndex={0}
      onClick={() => !renaming && app.openProject(summary.id)}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !renaming && e.target === e.currentTarget) {
          e.preventDefault()
          app.openProject(summary.id)
        }
      }}
    >
      <div className="project-thumb">
        {summary.thumbnail ? (
          <img src={mediaUrl(summary.thumbnail)} alt="" />
        ) : (
          <Film size={18} strokeWidth={1.5} />
        )}
      </div>

      <div style={{ minWidth: 0 }}>
        {renaming ? (
          <input
            className="input"
            autoFocus
            value={renameValue}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void doRename()
              if (e.key === 'Escape') setRenaming(false)
            }}
            onBlur={() => void doRename()}
            style={{ maxWidth: 380 }}
          />
        ) : (
          <div className="project-name" title={summary.name}>{summary.name}</div>
        )}
        <div className="project-meta">
          {summary.duration != null && (
            <>
              <span className="mono">{formatClock(summary.duration)}</span>
              <span className="sep">·</span>
            </>
          )}
          <span>{summary.clipCount} clips</span>
          <span className="sep">·</span>
          <span>{summary.candidateCount} moments</span>
          <span className="sep">·</span>
          <span>edited {formatRelative(summary.updatedAt)}</span>
          {!summary.hasAudio && (
            <>
              <span className="sep">·</span>
              <span className="chip warn">no audio</span>
            </>
          )}
        </div>
      </div>

      <div className="project-side">
        <StatusChip status={summary.status} />
        <div className="menu-wrap" ref={menuRef}>
          <button
            className="btn ghost sm icon"
            aria-label="Project actions"
            onClick={(e) => {
              e.stopPropagation()
              setMenuOpen(!menuOpen)
            }}
          >
            <MoreHorizontal size={14} />
          </button>
          {menuOpen && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 50 }} onClick={() => setMenuOpen(false)} />
              <div className="menu">
                <button onClick={() => app.openProject(summary.id)}>
                  <FolderOpen size={13} /> Open
                </button>
                <button onClick={() => { setMenuOpen(false); setRenameValue(summary.name); setRenaming(true) }}>
                  <Pencil size={13} /> Rename
                </button>
                <div className="menu-sep" />
                <button className="danger" onClick={() => { setMenuOpen(false); setConfirmDelete(true) }}>
                  <Trash2 size={13} /> Delete…
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {confirmDelete && (
        <Modal
          title="Delete project?"
          onClose={() => setConfirmDelete(false)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirmDelete(false)}>Cancel</button>
              <button className="btn danger" onClick={() => void doDelete()}>
                <Trash2 size={13} /> Delete permanently
              </button>
            </>
          }
        >
          <div style={{ fontSize: 13, lineHeight: 1.6 }}>
            <strong>“{summary.name}”</strong> and all of its imported media, transcripts, clips and renders will be removed from
            the workspace. Files already exported to the exports folder are kept.
          </div>
          <div className="field-hint">This cannot be undone.</div>
        </Modal>
      )}
    </div>
  )
}

const STATUS_MAP: Record<string, { cls: string; label: string }> = {
  created: { cls: '', label: 'Empty' },
  importing: { cls: 'working', label: 'Importing' },
  import_failed: { cls: 'danger', label: 'Import failed' },
  ready: { cls: '', label: 'Ready' },
  transcribing: { cls: 'working', label: 'Transcribing' },
  transcription_failed: { cls: 'danger', label: 'Transcription failed' },
  transcribed: { cls: '', label: 'Transcribed' },
  analyzing: { cls: 'working', label: 'Analyzing' },
  analysis_failed: { cls: 'danger', label: 'Analysis failed' },
  analyzed: { cls: '', label: 'Analyzed' }
}

export function StatusChip({ status, message }: { status: string; message?: string | null }) {
  const entry = STATUS_MAP[status] ?? { cls: '', label: status }
  return (
    <span className={`status ${entry.cls}`} title={message ?? undefined}>
      <span className="dot" />
      {entry.label}
    </span>
  )
}
