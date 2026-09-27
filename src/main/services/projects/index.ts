import fs from 'node:fs'
import path from 'node:path'
import { AppError } from '@shared/errors'
import type { Project, ProjectSettings, ProjectStorage, ProjectSummary } from '@shared/types'
import type { AppContext } from '../app-context'
import { projectsRepo, projectSummaries, segmentsRepo, resolveDurationPreset } from '../database/repositories'
import { getBinaries, inspectMedia, isSupportedMediaFile } from '../media/inspect'
import { generateThumbnail } from '../media/thumbnails'
import { getSourceProviders, fetchUrlMeta, parseUrlSafe } from '../media/url-providers'

/**
 * Project lifecycle: create/list/get/rename/delete, media import (file or
 * URL), storage stats. All on-disk state lives under the project directory;
 * originals are copied in and never modified (spec §50).
 */

function streamCopy(from: string, to: string, onProgress?: (copied: number, total: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const total = fs.statSync(from).size
    fs.mkdirSync(path.dirname(to), { recursive: true })
    const read = fs.createReadStream(from)
    const write = fs.createWriteStream(to)
    let copied = 0
    let last = 0
    read.on('data', (chunk) => {
      copied += chunk.length
      const now = Date.now()
      if (now - last > 150) {
        last = now
        onProgress?.(copied, total)
      }
    })
    read.on('error', reject)
    write.on('error', reject)
    write.on('finish', () => {
      onProgress?.(total, total)
      resolve()
    })
    read.pipe(write)
  })
}

function ensureProjectDirs(ctx: AppContext, projectId: string): void {
  const base = ctx.projectDir(projectId)
  for (const sub of ['source', 'transcription', 'analysis', 'clips', 'renders', 'thumbnails', 'cache', 'logs']) {
    fs.mkdirSync(path.join(base, sub), { recursive: true })
  }
}

export function createProject(ctx: AppContext, name: string): Project {
  const trimmed = name.trim() || 'Untitled project'
  const id = crypto.randomUUID()
  ensureProjectDirs(ctx, id)
  const settings: ProjectSettings = { durationPreset: 'medium', maxCandidates: 8 }
  const project = projectsRepo.create(ctx.db, id, trimmed, settings)
  projectsRepo.writeProjectJson(ctx, project)
  ctx.events.publish({ type: 'project:update', project })
  ctx.logger.info('projects', 'create', `id=${id} name="${trimmed}"`)
  return project
}

export function listProjects(ctx: AppContext): ProjectSummary[] {
  const projects = projectsRepo.list(ctx.db)
  const summaries = projectSummaries(ctx.db, projects)
  return summaries.map((s) => {
    const thumb = path.join(ctx.projectDir(s.id), 'thumbnails', 'source.jpg')
    return { ...s, thumbnail: fs.existsSync(thumb) ? thumb : null }
  })
}

export function getProject(ctx: AppContext, id: string): Project | null {
  return projectsRepo.get(ctx.db, id)
}

export function renameProject(ctx: AppContext, id: string, name: string): Project {
  const project = projectsRepo.get(ctx.db, id)
  if (!project) throw new AppError('PROJECT_NOT_FOUND', 'That project no longer exists.')
  projectsRepo.update(ctx.db, id, { name: name.trim() || project.name })
  const updated = projectsRepo.get(ctx.db, id) as Project
  projectsRepo.writeProjectJson(ctx, updated)
  ctx.events.publish({ type: 'project:update', project: updated })
  return updated
}

export function deleteProject(ctx: AppContext, id: string, confirm: boolean): void {
  const project = projectsRepo.get(ctx.db, id)
  if (!project) return
  if (!confirm) {
    throw new AppError(
      'CONFIRMATION_REQUIRED',
      `Deleting "${project.name}" permanently removes its imported source, transcripts, clips and renders from this workspace.`,
      'Confirm the deletion to continue. Exported files in the exports folder are kept.'
    )
  }
  ctx.db.transaction(() => {
    projectsRepo.delete(ctx.db, id)
  })
  try {
    fs.rmSync(ctx.projectDir(id), { recursive: true, force: true })
  } catch (err) {
    ctx.logger.warn('projects', 'delete', `could not remove directory for ${id}`, String(err))
  }
  ctx.logger.info('projects', 'delete', `id=${id}`)
}

export function updateProjectSettings(ctx: AppContext, id: string, patch: Partial<ProjectSettings>): Project {
  const project = projectsRepo.get(ctx.db, id)
  if (!project) throw new AppError('PROJECT_NOT_FOUND', 'That project no longer exists.')
  const settings: ProjectSettings = {
    durationPreset: resolveDurationPreset(patch.durationPreset ?? project.settings.durationPreset),
    maxCandidates: Math.min(40, Math.max(1, patch.maxCandidates ?? project.settings.maxCandidates))
  }
  projectsRepo.update(ctx.db, id, { settings: JSON.stringify(settings) })
  const updated = projectsRepo.get(ctx.db, id) as Project
  projectsRepo.writeProjectJson(ctx, updated)
  return updated
}

