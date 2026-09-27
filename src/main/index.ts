import path from 'node:path'
import fs from 'node:fs'
import { Readable } from 'node:stream'
import { app, BrowserWindow, ipcMain, dialog, shell, clipboard, protocol, safeStorage, net } from 'electron'
import { createAppContext } from './services/app-context'
import { createBackend, type Backend } from './ipc/backend'
import { toStructuredError } from '@shared/errors'

/**
 * Electron bootstrap. This is the ONLY file that imports Electron —
 * everything below the backend boundary is plain Node and shared with the
 * browser preview server and the test suite (ADR-007).
 */

// The workspace directory name is configuration, not a hard-coded product
// identity (spec §8). Override with CLIPWRIGHT_WORKSPACE for dev/tests.
const WORKSPACE_DIR_NAME = 'ClipwrightStudio'

let mainWindow: BrowserWindow | null = null
let backend: Backend | null = null

// The media protocol must be registered as privileged before app ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'clipwright-media',
    privileges: { bypassCSP: false, stream: true, supportFetchAPI: true }
  }
])

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(bootstrap)
}

async function bootstrap(): Promise<void> {
  const workspaceRoot =
    process.env.CLIPWRIGHT_WORKSPACE ?? path.join(app.getPath('userData'), WORKSPACE_DIR_NAME)

  const secretCodec = safeStorage.isEncryptionAvailable()
    ? {
        encrypt: (plain: string) => {
          try {
            return `enc:${safeStorage.encryptString(plain).toString('base64')}`
          } catch {
            return null
          }
        },
        decrypt: (payload: string) => {
          if (!payload.startsWith('enc:')) return null
          try {
            return safeStorage.decryptString(Buffer.from(payload.slice(4), 'base64'))
          } catch {
            return null
          }
        }
      }
    : undefined

  const ctx = await createAppContext({
    workspaceRoot,
    appVersion: app.getVersion(),
    isElectron: true,
    moduleDir: __dirname,
    secretCodec
  })

  backend = createBackend(ctx, {
    pickFile: async (filters) => {
      const result = await dialog.showOpenDialog(mainWindow as BrowserWindow, {
        properties: ['openFile'],
        filters
      })
      return result.canceled ? null : result.filePaths[0] ?? null
    },
    revealPath: async (target) => {
      if (fs.existsSync(target)) shell.showItemInFolder(target)
    },
    copyToClipboard: async (text) => {
      clipboard.writeText(text)
    },
    openLogsFolder: async () => {
      await shell.openPath(ctx.paths.logsDir)
    },
    isPathInsideWorkspace: (target) => isInsideWorkspace(ctx.workspaceRoot, target)
  })

  registerMediaProtocol(ctx.workspaceRoot)
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}

function isInsideWorkspace(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root)
  let resolvedTarget = path.resolve(target)
  try {
    resolvedTarget = fs.realpathSync(resolvedTarget)
  } catch {
    /* keep unresolved — existence checked elsewhere */
  }
  const rel = path.relative(resolvedRoot, resolvedTarget)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * clipwright-media://local/<encoded-abs-path>
 * Streams workspace files with HTTP Range support. Only paths inside the
 * workspace are served — no arbitrary filesystem reads (ADR-010).
 */
function registerMediaProtocol(workspaceRoot: string): void {
  const mimeByExt: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
    '.avi': 'video/x-msvideo',
    '.wmv': 'video/x-ms-wmv',
    '.flv': 'video/x-flv',
    '.ts': 'video/mp2t',
    '.mpg': 'video/mpeg',
    '.mpeg': 'video/mpeg',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.oga': 'audio/ogg',
    '.opus': 'audio/ogg',
    '.flac': 'audio/flac',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.ttf': 'font/ttf'
  }

  protocol.handle('clipwright-media', (request) => {
    return handleMediaRequest(request, workspaceRoot, mimeByExt)
  })
}

async function handleMediaRequest(
  request: Request,
  workspaceRoot: string,
  mimeByExt: Record<string, string>
): Promise<Response> {
  let target: string
  let wantsProxy = false
  try {
    const url = new URL(request.url)
    target = decodeURIComponent(url.pathname.slice(1))
    // ?proxy=1 swaps in the transcoded preview copy when it exists (§8) —
    // used for codecs Chromium cannot decode directly. Renders always read
    // the ORIGINAL file; this only affects preview playback.
    if (url.searchParams.get('proxy') === '1' && path.basename(target).startsWith('source.')) {
      wantsProxy = true
    }
  } catch {
    return new Response('Bad request', { status: 400 })
  }
  if (wantsProxy) {
    const proxy = path.join(path.dirname(target), 'proxy.mp4')
    if (fs.existsSync(proxy) && fs.statSync(proxy).isFile()) target = proxy
  }
  if (!target || !isInsideWorkspace(workspaceRoot, target) || !fs.existsSync(target)) {
    return new Response('Not found', { status: 404 })
  }
  const stat = fs.statSync(target)
  if (!stat.isFile()) return new Response('Not found', { status: 404 })

  const type = mimeByExt[path.extname(target).toLowerCase()] ?? 'application/octet-stream'
  const range = request.headers.get('range')

  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/)
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0
      const end = m[2] ? Math.min(parseInt(m[2], 10), stat.size - 1) : stat.size - 1
      if (start <= end && start < stat.size) {
        const stream = fs.createReadStream(target, { start, end })
        return new Response(Readable.toWeb(stream) as ReadableStream, {
          status: 206,
          headers: {
            'Content-Type': type,
            'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges': 'bytes'
          }
        })
      }
    }
  }

  const stream = fs.createReadStream(target)
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: {
      'Content-Type': type,
      'Content-Length': String(stat.size),
      'Accept-Ranges': 'bytes'
    }
  })
}

function registerIpc(): void {
  ipcMain.handle('api:invoke', async (_event, args: { method: string; payload?: unknown }) => {
    if (!backend) return { ok: false, error: { code: 'NOT_READY', message: 'The backend is still starting.' } as const }
    if (!args || typeof args.method !== 'string') {
      return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'Malformed request.' } }
    }
    try {
      const value = await backend.invoke(args.method, args.payload ?? {})
      return { ok: true as const, value }
    } catch (err) {
      return { ok: false as const, error: toStructuredError(err) }
    }
  })

  backend?.ctx.events.subscribe((event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:event', event)
    }
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#0a0c10',
    title: 'Clipwright Studio',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  // Block navigation away from the app origin; open external links in the
  // system browser (SECURITY.md).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    const isLocal = url.startsWith('file://') || (devUrl ? url.startsWith(devUrl) : false)
    if (!isLocal) {
      event.preventDefault()
      if (url.startsWith('http')) void shell.openExternal(url)
    }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (backend) {
    event.preventDefault()
    const b = backend
    backend = null
    void b.ctx
      .shutdown()
      .catch(() => undefined)
      .finally(() => app.quit())
  }
})
