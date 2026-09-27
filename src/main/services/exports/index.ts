import fs from 'node:fs'
import path from 'node:path'
import { AppError } from '@shared/errors'
import type { ExportResult } from '@shared/types'
import { formatExportFilename, slugify, uniqueName } from '@shared/utils/filenames'
import { getPlatformPreset } from '@shared/constants'
import type { AppContext } from '../app-context'
import { clipsRepo, projectsRepo, rendersRepo } from '../database/repositories'
import { getSettings } from '../settings'

/**
 * Export system: bundles rendered clips into <workspace>/exports with
 * Windows-safe sequential filenames plus .txt / .json metadata
 * (spec §32/§33).
 */

export function runExport(ctx: AppContext, clipIds: string[], includeMetadata: boolean): ExportResult {
  if (clipIds.length === 0) throw new AppError('EXPORT_EMPTY', 'Select at least one clip to export.')

  const clips = clipIds.map((id) => {
    const clip = clipsRepo.get(ctx.db, id)
    if (!clip) throw new AppError('CLIP_NOT_FOUND', `Clip ${id} no longer exists.`)
    return clip
  })

  const project = projectsRepo.get(ctx.db, clips[0].projectId)
  if (!project) throw new AppError('PROJECT_NOT_FOUND', 'The project no longer exists.')
  const multiProject = new Set(clips.map((c) => c.projectId)).size > 1
  if (multiProject) {
    throw new AppError('EXPORT_MIXED_PROJECTS', 'Select clips from a single project to export together.')
  }

  const renders = rendersRepo.list(ctx.db, project.id)
  const settings = getSettings(ctx)
  const preset = getPlatformPreset(settings.export.preset)

  const exportRoot = path.join(ctx.paths.exportsDir, uniqueName(sanitizeDirName(project.name), (name) => fs.existsSync(path.join(ctx.paths.exportsDir, name))))
  fs.mkdirSync(exportRoot, { recursive: true })

  const files: string[] = []
  let index = 1
  for (const clip of clips) {
    const render = renders.find((r) => r.clipId === clip.id && r.status === 'completed' && r.outputPath)
    if (!render?.outputPath) {
      throw new AppError(
        'CLIP_NOT_RENDERED',
        `"${clip.title || 'Untitled clip'}" has no completed render to export.`,
        'Render the clip first — exports always use the newest successful render.'
      )
    }
    const slug = slugify(clip.title || 'clip')
    const base = formatExportFilename(settings.export.filenameTemplate, {
      index,
      slug,
      title: clip.title || slug
    })
    const outPath = path.join(exportRoot, `${base}.mp4`)
    fs.copyFileSync(render.outputPath, outPath)
    files.push(outPath)

    if (includeMetadata && settings.export.includeMetadataFiles) {
      const txtPath = path.join(exportRoot, `${base}.txt`)
      const hashtags = clip.hashtags.join(' ')
      const cta = clip.cta ? `\n${clip.cta}` : ''
      fs.writeFileSync(
        txtPath,
        [
          clip.title || base,
          '',
          clip.description || '',
          cta,
          '',
          hashtags,
          '',
          `Platform preset: ${preset.label}`,
          `Source project: ${project.name}`
        ]
          .join('\n')
          .replace(/\n{3,}/g, '\n\n'),
        'utf-8'
      )
      files.push(txtPath)

      const jsonPath = path.join(exportRoot, `${base}.json`)
      fs.writeFileSync(
        jsonPath,
        JSON.stringify(
          {
            title: clip.title,
            description: clip.description,
            hashtags: clip.hashtags,
            cta: clip.cta,
            platformPreset: preset.id,
            clip: { start: clip.startTime, end: clip.endTime, aspectRatio: clip.aspectRatio, cropMode: clip.cropMode, captionStyleId: clip.captionStyleId },
            source: { project: project.name, file: project.sourceFilename, duration: project.duration },
            metadataProvider: clip.metadataProvider
          },
          null,
          2
        ),
        'utf-8'
      )
      files.push(jsonPath)
    }
    index++
  }

  ctx.logger.info('exports', 'run', `clips=${clipIds.length} dir=${exportRoot}`)
  return { dir: exportRoot, files }
}

function sanitizeDirName(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'exports'
}