// ------------------------------------------------------------------ import --

export interface ImportProgress {
  (stage: string, progress: number | null, message: string): void
}

export async function importMediaFile(ctx: AppContext, projectId: string, filePath: string): Promise<Project> {
  const project = projectsRepo.get(ctx.db, projectId)
  if (!project) throw new AppError('PROJECT_NOT_FOUND', 'That project no longer exists.')

  if (!fs.existsSync(filePath)) {
    projectsRepo.setStatus(ctx.db, projectId, 'import_failed', 'File not found')
    throw new AppError('FILE_NOT_FOUND', `The file "${path.basename(filePath)}" does not exist.`, 'Check the location and try again.')
  }
  if (!isSupportedMediaFile(filePath)) {
    const ext = path.extname(filePath) || '(no extension)'
    projectsRepo.setStatus(ctx.db, projectId, 'import_failed', `Unsupported file type ${ext}`)
    throw new AppError(
      'UNSUPPORTED_FORMAT',
      `".${ext.replace('.', '')}" files are not supported.`,
      'Supported: MP4, MOV, MKV, WebM, AVI, M4V, MPG, WMV plus common audio formats.'
    )
  }

  projectsRepo.setStatus(ctx.db, projectId, 'importing', 'Copying media into the project')
  ctx.events.publish({ type: 'project:update', project: { ...project, status: 'importing' } })

  try {
    const { ffmpeg, ffprobe } = await getBinaries(ctx)

    // Inspect BEFORE copying so bad files fail fast
    const info = await inspectMedia(ffprobe.path, filePath)
    if (!info.hasAudio) {
      ctx.logger.warn('projects', 'import', 'no audio track detected')
    }

    const ext = path.extname(filePath).toLowerCase() || '.mp4'
    const dest = path.join(ctx.projectDir(projectId), 'source', `source${ext}`)
    await streamCopy(filePath, dest, (copied, total) => {
      ctx.events.publish({ type: 'task:update', task: {
        id: `import-${projectId}`, type: 'download', projectId, state: 'running',
        stage: 'copying', progress: total > 0 ? copied / total : null,
        message: 'Copying media into the project', error: null,
        createdAt: project.createdAt, updatedAt: new Date().toISOString()
      } })
    })

    // Re-inspect the stored copy (authoritative)
    const storedInfo = await inspectMedia(ffprobe.path, dest)

    projectsRepo.update(ctx.db, projectId, {
      source_type: 'file',
      source_path: dest,
      source_filename: path.basename(filePath),
      source_url: null,
      duration: storedInfo.duration,
      width: storedInfo.width,
      height: storedInfo.height,
      fps: storedInfo.fps,
      has_audio: storedInfo.hasAudio ? 1 : 0,
      video_codec: storedInfo.videoCodec,
      audio_codec: storedInfo.audioCodec,
      size_bytes: storedInfo.sizeBytes,
      rotation: storedInfo.rotation,
      status: 'ready',
      status_message: storedInfo.hasAudio ? null : 'No audio track — transcription needs audio. Import a transcript file to continue.'
    })

    // Poster thumbnail
    try {
      await generateThumbnail(ffmpeg.path, dest, path.join(ctx.projectDir(projectId), 'thumbnails', 'source.jpg'), {
        at: Math.min(storedInfo.duration * 0.25, 60)
      })
    } catch (err) {
      ctx.logger.warn('projects', 'import', 'thumbnail generation failed', String(err))
    }

    const updated = projectsRepo.get(ctx.db, projectId)
    if (!updated) {
      // The project was deleted while the import was running (B-008).
      throw new AppError('PROJECT_DELETED', 'This project was deleted during import.', 'Nothing was corrupted — the import was discarded.')
    }
    projectsRepo.writeProjectJson(ctx, updated)
    ctx.events.publish({ type: 'project:update', project: updated })
    ctx.events.publish({ type: 'task:update', task: {
      id: `import-${projectId}`, type: 'download', projectId, state: 'completed',
      stage: null, progress: 1, message: 'Import complete', error: null,
      createdAt: project.createdAt, updatedAt: new Date().toISOString()
    } })
    ctx.logger.info('projects', 'import.file', `id=${projectId} file=${path.basename(filePath)} dur=${storedInfo.duration.toFixed(1)}s`)
    return updated
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Import failed'
    projectsRepo.setStatus(ctx.db, projectId, 'import_failed', message)
    ctx.logger.error('projects', 'import.file', `id=${projectId} failed`, String(err))
    throw err
  }
}

