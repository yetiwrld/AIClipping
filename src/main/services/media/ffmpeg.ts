import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { AppError } from '@shared/errors'

/**
 * FFmpeg / FFprobe resolution + subprocess helpers.
 * Order: user setting → system PATH → bundled installer binary (ADR-002).
 */

export interface BinaryInfo {
  path: string
  source: 'setting' | 'path' | 'bundled'
  version: string | null
}

export function whichSync(name: string): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext)
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          if (process.platform !== 'win32') {
            fs.accessSync(candidate, fs.constants.X_OK)
          }
          return candidate
        }
      } catch {
        /* keep scanning */
      }
    }
  }
  return null
}

function bundled(installer: { path: string } | null | undefined): string | null {
  const p = installer?.path
  if (p && fs.existsSync(p)) return p
  return null
}

async function probeVersion(binary: string, args: string[]): Promise<string | null> {
  try {
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'ignore'] })
      let data = ''
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error('timeout'))
      }, 8000)
      child.stdout.on('data', (d) => (data += d.toString()))
      child.on('error', reject)
      child.on('close', () => {
        clearTimeout(timer)
        resolve(data)
      })
    })
    const m = out.match(/version\s+(\S+)/i)
    return m ? m[1] : null
  } catch {
    return null
  }
}

export async function resolveFfmpeg(overridePath?: string): Promise<BinaryInfo | null> {
  let info: BinaryInfo | null = null
  if (overridePath && overridePath.trim()) {
    if (fs.existsSync(overridePath)) info = { path: overridePath, source: 'setting', version: null }
  }
  if (!info) {
    const onPath = whichSync('ffmpeg')
    if (onPath) info = { path: onPath, source: 'path', version: null }
  }
  if (!info) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const installer = safeRequire('@ffmpeg-installer/ffmpeg') as { path: string } | null
    const p = bundled(installer)
    if (p) info = { path: p, source: 'bundled', version: null }
  }
  if (!info) return null
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(info.path, 0o755)
    } catch {
      /* best effort */
    }
  }
  info.version = await probeVersion(info.path, ['-version'])
  return info
}

export async function resolveFfprobe(overridePath?: string): Promise<BinaryInfo | null> {
  let info: BinaryInfo | null = null
  if (overridePath && overridePath.trim()) {
    if (fs.existsSync(overridePath)) info = { path: overridePath, source: 'setting', version: null }
  }
  if (!info) {
    const onPath = whichSync('ffprobe')
    if (onPath) info = { path: onPath, source: 'path', version: null }
  }
  if (!info) {
    const installer = safeRequire('@ffprobe-installer/ffprobe') as { path: string } | null
    const p = bundled(installer)
    if (p) info = { path: p, source: 'bundled', version: null }
  }
  if (!info) return null
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(info.path, 0o755)
    } catch {
      /* best effort */
    }
  }
  info.version = await probeVersion(info.path, ['-version'])
  return info
}

function safeRequire(id: string): unknown {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(id)
  } catch {
    return null
  }
}

export interface RunProcessResult {
  code: number
  stdout: string
  stderr: string
}

export function runProcess(
  binary: string,
  args: string[],
  opts: { onStdout?: (chunk: string) => void; onStderr?: (chunk: string) => void; signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<RunProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let killed = false

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          killed = true
          child.kill('SIGKILL')
        }, opts.timeoutMs)
      : null

    child.stdout.on('data', (d) => {
      const s = d.toString()
      stdout += s
      if (stdout.length > 4_000_000) stdout = stdout.slice(-2_000_000)
      opts.onStdout?.(s)
    })
    child.stderr.on('data', (d) => {
      const s = d.toString()
      stderr += s
      if (stderr.length > 400_000) stderr = stderr.slice(-200_000)
      opts.onStderr?.(s)
    })
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      reject(new AppError('PROCESS_SPAWN_FAILED', `Could not start "${path.basename(binary)}".`, 'Check the binary path in Settings → Advanced.', String(err)))
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if (opts.signal?.aborted || killed) {
        reject(new AppError('PROCESS_CANCELLED', 'The operation was cancelled.'))
        return
      }
      resolve({ code: code ?? -1, stdout, stderr })
    })

    opts.signal?.addEventListener(
      'abort',
      () => {
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), 5000)
      },
      { once: true }
    )
  })
}

/** Escape a path for use inside an FFmpeg filtergraph argument. */
export function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
}
