import React, { useEffect } from 'react'
import { LayoutGrid, ListVideo, Settings as SettingsIcon, Scissors, X } from 'lucide-react'
import { useAppStore } from './stores/app'
import { useDataStore } from './stores/data'
import { subscribeEvents, isPreview, mediaUrl, api } from './api/client'
import { ToastIcon } from './components/ui'
import { DashboardPage } from './features/dashboard/DashboardPage'
import { ProjectPage } from './features/project/ProjectPage'
import { EditorPage } from './features/editor/EditorPage'
import { QueuePage } from './features/render-queue/QueuePage'
import { SettingsPage } from './features/settings/SettingsPage'
import { FirstRunModal } from './features/onboarding/FirstRunModal'

export function App() {
  const { view, navigate, bootstrap, bootstrapped, settings } = useAppStore()
  const data = useDataStore()
  const toasts = useAppStore((s) => s.toasts)
  const toast = useAppStore((s) => s.toast)
  const dismissToast = useAppStore((s) => s.dismissToast)

  useEffect(() => {
    void bootstrap()
    void data.refreshProjects()
    void data.loadRenders()
    void data.loadTasks()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    // Load bundled caption fonts through the media protocol so the editor
    // preview matches the rendered output exactly (ADR-009).
    void (async () => {
      try {
        for (const file of ['Inter_400Regular.ttf', 'Inter_700Bold.ttf', 'Inter_900Black.ttf']) {
          const { path } = await api['system.fontUrl']({ file })
          const face = new FontFace('Inter', `url(${mediaUrl(path)})`)
          await face.load()
          document.fonts.add(face)
        }
      } catch {
        /* preview falls back to system fonts */
      }
    })()
  }, [])

  useEffect(() => {
    const unsubscribe = subscribeEvents((event) => {
      useDataStore.getState().handleEvent(event)
    })
    return unsubscribe
  }, [])

  // Notify when a project finishes processing (import/transcribe/analyze)
  useEffect(() => {
    const unsub = useAppStore.subscribe((state, prev) => {
      const project = state.projectUpdated
      if (project && project !== prev.projectUpdated) {
        if (project.status === 'ready' && prev.projectUpdated?.status === 'importing') {
          toast({ level: 'success', message: `Media imported: ${project.sourceFilename ?? project.name}` })
        }
      }
    })
    return unsub
  }, [toast])

  const activeRenders = data.renders.filter((r) => r.status === 'rendering' || r.status === 'preparing' || r.status === 'queued').length
  const interrupted = data.tasks.filter((t) => t.state === 'interrupted').length

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Scissors size={16} />
          </div>
          <div>
            <div className="brand-name">Clipwright</div>
            <div className="brand-sub">Studio</div>
          </div>
        </div>

        <button className={`nav-item ${view === 'dashboard' ? 'active' : ''}`} onClick={() => navigate('dashboard')}>
          <LayoutGrid size={16} /> Projects
        </button>
        <button className={`nav-item ${view === 'queue' ? 'active' : ''}`} onClick={() => navigate('queue')}>
          <ListVideo size={16} /> Render queue
          {activeRenders > 0 && <span className="nav-badge">{activeRenders}</span>}
        </button>
        {interrupted > 0 && (
          <button className="nav-item" onClick={() => navigate('queue')} title="Interrupted processing detected">
            <span className="chip warn" style={{ fontSize: 10.5 }}>{interrupted} to recover</span>
          </button>
        )}
        <button className={`nav-item ${view === 'settings' ? 'active' : ''}`} onClick={() => navigate('settings')}>
          <SettingsIcon size={16} /> Settings
        </button>

        <div className="sidebar-footer">
          {isPreview && <div style={{ color: 'var(--warn)' }}>Browser preview · full app runs on the desktop</div>}
          <div>v{useAppStore.getState().appInfo?.version ?? '…'}</div>
          <div style={{ wordBreak: 'break-all' }}>{useAppStore.getState().appInfo?.workspaceRoot}</div>
        </div>
      </aside>

      <main className="main-area">
        {view === 'dashboard' && <DashboardPage />}
        {view === 'project' && <ProjectPage />}
        {view === 'editor' && <EditorPage />}
        {view === 'queue' && <QueuePage />}
        {view === 'settings' && <SettingsPage />}
      </main>

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.level}`} role="status">
            <ToastIcon level={t.level} />
            <div className="toast-msg">
              {t.message}
              {t.hint && <div className="toast-hint">{t.hint}</div>}
            </div>
            {t.action && (
              <button
                className="btn sm"
                onClick={() => {
                  t.action?.()
                  dismissToast(t.id)
                }}
              >
                {t.actionLabel}
              </button>
            )}
            <button className="toast-close" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
              <X size={13} />
            </button>
          </div>
        ))}
      </div>

      {bootstrapped && settings && !settings.general.firstRunCompleted && <FirstRunModal />}
    </div>
  )
}
