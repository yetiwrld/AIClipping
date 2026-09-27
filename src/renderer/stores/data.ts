import { create } from 'zustand'
import type {
  AppEvent, Clip, ClipCandidate, Project, ProjectStorage, ProjectSummary, RenderJob, TaskInfo, TranscriptSegment
} from '@shared/types'
import { api } from '../api/client'
import { useAppStore } from './app'

/**
 * Working data for the currently open project + the global render queue and
 * task list. Backend events (project:update, render:progress, render:state,
 * task:update) mutate this store directly so the UI stays live without
 * polling.
 */

interface DataStore {
  projects: ProjectSummary[]
  projectsLoaded: boolean
  refreshProjects(): Promise<void>

  activeProject: Project | null
  loadProject(id: string): Promise<Project | null>

  transcript: TranscriptSegment[]
  transcriptLoaded: boolean
  loadTranscript(projectId: string): Promise<void>

  candidates: ClipCandidate[]
  candidatesLoaded: boolean
  loadCandidates(projectId: string): Promise<void>

  clips: Clip[]
  loadClips(projectId: string): Promise<void>

  renders: RenderJob[]
  rendersLoaded: boolean
  loadRenders(projectId?: string): Promise<void>

  tasks: TaskInfo[]
  loadTasks(projectId?: string): Promise<void>

  storage: ProjectStorage | null
  loadStorage(projectId: string): Promise<void>

  handleEvent(event: AppEvent): void
}

export const useDataStore = create<DataStore>((set, get) => ({
  projects: [],
  projectsLoaded: false,

  async refreshProjects() {
    try {
      const projects = await api['projects.list']()
      set({ projects, projectsLoaded: true })
    } catch {
      set({ projectsLoaded: true })
    }
  },

  activeProject: null,
  async loadProject(id) {
    const project = await api['projects.get']({ id })
    set({ activeProject: project, transcript: [], transcriptLoaded: false, candidates: [], candidatesLoaded: false, clips: [], renders: [], storage: null })
    if (project) {
      void get().loadTranscript(id)
      void get().loadCandidates(id)
      void get().loadClips(id)
      void get().loadRenders(id)
      void get().loadStorage(id)
    }
    return project
  },

  transcript: [],
  transcriptLoaded: false,
  async loadTranscript(projectId) {
    try {
      const transcript = await api['transcript.get']({ projectId })
      set({ transcript, transcriptLoaded: true })
    } catch {
      set({ transcriptLoaded: true })
    }
  },

  candidates: [],
  candidatesLoaded: false,
  async loadCandidates(projectId) {
    try {
      const candidates = await api['analysis.getCandidates']({ projectId })
      set({ candidates, candidatesLoaded: true })
    } catch {
      set({ candidatesLoaded: true })
    }
  },

  clips: [],
  async loadClips(projectId) {
    const clips = await api['clips.list']({ projectId })
    set({ clips })
  },

  renders: [],
  rendersLoaded: false,
  async loadRenders(projectId) {
    const renders = await api['renders.list'](projectId ? { projectId } : {})
    set({ renders, rendersLoaded: true })
  },

  tasks: [],
  async loadTasks(projectId) {
    const tasks = await api['tasks.list'](projectId ? { projectId } : {})
    set({ tasks })
  },

  storage: null,
  async loadStorage(projectId) {
    try {
      const storage = await api['projects.storage']({ id: projectId })
      set({ storage })
    } catch {
      set({ storage: null })
    }
  },

  handleEvent(event) {
    switch (event.type) {
      case 'project:update': {
        const project = event.project
        set((s) => ({
          activeProject: s.activeProject?.id === project.id ? project : s.activeProject,
          projects: s.projects.map((p) => (p.id === project.id ? { ...p, ...project, candidateCount: p.candidateCount, clipCount: p.clipCount, renderCount: p.renderCount, thumbnail: p.thumbnail } : p))
        }))
        break
      }
      case 'task:update': {
        const task = event.task
        set((s) => {
          const existing = s.tasks.findIndex((t) => t.id === task.id)
          const tasks = existing === -1 ? [task, ...s.tasks] : s.tasks.map((t) => (t.id === task.id ? task : t))
          return { tasks }
        })
        // B-012: background task failures (e.g. a URL import that needs
        // yt-dlp) were silent — the reason only lived on the task row.
        if (task.state === 'failed' && task.error) {
          useAppStore.getState().toast({
            level: 'error',
            message: `${task.type === 'download' ? 'Import' : task.type} failed: ${task.error.message}`,
            hint: task.error.hint ?? undefined
          })
        }
        break
      }
      case 'render:progress': {
        set((s) => ({
          renders: s.renders.map((r) =>
            r.id === event.renderId ? { ...r, progress: event.progress, stage: event.stage, status: 'rendering' } : r
          )
        }))
        break
      }
      case 'render:state': {
        const render = event.render
        set((s) => {
          const existing = s.renders.findIndex((r) => r.id === render.id)
          const renders = existing === -1 ? [render, ...s.renders] : s.renders.map((r) => (r.id === render.id ? render : r))
          return { renders }
        })
        break
      }
    }
  }
}))
