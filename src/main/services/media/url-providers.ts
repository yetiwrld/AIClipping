import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { spawn } from 'node:child_process'
import { AppError } from '@shared/errors'
import { whichSync } from './ffmpeg'

/**
 * VideoSourceProvider — modular URL ingestion (spec §11).
 *
 * Two implementations:
 *  - DirectHttpProvider: direct media URLs (mp4/webm/mov/…). Verifies the
 *    content type before saving, streams to a .part file, supports cancel.
 *  - YtDlpProvider: uses a *user-installed* yt-dlp binary for sites that
 *    need it. The app never installs or downloads yt-dlp itself; if it is
 *    absent the UI explains how the user can install it. Users are
 *    responsible for having the rights to download the content.
 */

export interface SourceMeta {
  title: string | null
  duration: number | null
  estimatedSize: number | null
  provider: string
}

export interface DownloadEvents {
  onProgress?: (downloaded: number, total: number | null) => void
  signal?: AbortSignal
}

export interface VideoSourceProvider {
  id: string
  label: string
  canHandle(url: string): boolean
  fetchMeta(url: string, signal?: AbortSignal): Promise<SourceMeta | null>
  download(url: string, destPath: string, events: DownloadEvents): Promise<void>
}

export function parseUrlSafe(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new AppError('URL_INVALID', 'That does not look like a valid URL.', 'Paste a full URL starting with http:// or https://')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError('URL_SCHEME_UNSUPPORTED', 'Only http and https URLs are supported.', 'For local files, use "Import file" instead.')
  }
  return url
}

const DIRECT_MEDIA_EXTENSIONS = ['.mp4', '.mov', '.mkv', '.webm', '.m4v', '.mpg', '.mpeg', '.avi', '.mp3', '.m4a', '.wav', '.ogg', '.flac']

export class DirectHttpProvider implements VideoSourceProvider {
  id = 'direct-http'
  label = 'Direct media URL'

  canHandle(url: string): boolean {
    try {
      const u = parseUrlSafe(url)
      const ext = path.extname(u.pathname).toLowerCase()
      return DIRECT_MEDIA_EXTENSIONS.includes(ext)
    } catch {
      return false
    }
  }

  async fetchMeta(url: string, signal?: AbortSignal): Promise<SourceMeta | null> {
    const u = parseUrlSafe(url)
    try {
      const res = await fetch(u, { method: 'HEAD', signal, redirect: 'follow' })
      const type = res.headers.get('content-type') ?? ''
      const len = parseInt(res.headers.get('content-length') ?? '', 10)
      return {
        title: path.basename(decodeURIComponent(u.pathname)) || null,
        duration: null,
        estimatedSize: Number.isFinite(len) ? len : null,
        provider: this.id
      }
      void type
    } catch {
      // HEAD not supported → meta unknown; the download itself will still try
      return { title: path.basename(decodeURIComponent(u.pathname)) || null, duration: null, estimatedSize: null, provider: this.id }
    }
  }

  async download(url: string, destPath: string, events: DownloadEvents): Promise<void> {
    const u = parseUrlSafe(url)
    fs.mkdirSync(path.dirname(destPath), { recursive: true })
    const partPath = `${destPath}.part`

    let res: Response
    try {
      res = await fetch(u, { signal: events.signal, redirect: 'follow' })
    } catch (err) {
      throw new AppError(
        'DOWNLOAD_FAILED',
        `The URL could not be reached (${u.host}).`,
        'Check your internet connection and the URL. If the site requires a login, download the file manually and use "Import file".',
        String(err)
      )
    }
    if (!res.ok || !res.body) {
      throw new AppError(
        'DOWNLOAD_HTTP_ERROR',
        `The server responded with HTTP ${res.status}.`,
        res.status === 404
          ? 'The file does not exist at this address. Verify the link.'
          : res.status === 403 || res.status === 401
            ? 'The server refused the download. The content may require authentication or hotlink protection.'
            : 'The server may be having problems, or the link may be wrong.',
        `HTTP ${res.status}`
      )
    }

    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    const looksLikeMedia =
      type.startsWith('video/') || type.startsWith('audio/') || type === 'application/octet-stream' || type === ''
    if (!looksLikeMedia) {
      throw new AppError(
        'URL_NOT_MEDIA',
        `That URL returns "${type || 'unknown content'}", which is not a media file.`,
        'This looks like a web page, not a direct video link. Copy the direct file URL, or install yt-dlp (Settings → Transcription/Advanced) to import from video sites.'
      )
    }

    const total = parseInt(res.headers.get('content-length') ?? '', 10)
    let downloaded = 0
    const nodeStream = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream)
    const out = fs.createWriteStream(partPath)
    let lastReport = 0
    nodeStream.on('data', (chunk: Buffer) => {
      downloaded += chunk.length
      const now = Date.now()
      if (now - lastReport > 200) {
        lastReport = now
        events.onProgress?.(downloaded, Number.isFinite(total) ? total : null)
      }
    })
    await new Promise<void>((resolve, reject) => {
      nodeStream.on('error', reject)
      out.on('error', reject)
      out.on('finish', resolve)
      nodeStream.pipe(out)
    })
    events.onProgress?.(downloaded, Number.isFinite(total) ? total : null)
    if (fs.existsSync(destPath)) fs.unlinkSync(destPath)
    fs.renameSync(partPath, destPath)
  }
}

