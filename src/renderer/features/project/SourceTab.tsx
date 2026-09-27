import React, { useRef, useState } from 'react'
import { Film, Link2, HardDrive, FolderOpen, Trash2 } from 'lucide-react'
import { api, errMessage, isElectron, mediaUrl } from '../../api/client'
import { pickUpload } from '../../api/upload'
import { useAppStore } from '../../stores/app'
import { useDataStore } from '../../stores/data'
import { Field, formatBytes, Modal, ProgressBar } from '../../components/ui'
import { DURATION_RANGES } from '@shared/constants'

export function SourceTab() {
  const app = useAppStore()
  const data = useDataStore()
  const project = data.activeProject!
  const [url, setUrl] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const importTask = data.tasks.find((t) => t.type === 'download' && t.projectId === project.id && (t.state === 'running' || t.state === 'queued'))
  const importing = project.status === 'importing' || Boolean(importTask)

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

  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.7fr) minmax(280px, 1fr)', alignItems: 'start' }}>
      <div className="stack">
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {project.sourcePath && project.status !== 'importing' ? (
            <video
              key={project.sourcePath}
              src={mediaUrl(project.sourcePath)}
              controls
              style={{ width: '100%', aspectRatio: '16/9', background: '#000', display: 'block' }}
              preload="metadata"
            />
          ) : (
            <div style={{ aspectRatio: '16/9', display: 'grid', placeItems: 'center', background: 'var(--bg-2)' }}>
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

        <div className="card">
          <div className="card-title">Import media</div>
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

      <div className="stack">
        <div className="card">
          <div className="card-title">Source information</div>
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
                <MetaRow k="Size" v={project.sizeBytes ? formatBytes(project.sizeBytes) : '—'} />
                <MetaRow k="Imported via" v={project.sourceType === 'url' ? 'URL download' : 'Local file'} />
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <div className="card-title">Discovery settings</div>
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
          <div className="card">
            <div className="card-title">
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

        <button className="btn danger" onClick={() => setConfirmDelete(true)}>
          <Trash2 size={14} /> Delete project…
        </button>
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

