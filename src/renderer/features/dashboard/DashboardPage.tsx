import React, { useMemo, useState } from 'react'
import { Film, Plus, Link2, Clock, HardDrive, ChevronRight, ListChecks, Scissors } from 'lucide-react'
import { api, isElectron, mediaUrl, errMessage } from '../../api/client'
import { pickUpload } from '../../api/upload'
import { useAppStore } from '../../stores/app'
import { useDataStore } from '../../stores/data'
import { EmptyState, formatBytes, ProgressBar } from '../../components/ui'
import { formatClock } from '@shared/utils/time'

export function DashboardPage() {
  const app = useAppStore()
  const data = useDataStore()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [importing, setImporting] = useState<'file' | 'url' | null>(null)
  const [url, setUrl] = useState('')

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
    if (!url.trim()) return
    setImporting('url')
    try {
      const id = await createProject('URL import')
      if (!id) return
      await api['media.importUrl']({ projectId: id, url: url.trim() })
      await data.refreshProjects()
      app.openProject(id)
    } catch (err) {
      app.toast({ level: 'error', ...errMessage(err) })
    } finally {
      setImporting(null)
    }
  }

  const sorted = useMemo(() => [...data.projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [data.projects])

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Projects</div>
          <div className="page-subtitle">
            Long video in · short clips out. Everything stays on this machine unless you configure an AI provider.
          </div>
        </div>
        <div className="header-spacer" />
        <button className="btn" onClick={() => handleImportFile()} disabled={importing !== null}>
          <Film size={15} /> {importing === 'file' ? 'Importing…' : 'Import video'}
        </button>
        <button className="btn primary" onClick={() => document.getElementById('new-project-name')?.focus()}>
          <Plus size={15} /> New project
        </button>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="row wrap">
          <input
            id="new-project-name"
            className="input"
            style={{ flex: 1, minWidth: 220 }}
            placeholder="Name your project — e.g. “Episode 42 — Founder Interview”"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void handleCreate()}
          />
          <button className="btn primary" onClick={() => void handleCreate()} disabled={creating || !name.trim()}>
            Create project
          </button>
        </div>
        <div className="divider" />
        <div className="row wrap">
          <Link2 size={15} className="muted" />
          <input
            className="input"
            style={{ flex: 1, minWidth: 220 }}
            placeholder="…or paste a direct media URL (.mp4/.webm) you are authorized to use"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void handleImportUrl()}
          />
          <button className="btn" onClick={() => void handleImportUrl()} disabled={importing !== null || !url.trim()}>
            {importing === 'url' ? 'Starting…' : 'Import from URL'}
          </button>
        </div>
        <div className="tiny" style={{ marginTop: 8 }}>
          URL import supports direct media links. Sites that need extraction require yt-dlp installed on your system — the app
          never installs tools by itself.
        </div>
      </div>

      {activeTasks.length > 0 && (
        <div className="card pad-sm" style={{ marginBottom: 20 }}>
          <div className="row" style={{ marginBottom: 8 }}>
            <ListChecks size={15} className="muted" />
            <strong style={{ fontSize: 13 }}>Processing now</strong>
          </div>
          {activeTasks.slice(0, 4).map((t) => (
            <div key={t.id} style={{ padding: '6px 0' }}>
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 12.5 }}>{t.message ?? `${t.type}…`}</span>
                <span className="tiny">{t.stage ?? t.state}</span>
              </div>
              {t.progress != null && <ProgressBar value={t.progress} />}
            </div>
          ))}
        </div>
      )}

      {sorted.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={<Scissors size={40} />}
            title="No projects yet"
            hint="Create a project and import a long-form video — a podcast, interview, lecture or stream. Clipwright will transcribe it, find the strong moments, and help you turn them into vertical clips."
            action={
              <button className="btn primary lg" onClick={() => document.getElementById('new-project-name')?.focus()}>
                <Plus size={16} /> Create your first project
              </button>
            }
          />
        </div>
      ) : (
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(310px, 1fr))' }}>
          {sorted.map((p) => (
            <ProjectCard key={p.id} summary={p} />
          ))}
        </div>
      )}
    </div>
  )
}

function ProjectCard({ summary }: { summary: import('@shared/types').ProjectSummary }) {
  const app = useAppStore()
  return (
    <button className="card" style={{ textAlign: 'left', cursor: 'pointer', padding: 0, overflow: 'hidden' }} onClick={() => app.openProject(summary.id)}>
      <div style={{ position: 'relative', background: 'var(--bg-2)', aspectRatio: '16/9', display: 'grid', placeItems: 'center' }}>
        {summary.thumbnail ? (
          <img src={mediaUrl(summary.thumbnail)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <Film size={30} className="empty-icon" />
        )}
        {summary.duration != null && (
          <span className="chip" style={{ position: 'absolute', right: 8, bottom: 8, background: 'rgba(6,8,12,0.78)' }}>
            <Clock size={11} /> {formatClock(summary.duration)}
          </span>
        )}
      </div>
      <div style={{ padding: '12px 14px 14px' }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <strong style={{ fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{summary.name}</strong>
          <ChevronRight size={15} className="muted" />
        </div>
        <div className="row wrap" style={{ marginTop: 8, gap: 6 }}>
          <StatusChip status={summary.status} />
          {summary.candidateCount > 0 && <span className="chip">{summary.candidateCount} moments</span>}
          {summary.clipCount > 0 && <span className="chip accent">{summary.clipCount} clips</span>}
          {!summary.hasAudio && <span className="chip warn">no audio</span>}
        </div>
      </div>
    </button>
  )
}

export function StatusChip({ status, message }: { status: string; message?: string | null }) {
  const map: Record<string, { cls: string; label: string }> = {
    created: { cls: '', label: 'Empty project' },
    importing: { cls: 'accent', label: 'Importing…' },
    import_failed: { cls: 'danger', label: 'Import failed' },
    ready: { cls: 'success', label: 'Ready' },
    transcribing: { cls: 'accent', label: 'Transcribing…' },
    transcription_failed: { cls: 'danger', label: 'Transcription failed' },
    transcribed: { cls: 'success', label: 'Transcribed' },
    analyzing: { cls: 'accent', label: 'Analyzing…' },
    analysis_failed: { cls: 'danger', label: 'Analysis failed' },
    analyzed: { cls: 'success', label: 'Analyzed' }
  }
  const entry = map[status] ?? { cls: '', label: status }
  return (
    <span className={`chip ${entry.cls}`} title={message ?? undefined}>
      {entry.label}
    </span>
  )
}
