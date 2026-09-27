import fs from 'node:fs'
import path from 'node:path'
import { createServer } from 'node:http'
import express from 'express'
import { createAppContext } from '../src/main/services/app-context'
import { createBackend } from '../src/main/ipc/backend'
import { toStructuredError } from '../src/shared/errors'
import type { AppEvent } from '../src/shared/types'

/**
 * Browser preview server — a development/power-user tool that runs the REAL
 * backend services (same SQLite database, same FFmpeg pipeline, same
 * providers) and serves the built renderer over HTTP (ADR-007).
 *
 *   npm run preview:web
 *
 * The renderer detects it is not inside Electron and switches to the HTTP
 * transport. File picking becomes browser upload; everything else is the
 * genuine application logic.
 */

const PORT = parseInt(process.env.PORT ?? '8787', 10)
const HOST = '0.0.0.0'
const RENDERER_DIR = path.resolve(__dirname, '..', 'out', 'renderer')

async function main(): Promise<void> {
  const settingsHint = process.env.CLIPWRIGHT_WORKSPACE
    ? process.env.CLIPWRIGHT_WORKSPACE
    : path.resolve(__dirname, '..', '.workspace')

  const ctx = await createAppContext({
    workspaceRoot: settingsHint,
    appVersion: require('../package.json').version,
    isElectron: false,
    moduleDir: __dirname
  })

  const backend = createBackend(ctx, null)

  const app = express()
  app.use(express.json({ limit: '2mb' }))

  // ------------------------------------------------------------ invoke ---
  app.post('/api/invoke', async (req, res) => {
    const { method, payload } = (req.body ?? {}) as { method?: string; payload?: unknown }
    if (typeof method !== 'string') {
      res.status(400).json({ ok: false, error: { code: 'VALIDATION_FAILED', message: 'Malformed request.' } })
      return
    }
    try {
      const value = await backend.invoke(method, payload ?? {})
      res.json({ ok: true, value })
    } catch (err) {
      res.status(200).json({ ok: false, error: toStructuredError(err) })
    }
  })

  // ------------------------------------------------------------- events ---
  const sseClients = new Set<import('node:http').ServerResponse>()
  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })
    res.write(':ok\n\n')
    sseClients.add(res)
    req.on('close', () => sseClients.delete(res))
  })
  ctx.events.subscribe((event: AppEvent) => {
    const frame = `data: ${JSON.stringify(event)}\n\n`
    for (const client of sseClients) client.write(frame)
  })

  // ------------------------------------------------- media with ranges ---
  const MIME: Record<string, string> = {
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.png': 'image/png', '.ttf': 'font/ttf'
  }

  function isInsideWorkspace(target: string): boolean {
    const resolvedRoot = path.resolve(ctx.workspaceRoot)
    let resolvedTarget = path.resolve(target)
    try {
      resolvedTarget = fs.realpathSync(resolvedTarget)
    } catch {
      /* keep unresolved */
    }
    const rel = path.relative(resolvedRoot, resolvedTarget)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  }

  app.get('/api/media/stream', (req, res) => {
    const target = req.query.path
    if (typeof target !== 'string' || !isInsideWorkspace(target) || !fs.existsSync(target)) {
      res.status(404).send('Not found')
      return
    }
    const stat = fs.statSync(target)
    if (!stat.isFile()) {
      res.status(404).send('Not found')
      return
    }
    const type = MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream'
    const range = req.headers.range

    if (range) {
      const m = range.match(/bytes=(\d*)-(\d*)/)
      if (m) {
        const start = m[1] ? parseInt(m[1], 10) : 0
        const end = m[2] ? Math.min(parseInt(m[2], 10), stat.size - 1) : stat.size - 1
        if (start <= end && start < stat.size) {
          res.writeHead(206, {
            'Content-Type': type,
            'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges': 'bytes'
          })
          fs.createReadStream(target, { start, end }).pipe(res)
          return
        }
      }
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': String(stat.size), 'Accept-Ranges': 'bytes' })
    fs.createReadStream(target).pipe(res)
  })

  // ------------------------------------------------------------- upload ---
  app.post('/api/upload', (req, res) => {
    const headerFilename = Array.isArray(req.headers['x-filename']) ? req.headers['x-filename'][0] : req.headers['x-filename']
    const filename = decodeURIComponent(headerFilename ?? 'upload.bin').replace(/[^\w.\- ]+/g, '_').slice(-80)
    const dir = path.join(ctx.workspaceRoot, 'cache', 'uploads')
    fs.mkdirSync(dir, { recursive: true })
    const target = path.join(dir, `${Date.now()}-${filename}`)
    const stream = fs.createWriteStream(target)
    req.pipe(stream)
    stream.on('finish', () => res.json({ ok: true, value: { path: target } }))
    stream.on('error', () => res.status(500).json({ ok: false, error: { code: 'UPLOAD_FAILED', message: 'Could not store the uploaded file.' } }))
  })

  // ------------------------------------------------------------ static ---
  app.use(express.static(RENDERER_DIR, { index: 'index.html', fallthrough: true }))
  // SPA fallthrough (Express 5 dropped the '*' wildcard route)
  app.use((_req, res) => {
    res.sendFile(path.join(RENDERER_DIR, 'index.html'))
  })

  const server = createServer(app)
  server.listen(PORT, HOST, () => {
    /* eslint-disable no-console */
    console.log('')
    console.log('  Clipwright Studio — browser preview')
    console.log(`  Serving:     http://localhost:${PORT}`)
    console.log(`  Workspace:   ${ctx.workspaceRoot}`)
    console.log('  Note: this runs the real backend services (SQLite + FFmpeg).')
    console.log('  The desktop app remains the primary product.\n')
  })

  const shutdown = async () => {
    await ctx.shutdown().catch(() => undefined)
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1500).unref()
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

void main().catch((err) => {
  console.error('Preview server failed to start:', err)
  process.exit(1)
})
