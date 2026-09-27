import { AppError } from '@shared/errors'
import type { Clip } from '@shared/types'
import { rawMetadataResponseSchema } from '@shared/schemas'
import { excerptFor } from '@shared/candidates'
import { getPlatformPreset } from '@shared/constants'
import { buildMetadataUserPrompt, METADATA_SYSTEM } from '@prompts/index'
import type { AppContext } from '../app-context'
import { candidatesRepo, clipsRepo, projectsRepo, segmentsRepo } from '../database/repositories'
import { getSettings } from '../settings'
import { chatComplete, extractJson } from '../ai/chat'

/**
 * Clip lifecycle: candidate → clip (copy provenance + settings), edits,
 * and metadata generation. Editing a clip never re-runs transcription or
 * analysis (spec §43) — only the touched fields change.
 */

export function createClipFromCandidate(ctx: AppContext, candidateId: string): Clip {
  const candidate = candidatesRepo.get(ctx.db, candidateId)
  if (!candidate) throw new AppError('CANDIDATE_NOT_FOUND', 'That clip candidate no longer exists.')
  const settings = getSettings(ctx)

  const existing = clipsRepo.listForProject(ctx.db, candidate.projectId).find((c) => c.candidateId === candidateId)
  if (existing) return existing

  const clip: Omit<Clip, 'createdAt' | 'updatedAt'> = {
    id: crypto.randomUUID(),
    candidateId: candidate.id,
    projectId: candidate.projectId,
    startTime: candidate.startTime,
    endTime: candidate.endTime,
    aspectRatio: '9:16',
    cropMode: 'center',
    cropX: 0.5,
    zoom: 1,
    captionStyleId: settings.captions.defaultStyleId,
    captionOverrides: {},
    captionTextEdits: {},
    title: candidate.title,
    description: '',
    hashtags: [],
    cta: '',
    metadataProvider: null,
    status: 'draft'
  }
  const created = clipsRepo.create(ctx.db, clip)
  candidatesRepo.updateStatus(ctx.db, candidateId, 'converted')
  ctx.logger.info('clips', 'create', `clip=${created.id} from candidate=${candidateId}`)
  return created
}

export function getClip(ctx: AppContext, id: string): Clip {
  const clip = clipsRepo.get(ctx.db, id)
  if (!clip) throw new AppError('CLIP_NOT_FOUND', 'That clip no longer exists.')
  return clip
}

export function listClips(ctx: AppContext, projectId: string): Clip[] {
  return clipsRepo.listForProject(ctx.db, projectId)
}

export function updateClip(ctx: AppContext, id: string, patch: Record<string, unknown>): Clip {
  const clip = clipsRepo.get(ctx.db, id)
  if (!clip) throw new AppError('CLIP_NOT_FOUND', 'That clip no longer exists.')
  const project = projectsRepo.get(ctx.db, clip.projectId)
  if (!project) throw new AppError('PROJECT_NOT_FOUND', 'The project for this clip no longer exists.')

  // Range validation for trim edits
  if (patch.startTime !== undefined || patch.endTime !== undefined) {
    const start = typeof patch.startTime === 'number' ? patch.startTime : clip.startTime
    const end = typeof patch.endTime === 'number' ? patch.endTime : clip.endTime
    if (!(start >= 0 && end > start)) {
      throw new AppError('CLIP_RANGE_INVALID', 'The clip end must come after its start.', 'Drag the timeline handles or enter valid times.')
    }
    if (project.duration != null && end > project.duration + 0.5) {
      throw new AppError('CLIP_RANGE_INVALID', `The clip end (${end.toFixed(1)}s) is past the end of the source (${project.duration.toFixed(1)}s).`)
    }
  }

  const updated = clipsRepo.update(ctx.db, id, patch)
  if (!updated) throw new AppError('CLIP_NOT_FOUND', 'That clip no longer exists.')
  return updated
}

