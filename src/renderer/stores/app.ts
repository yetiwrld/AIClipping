import { create } from 'zustand'
import type { AppInfo, AppSettings, DependencyStatus, ProviderAvailability, Project } from '@shared/types'
import { api, errMessage } from '../api/client'

export type View = 'dashboard' | 'project' | 'editor' | 'queue' | 'settings'

export interface Toast {
  id: number
  level: 'info' | 'success' | 'warn' | 'error'
  message: string
  hint?: string
  code?: string
  actionLabel?: string
  action?: () => void
}

interface AppStore {
  view: View
  projectId: string | null
  editorClipId: string | null
  navigate(view: View, opts?: { projectId?: string | null; clipId?: string | null }): void
  openProject(projectId: string): void
  openEditor(clipId: string, projectId: string): void
  goBack(): { view: View; projectId: string | null } | null

  appInfo: AppInfo | null
  settings: AppSettings | null
  dependencies: DependencyStatus[]
  refreshDependencies(): Promise<void>
  providers: ProviderAvailability[]
  bootstrapped: boolean
  bootstrap(): Promise<void>
  saveSettings(patch: Record<string, unknown>): Promise<boolean>

  toasts: Toast[]
  toast(t: Omit<Toast, 'id'>): void
  dismissToast(id: number): void

  projectUpdated: Project | null
  notifyProjectUpdate(p: Project): void
}

let toastSeq = 1
let lastView: { view: View; projectId: string | null } = { view: 'dashboard', projectId: null }

export const useAppStore = create<AppStore>((set, get) => ({
  view: 'dashboard',
  projectId: null,
  editorClipId: null,

  navigate(view, opts) {
    const current = { view: get().view, projectId: get().projectId }
    if (current.view !== view || current.projectId !== (opts?.projectId ?? null)) {
      lastView = current
    }
    set({ view, projectId: opts?.projectId ?? (view === 'project' || view === 'editor' ? get().projectId : null), editorClipId: view === 'editor' ? opts?.clipId ?? get().editorClipId : null })
  },
  openProject(projectId) {
    lastView = { view: get().view, projectId: get().projectId }
    set({ view: 'project', projectId, editorClipId: null })
  },
  openEditor(clipId, projectId) {
    lastView = { view: 'project', projectId }
    set({ view: 'editor', projectId, editorClipId: clipId })
  },
  goBack() {
    return lastView
  },

  appInfo: null,
  settings: null,
  dependencies: [],
  providers: [],
  bootstrapped: false,

  /** Re-run the dependency probes (e.g. after installing faster-whisper). */
  async refreshDependencies(): Promise<void> {
    try {
      const [dependencies, providers] = await Promise.all([
        api['app.checkDependencies'](),
        api['analysis.providers']()
      ])
      set({ dependencies, providers })
    } catch {
      /* keep the last known state */
    }
  },

  async bootstrap() {
    try {
      const [appInfo, settings, dependencies, providers] = await Promise.all([
        api['app.getInfo'](),
        api['settings.get'](),
        api['app.checkDependencies'](),
        api['analysis.providers']()
      ])
      set({ appInfo, settings, dependencies, providers, bootstrapped: true })
    } catch (err) {
      const { message, hint } = errMessage(err)
      get().toast({ level: 'error', message: `Startup check failed: ${message}`, hint })
      set({ bootstrapped: true })
    }
  },

  async saveSettings(patch) {
    try {
      const settings = await api['settings.update']({ patch })
      set({ settings })
      return true
    } catch (err) {
      const { message, hint } = errMessage(err)
      get().toast({ level: 'error', message, hint })
      return false
    }
  },

  toasts: [],
  toast(t) {
    const id = toastSeq++
    set((s) => ({ toasts: [...s.toasts, { ...t, id }] }))
    const timeout = t.level === 'error' ? 9000 : 5000
    setTimeout(() => get().dismissToast(id), timeout)
  },
  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },

  projectUpdated: null,
  notifyProjectUpdate(project) {
    set({ projectUpdated: project })
  }
}))