export async function importMediaUrl(ctx: AppContext, projectId: string, url: string): Promise<Project> {
  const project = projectsRepo.get(ctx.db, projectId)
  if (!project) throw new AppError('PROJECT_NOT_FOUND', 'That project no longer exists.')
  const parsed = parseUrlSafe(url)

  const providers = getSourceProviders()
  const provider = providers.find((p) => p.canHandle(url))
  if (!provider) {
    const ytdlp = providers.find((p) => p.id === 'yt-dlp') as { isInstalled(): boolean } | undefined
    throw new AppError(
      'URL_PROVIDER_UNAVAILABLE',
      'This URL cannot be imported with the current download providers.',
      ytdlp && !ytdlp.isInstalled()
        ? 'For video sites (YouTube, etc.), install yt-dlp on your system and make sure it is on your PATH. You are responsible for having the right to download the content. Direct links to .mp4/.webm files work without yt-dlp.'
        : 'Use a direct link to a media file (.mp4, .webm, …) or install yt-dlp.'
    )
  }

  projectsRepo.setStatus(ctx.db, projectId, 'importing', `Downloading via ${provider.label}`)
  const controller = new AbortController()
  activeUrlImports.set(projectId, controller)

  try {
    const { ffmpeg, ffprobe } = await getBinaries(ctx)
    const dest = path.join(ctx.projectDir(projectId), 'source', 'source.mp4')

    await provider.download(url, dest, {
      signal: controller.signal,
      onProgress: (downloaded, total) => {
        ctx.events.publish({ type: 'task:update', task: {
          id: `import-${projectId}`, type: 'download', projectId, state: 'running',
          stage: 'downloading', progress: total ? Math.min(0.99, downloaded / total) : null,
          message: total ? `Downloading ${(downloaded / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB` : `Downloading ${(downloaded / 1e6).toFixed(1)} MB`,
          error: null, createdAt: project.createdAt, updatedAt: new Date().toISOString()
        } })
      }
    })

    const info = await inspectMedia(ffprobe.path, dest)
    const meta = await fetchUrlMeta(url).catch(() => null)

    projectsRepo.update(ctx.db, projectId, {
      source_type: 'url',
      source_path: dest,
      source_url: url,
      source_filename: meta?.title ?? (path.basename(parsed.pathname) || 'download.mp4'),
      duration: info.duration,
      width: info.width,
      height: info.height,
      fps: info.fps,
      has_audio: info.hasAudio ? 1 : 0,
      video_codec: info.videoCodec,
      audio_codec: info.audioCodec,
      size_bytes: info.sizeBytes,
      rotation: info.rotation,
      status: 'ready',
      status_message: info.hasAudio ? null : 'No audio track — transcription needs audio. Import a transcript file to continue.'
    })

    try {
      await generateThumbnail(ffmpeg.path, dest, path.join(ctx.projectDir(projectId), 'thumbnails', 'source.jpg'), {
        at: Math.min(info.duration * 0.25, 60)
      })
    } catch {
      /* non-fatal */
    }

    const updated = projectsRepo.get(ctx.db, projectId)
    if (!updated) {
      // The project was deleted while the download was running (B-008).
      throw new AppError('PROJECT_DELETED', 'This project was deleted during import.', 'Nothing was corrupted — the import was discarded.')
    }
    projectsRepo.writeProjectJson(ctx, updated)
    ctx.events.publish({ type: 'project:update', project: updated })
    ctx.logger.info('projects', 'import.url', `id=${projectId} provider=${provider.id}`)
    return updated
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Download failed'
    projectsRepo.setStatus(ctx.db, projectId, 'import_failed', message)
    ctx.logger.error('projects', 'import.url', `id=${projectId} failed`, String(err))
    throw err
  } finally {
    activeUrlImports.delete(projectId)
  }
}

const activeUrlImports = new Map<string, AbortController>()

export function cancelUrlImport(projectId: string): boolean {
  const controller = activeUrlImports.get(projectId)
  if (controller) {
    controller.abort()
    return true
  }
  return false
}

// ----------------------------------------------------------------- storage --

function dirSize(dir: string): number {
  let total = 0
  if (!fs.existsSync(dir)) return 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) total += dirSize(p)
    else {
      try {
        total += fs.statSync(p).size
      } catch { /* race */ }
    }
  }
  return total
}

export function projectStorage(ctx: AppContext, projectId: string): ProjectStorage {
  const base = ctx.projectDir(projectId)
  const source = dirSize(path.join(base, 'source'))
  const renders = dirSize(path.join(base, 'renders'))
  const thumbnails = dirSize(path.join(base, 'thumbnails'))
  const cache = dirSize(path.join(base, 'cache'))
  return { source, renders, thumbnails, cache, total: source + renders + thumbnails + cache }
}

export function workspaceStorage(ctx: AppContext): { projects: number; exports: number; total: number; free: number } {
  const projects = dirSize(ctx.paths.projectsDir)
  const exports_ = dirSize(ctx.paths.exportsDir)
  let free = 0
  try {
    const stat = fs.statfsSync(ctx.workspaceRoot)
    free = Number(stat.bsize) * Number(stat.bavail)
  } catch {
    /* not available */
  }
  return { projects, exports: exports_, total: projects + exports_, free }
}

/** Startup recovery: mark in-flight tasks as interrupted (spec §88). */
export function hasTranscript(ctx: AppContext, projectId: string): boolean {
  return segmentsRepo.countForProject(ctx.db, projectId) > 0
}