export function deleteClip(ctx: AppContext, id: string): void {
  const clip = clipsRepo.get(ctx.db, id)
  if (!clip) return
  if (clip.candidateId) {
    // The candidate becomes available again for a fresh clip
    candidatesRepo.updateStatus(ctx.db, clip.candidateId, 'discovered')
  }
  clipsRepo.delete(ctx.db, id)
  ctx.logger.info('clips', 'delete', `clip=${id}`)
}

// -------------------------------------------------------------- metadata ---

export async function generateClipMetadata(ctx: AppContext, clipId: string): Promise<Clip> {
  const clip = clipsRepo.get(ctx.db, clipId)
  if (!clip) throw new AppError('CLIP_NOT_FOUND', 'That clip no longer exists.')
  const project = projectsRepo.get(ctx.db, clip.projectId)
  if (!project) throw new AppError('PROJECT_NOT_FOUND', 'The project for this clip no longer exists.')

  const settings = getSettings(ctx)
  const preset = getPlatformPreset(settings.export.preset)
  const segments = segmentsRepo.listForProject(ctx.db, clip.projectId)
  const inRange = segments.filter((s) => s.endTime > clip.startTime && s.startTime < clip.endTime)
  const excerpt =
    clip.title ||
    (inRange.length ? excerptFor(segments, inRange[0].id, inRange[inRange.length - 1].id) : clip.title)

  let provider: string
  let metadata: { title: string; description: string; hashtags: string[]; cta: string }

  const active = settings.ai.activeProvider
  if (active === 'openai-compatible' || active === 'anthropic') {
    const raw = await chatComplete(
      ctx,
      active,
      [
        { role: 'system', content: METADATA_SYSTEM },
        {
          role: 'user',
          content: buildMetadataUserPrompt({
            clipTitle: clip.title || excerpt.slice(0, 80),
            excerpt,
            durationSeconds: clip.endTime - clip.startTime,
            platform: preset.label,
            maxTitleLength: preset.maxTitleLength,
            hashtagCount: preset.hashtagCount,
            descriptionFormat: preset.descriptionFormat
          })
        }
      ],
      { jsonMode: true }
    )
    const parsed = extractJson(raw)
    const validated = rawMetadataResponseSchema.safeParse(parsed)
    if (!validated.success) {
      throw new AppError(
        'AI_METADATA_INVALID',
        'The AI provider returned metadata that could not be parsed.',
        'Try again, edit the metadata manually, or switch providers.',
        raw.slice(-600)
      )
    }
    metadata = validated.data
    provider = active
  } else {
    metadata = heuristicMetadata(clip.title || excerpt, excerpt, preset.hashtagCount)
    provider = 'heuristic-local'
  }

  const updated = clipsRepo.update(ctx.db, clipId, {
    title: metadata.title.slice(0, 200),
    description: metadata.description,
    hashtags: metadata.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).slice(0, 15),
    cta: metadata.cta,
    metadataProvider: provider
  })
  ctx.logger.info('clips', 'metadata', `clip=${clipId} provider=${provider}`)
  return updated as Clip
}

function heuristicMetadata(fallbackTitle: string, excerpt: string, hashtagCount: number): {
  title: string; description: string; hashtags: string[]; cta: string
} {
  const sentences = excerpt.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 10)
  const title = (fallbackTitle || sentences[0] || 'Watch this moment')
    .replace(/["""]./g, '')
    .split(/\s+/)
    .slice(0, 9)
    .join(' ')
    .trim()

  const description = sentences.slice(0, 2).join(' ').slice(0, 280)

  const stop = new Set(
    'the a an and or but if then so because to of in on for with at by from as is are was were be been this that these those it its i you he she they we what which who how when where why not no do does did have has had will would can could should just like really very much more most about into over after before'.split(' ')
  )
  const freq = new Map<string, number>()
  for (const word of excerpt.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)) {
    if (word.length < 4 || stop.has(word)) continue
    freq.set(word, (freq.get(word) ?? 0) + 1)
  }
  const hashtags = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, hashtagCount)
    .map(([w]) => `#${w}`)

  return { title, description, hashtags, cta: 'Follow for more moments like this.' }
}
