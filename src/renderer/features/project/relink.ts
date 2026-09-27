import { api, errMessage, isElectron } from '../../api/client'
import { pickUpload } from '../../api/upload'
import { useDataStore } from '../../stores/data'
import type { Project } from '@shared/types'

/**
 * Shared source-relink flow (§13-14): used by the Source tab and the Clip
 * Editor. Picks a replacement for a moved source file, relinks the project,
 * and refreshes stores. Mismatched files are rejected by the backend with
 * specifics — the UI never silently substitutes a different video.
 */

type AppStore = {
  toast(t: { level: 'info' | 'success' | 'warn' | 'error'; message: string; hint?: string; actionLabel?: string; action?: () => void }): void
}

export async function relinkProjectSource(app: AppStore, projectId: string): Promise<boolean> {
  try {
    let filePath: string | null = null
    if (isElectron) {
      const picked = await api['media.pickSourceFile']()
      filePath = picked.filePath
    } else {
      filePath = await pickUpload(['video/*', 'audio/*', '.mkv', '.webm'])
    }
    if (!filePath) return false
    const updated = await api['projects.relinkSource']({ id: projectId, filePath })
    useDataStore.setState((s) => ({
      activeProject: s.activeProject?.id === updated.id ? updated : s.activeProject
    }))
    await useDataStore.getState().loadProject(projectId)
    await useDataStore.getState().refreshProjects()
    app.toast({
      level: 'success',
      message: 'Source relinked.',
      hint: 'The project now points at the new file location — nothing else changed.'
    })
    return true
  } catch (err) {
    app.toast({ level: 'error', ...errMessage(err) })
    return false
  }
}

export type { Project }