export class YtDlpProvider implements VideoSourceProvider {
  id = 'yt-dlp'
  label = 'yt-dlp (installed on your system)'
  private binary: string | null = null

  constructor() {
    this.binary = whichSync('yt-dlp') ?? whichSync('yt-dlp.exe') ?? null
  }

  isInstalled(): boolean {
    return this.binary != null
  }

  canHandle(url: string): boolean {
    return this.isInstalled()
  }

  async fetchMeta(url: string): Promise<SourceMeta | null> {
    if (!this.binary) return null
    const child = spawn(this.binary, ['-J', '--no-warnings', url], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    const timer = setTimeout(() => child.kill(), 30000)
    child.stdout.on('data', (d) => (out += d.toString()))
    await new Promise<void>((resolve) => child.on('close', resolve))
    clearTimeout(timer)
    try {
      const info = JSON.parse(out)
      return {
        title: typeof info.title === 'string' ? info.title : null,
        duration: typeof info.duration === 'number' ? info.duration : null,
        estimatedSize: null,
        provider: this.id
      }
    } catch {
      return null
    }
  }

  async download(url: string, destPath: string, events: DownloadEvents): Promise<void> {
    if (!this.binary) {
      throw new AppError('YTDLP_MISSING', 'yt-dlp is not installed on this system.', 'Install yt-dlp from its official site and make sure it is on your PATH, or import the file directly.')
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true })
    const args = [
      '-f', 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '-o', destPath,
      '--newline',
      '--no-playlist',
      url
    ]
    const child = spawn(this.binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    events.signal?.addEventListener('abort', () => child.kill('SIGTERM'), { once: true })
    let stderr = ''
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.stdout.on('data', (d) => {
      const m = d.toString().match(/\[download\]\s+([\d.]+)%/)
      if (m) events.onProgress?.(parseFloat(m[1]) / 100, 1)
    })
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
    if (events.signal?.aborted) throw new AppError('DOWNLOAD_CANCELLED', 'The download was cancelled.')
    if (code !== 0) {
      const tmp = `${destPath}.part`
      for (const p of [tmp, `${destPath}.part.part`]) {
        try {
          if (fs.existsSync(p)) fs.unlinkSync(p)
        } catch { /* best effort */ }
      }
      throw new AppError(
        'YTDLP_FAILED',
        'yt-dlp could not download this URL.',
        'The video may be private, region-locked, or require sign-in. Make sure you have the right to download it.',
        stderr.slice(-1500)
      )
    }
    if (!fs.existsSync(destPath)) {
      // yt-dlp may have picked a different container name
      const dir = path.dirname(destPath)
      const files = fs.readdirSync(dir).filter((f) => f.startsWith(path.basename(destPath, path.extname(destPath))))
      if (files.length > 0) {
        fs.renameSync(path.join(dir, files[0]), destPath)
      } else {
        throw new AppError('YTDLP_NO_OUTPUT', 'yt-dlp finished but produced no file.', undefined, stderr.slice(-1000))
      }
    }
  }
}

/**
 * Pre-flight check (no side effects): can any installed provider import
 * this URL, and if not, why? Used by media.checkUrl (UI hint) and to fail
 * media.importUrl fast, before a background task is ever created.
 */
export function checkUrlProviders(rawUrl: string): {
  ok: boolean
  provider: string | null
  label: string | null
  reason: string | null
  hint: string | null
} {
  let parsed: URL
  try {
    parsed = parseUrlSafe(rawUrl)
  } catch (err) {
    const e = err as AppError
    return { ok: false, provider: null, label: null, reason: e.message, hint: e.hint ?? null }
  }
  const providers = getSourceProviders()
  const provider = providers.find((p) => p.canHandle(rawUrl))
  if (provider) {
    return { ok: true, provider: provider.id, label: provider.label, reason: null, hint: null }
  }
  const ytdlp = providers.find((p) => p.id === 'yt-dlp') as { isInstalled(): boolean } | undefined
  const ext = path.extname(parsed.pathname).toLowerCase()
  const looksLikePage = ext === '' || ['.html', '.htm', '.php', '.asp', '.aspx'].includes(ext)
  return {
    ok: false,
    provider: null,
    label: null,
    reason: ytdlp && !ytdlp.isInstalled()
      ? 'This looks like a web page link, not a direct media file — it needs yt-dlp, which is not installed.'
      : 'No available provider can import this URL.',
    hint: ytdlp && !ytdlp.isInstalled()
      ? looksLikePage
        ? 'Paste a direct link to the video file (ends in .mp4/.webm/…), or install yt-dlp and put it on your PATH to import from video sites. Only download content you have the right to use.'
        : 'Install yt-dlp and make sure it is on your PATH, then retry.'
      : 'Use a direct link to a media file (.mp4, .webm, …).'
  }
}

export function getSourceProviders(): VideoSourceProvider[] {
  return [new YtDlpProvider(), new DirectHttpProvider()]
}

export async function fetchUrlMeta(url: string): Promise<SourceMeta | null> {
  const providers = getSourceProviders()
  for (const provider of providers) {
    if (!provider.canHandle(url)) continue
    try {
      const meta = await provider.fetchMeta(url)
      if (meta) return meta
    } catch {
      /* try next provider */
    }
  }
  return null
}
