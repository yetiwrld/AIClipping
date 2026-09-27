import React, { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Film, FileText, Sparkles, Scissors, ListVideo, Settings2, RefreshCw } from 'lucide-react'
import { api, errMessage, isElectron } from '../../api/client'
import { useAppStore } from '../../stores/app'
import { useDataStore } from '../../stores/data'
import { ErrorBox, Spinner, formatBytes } from '../../components/ui'
import { StatusChip } from '../dashboard/DashboardPage'
import { SourceTab } from './SourceTab'
import { TranscriptTab } from './TranscriptTab'
import { MomentsTab } from './MomentsTab'
import { ClipsTab } from './ClipsTab'
import { RendersTab } from './RendersTab'

type Tab = 'source' | 'transcript' | 'moments' | 'clips' | 'renders'

export function ProjectPage() {
  const app = useAppStore()
  const data = useDataStore()
  const projectId = app.projectId
  const [tab, setTab] = useState<Tab>('source')
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!projectId) {
      app.navigate('dashboard')
      return
    }
    setLoading(true)
    setError(null)
    data
      .loadProject(projectId)
      .then((p) => {
        if (!p) setError(new Error('Project not found.'))
      })
      .catch(setError)
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  const project = data.activeProject
  const status = project?.status ?? 'created'

  const suggested: Tab = useMemo(() => {
    if (status === 'created' || status === 'importing' || status === 'import_failed' || status === 'ready') return 'source'
    if (status === 'transcribing' || status === 'transcription_failed') return 'transcript'
    if (status === 'transcribed') return 'transcript'
    return 'moments'
  }, [status])

  useEffect(() => {
    setTab(suggested)
  }, [suggested, projectId])

  if (loading && !project) {
    return (
      <div className="page" style={{ display: 'grid', placeItems: 'center' }}>
        <Spinner size={22} />
      </div>
    )
  }

  if (error || !project || project.id !== projectId) {
    return (
      <div className="page">
        <ErrorBox error={error ?? new Error('Project not found.')} onRetry={() => app.navigate('dashboard')} retryLabel="Back to projects" />
      </div>
    )
  }

  return (
    <div className="page">
      <div className="page-header">
        <button className="btn ghost" onClick={() => app.navigate('dashboard')} aria-label="Back to projects">
          <ArrowLeft size={16} />
        </button>
        <div style={{ minWidth: 0 }}>
          <div className="page-title" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.name}</div>
          <div className="page-subtitle">
            {project.sourceFilename ?? 'No media imported'}
            {project.duration != null && ` · ${Math.round(project.duration / 60)} min`}
            {project.width != null && ` · ${project.width}×${project.height}`}
            {project.fps != null && ` · ${project.fps} fps`}
            {data.storage && ` · ${formatBytes(data.storage.total)} used`}
          </div>
        </div>
        <div className="header-spacer" />
        <Pipeline status={status} />
        <button className="btn ghost" onClick={() => void data.loadProject(project.id)} aria-label="Refresh project" title="Refresh">
          <RefreshCw size={15} />
        </button>
      </div>

      {project.statusMessage && (project.status.endsWith('failed') || !project.hasAudio) && (
        <div style={{ marginBottom: 16 }}>
          <ErrorBox error={{ message: project.statusMessage, code: project.status }} />
        </div>
      )}

      <div className="tabs">
        <TabButton tab={tab} setTab={setTab} id="source" icon={<Film size={14} />} label="Source" />
        <TabButton tab={tab} setTab={setTab} id="transcript" icon={<FileText size={14} />} label="Transcript" count={data.transcript.length || undefined} />
        <TabButton tab={tab} setTab={setTab} id="moments" icon={<Sparkles size={14} />} label="Moments" count={data.candidates.length || undefined} />
        <TabButton tab={tab} setTab={setTab} id="clips" icon={<Scissors size={14} />} label="Clips" count={data.clips.length || undefined} />
        <TabButton tab={tab} setTab={setTab} id="renders" icon={<ListVideo size={14} />} label="Renders" count={data.renders.length || undefined} />
      </div>

      {tab === 'source' && <SourceTab />}
      {tab === 'transcript' && <TranscriptTab />}
      {tab === 'moments' && <MomentsTab />}
      {tab === 'clips' && <ClipsTab />}
      {tab === 'renders' && <RendersTab />}
    </div>
  )
}

function TabButton(props: { tab: Tab; setTab: (t: Tab) => void; id: Tab; icon: React.ReactNode; label: string; count?: number }) {
  return (
    <button className={`tab ${props.tab === props.id ? 'active' : ''}`} onClick={() => props.setTab(props.id)}>
      {props.icon} {props.label}
      {props.count != null && <span className="count">{props.count}</span>}
    </button>
  )
}

function Pipeline({ status }: { status: string }) {
  const steps: Array<{ id: string; label: string }> = [
    { id: 'import', label: 'Import' },
    { id: 'transcribe', label: 'Transcribe' },
    { id: 'analyze', label: 'Analyze' },
    { id: 'edit', label: 'Edit & render' }
  ]
  const stateOf = (id: string): 'done' | 'current' | 'error' | '' => {
    switch (id) {
      case 'import':
        if (status === 'import_failed') return 'error'
        if (['created'].includes(status)) return 'current'
        return 'done'
      case 'transcribe':
        if (status === 'transcription_failed') return 'error'
        if (['ready'].includes(status)) return 'current'
        if (status === 'created' || status === 'importing' || status === 'import_failed') return ''
        return 'done'
      case 'analyze':
        if (status === 'analysis_failed') return 'error'
        if (['transcribed', 'transcribing'].includes(status)) return 'current'
        if (status === 'analyzing') return 'current'
        if (['analyzed'].includes(status)) return 'done'
        return ''
      case 'edit':
        return ['analyzed'].includes(status) ? 'current' : ''
      default:
        return ''
    }
  }
  return (
    <div className="pipeline" aria-label="Project pipeline">
      {steps.map((s, i) => (
        <React.Fragment key={s.id}>
          {i > 0 && <span className="pipeline-arrow">→</span>}
          <span className={`pipeline-step ${stateOf(s.id)}`}>{s.label}</span>
        </React.Fragment>
      ))}
    </div>
  )
}
