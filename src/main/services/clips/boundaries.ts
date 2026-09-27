import { AppError } from '@shared/errors'
import type { Clip } from '@shared/types'
import {
  boundaryQuality,
  expandWithLeadIn,
  sentenceSpans,
  snapToSentenceBoundaries
} from '@shared/analysis/boundaries'
import type { AppContext } from '../app-context'
import { clipsRepo, projectsRepo, segmentsRepo } from '../database/repositories'
import { updateClip } from './'

/**
 * Manual boundary optimization for an existing clip (§34): snap to sentence
 * boundaries, then expand the start with lead-in context when the opener
 * needs setup. Returns the updated clip plus explanations for the UI.
 */

export interface BoundaryOptimizationResult {
  clip: Clip
  adjusted: boolean
  startReason: string
  endReason: string
  leadIn: { applied: boolean; reason: string }
  quality: {
    before: { score: number; startReason: string; endReason: string }
    after: { score: number; startReason: string; endReason: string }
  }
}

export function optimizeClipBoundaries(ctx: AppContext, clipId: string): BoundaryOptimizationResult {
  const clip = clipsRepo.get(ctx.db, clipId)
  if (!clip) throw new AppError('CLIP_NOT_FOUND', 'That clip no longer exists.')
  const project = projectsRepo.get(ctx.db, clip.projectId)
  if (!project) throw new AppError('PROJECT_NOT_FOUND', 'The project for this clip no longer exists.')

  const segments = segmentsRepo.listForProject(ctx.db, clip.projectId)
  const spans = sentenceSpans(segments)
  const before = boundaryQuality(clip, spans)

  // Snap first, then consider lead-in on the snapped start.
  const snapped = snapToSentenceBoundaries(clip, spans, {
    minLengthSec: 5,
    maxLengthSec: Math.min(180, (project.duration ?? clip.endTime) - 0.2)
  })
  let { startTime, endTime } = snapped
  const leadIn = expandWithLeadIn({ startTime, endTime }, spans, {
    maxLeadSec: 3.5,
    maxLengthSec: Math.min(180, (project.duration ?? clip.endTime) - 0.2)
  })
  if (leadIn.applied) startTime = leadIn.startTime
  if (project.duration != null) {
    endTime = Math.min(endTime, project.duration)
    startTime = Math.max(0, Math.min(startTime, endTime - 0.5))
  }

  const updated = updateClip(ctx, clipId, { startTime, endTime })
  const after = boundaryQuality(updated, spans)
  return {
    clip: updated,
    adjusted:
      Math.abs(startTime - clip.startTime) > 0.05 || Math.abs(endTime - clip.endTime) > 0.05,
    startReason: leadIn.applied ? `Lead-in added — ${leadIn.reason}` : snapped.startReason,
    endReason: snapped.endReason,
    leadIn,
    quality: { before, after }
  }
}
