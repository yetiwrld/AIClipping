import { contextBridge, ipcRenderer } from 'electron'

/**
 * The preload bridge is the ONLY surface between the renderer and the
 * privileged backend: a generic validated invoke + a typed event
 * subscription. No raw ipcRenderer, no Node APIs, no filesystem exposure.
 */

const api = {
  invoke(method: string, payload: unknown): Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string; message: string; hint?: string; details?: string } }> {
    return ipcRenderer.invoke('api:invoke', { method, payload })
  },
  onEvent(callback: (event: unknown) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload)
    ipcRenderer.on('app:event', listener)
    return () => {
      ipcRenderer.removeListener('app:event', listener)
    }
  }
}

contextBridge.exposeInMainWorld('clipwright', api)
