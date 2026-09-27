import fs from 'node:fs'
import path from 'node:path'
import { AppError } from '@shared/errors'
import type { AnalysisSummary, ClipCandidate, ProviderAvailability, ScoreBreakdown, TranscriptSegment } from '@shared/types'
import {
  assignMomentMetadata, dedupeCandidates, excerptFor, validateCandidate,
  clampScore, aggregateScore,
  type RawCandidate, type RawScores, type ValidatedWithScores
} from '@shared/candidates'
import { rawCandidatesResponseSchema, rawScoresResponseSchema, rawMetadataResponseSchema } from '@shared/schemas'
import { getDurationRange } from '@shared/constants'
import { buildDiscoveryUserPrompt, buildScoringUserPrompt, DISCOVERY_SYSTEM, SCORING_SYSTEM } from '@prompts/index'
import type { AppContext } from '../app-context'
import { candidatesRepo, projectsRepo, segmentsRepo, clipsRepo } from '../database/repositories'
import { getSettings } from '../settings'
import { chatComplete, extractJson } from './chat'
import { runHeuristicAnalysis } from './heuristic'

/**
 * Clip discovery + performance audit orchestration (spec §15–19).
 *
 * Pipeline: transcript → provider candidates → zod validation →
 * segment-id→time conversion → dedup into moments → audit scores → persist.
 * Raw provider output is archived to projects/<id>/analysis/ for cache/debug.
 */

export type AnalysisProviderId = 'heuristic-local' | 'openai-compatible' | 'anthropic'

export interface AnalysisOptions {
  projectId: string
  providerId: AnalysisProviderId
  onEvent: (stage: string, progress: number | null, message: string) => void
  signal: AbortSignal
}

export async function runAnalysis(ctx: AppContext, opts: AnalysisOptions): Promise<AnalysisSummary> {
  const project = projectsRepo.get(ctx.db, opts.projectId)
  if (!project) throw new AppError('PROJECT_NOT_FOUND', 'That project no longer exists.')

  const segments = segmentsRepo.listForProject(ctx.db, opts.projectId)
  if (segments.length === 0) {
    throw new AppError(
      'NO_TRANSCRIPT',
      'This project has no transcript yet.',
      'Transcribe the video or import a transcript file first — analysis reads the transcript, not the video.'
    )
  }

  const settings = getSettings(ctx)
  const preset = project.settings.durationPreset ?? settings.video.targetDurationPreset
  const range = getDurationRange(preset)
  const maxCandidates = project.settings.maxCandidates ?? 8

  projectsRepo.setStatus(ctx.db, opts.projectId, 'analyzing', 'Analyzing transcript')
  opts.onEvent('discovering', 0.1, 'Finding candidate moments')

  let providerLabel: string
  let validated: ValidatedWithScores[] = []
  const rejected: string[] = []

  if (opts.providerId === 'heuristic-local') {
    providerLabel = 'heuristic-local'
    const heuristic = runHeuristicAnalysis(segments, {
      minSeconds: range.min,
      maxSeconds: range.max,
      maxCandidates: maxCandidates * 2 // dedup + bucketing will trim to target
    })
    validated = heuristic.map((h) => ({
      startTime: h.startTime,
      endTime: h.endTime,
      startSegmentId: h.startSegmentId,
      endSegmentId: h.endSegmentId,
      title: h.title,
      hook: h.hook,
      reason: h.reason,
      clipType: h.clipType,
      transcriptExcerpt: excerptFor(segments, h.startSegmentId, h.endSegmentId),
      scores: h.scores,
      overallScore: h.overallScore,
      scoreExplanation: h.scoreExplanation
    }))
    opts.onEvent('scoring', 0.8, 'Scoring candidates')
  } else {
    providerLabel = opts.providerId
    validated = await aiDiscovery(ctx, opts, segments, project, {
      minSeconds: range.min,
      maxSeconds: range.max,
      maxCandidates,
      preset
    }, rejected)
  }

  if (validated.length === 0) {
    projectsRepo.setStatus(ctx.db, opts.projectId, 'analysis_failed', 'No valid candidates were produced')
    throw new AppError(
      'ANALYSIS_NO_CANDIDATES',
      'The analysis produced no valid clip candidates.',
      rejected.length
        ? `${rejected.length} raw candidates were rejected: ${rejected[0]}`
        : 'Try a different duration preset, a longer transcript, or a different analysis provider.'
    )
  }

  // Dedup into moments
  opts.onEvent('deduplicating', 0.9, 'Grouping overlapping candidates')
  const { moments, variationsGrouped } = dedupeCandidates(validated)
  const withMoments = assignMomentMetadata(moments, opts.projectId)

  // Cap: keep the best candidate per moment first, then extras up to max
  const best = withMoments.filter((c) => c.rankInMoment === 0).slice(0, maxCandidates)
  const extras = withMoments.filter((c) => c.rankInMoment > 0).slice(0, Math.max(0, maxCandidates - best.length))
  const finalCandidates = [...best, ...extras]

  // Persist
  const persisted = candidatesRepo.replaceForProject(ctx.db, opts.projectId, finalCandidates.map((c) => ({
    projectId: opts.projectId,
    startTime: c.startTime,
    endTime: c.endTime,
    startSegmentId: c.startSegmentId,
    endSegmentId: c.endSegmentId,
    title: c.title,
    hook: c.hook,
    transcriptExcerpt: c.transcriptExcerpt,
    reason: c.reason,
    clipType: c.clipType,
    scores: c.scores,
    overallScore: c.overallScore,
    scoreExplanation: c.scoreExplanation,
    provider: providerLabel,
    momentKey: c.momentKey,
    rankInMoment: c.rankInMoment,
    status: 'discovered' as const
  })))

  // Archive raw output for cache/debug
  try {
    const analysisDir = path.join(ctx.projectDir(opts.projectId), 'analysis')
    fs.mkdirSync(analysisDir, { recursive: true })
    fs.writeFileSync(path.join(analysisDir, `candidates-${providerLabel}.json`), JSON.stringify(persisted, null, 2))
  } catch {
    /* non-fatal */
  }

  projectsRepo.setStatus(ctx.db, opts.projectId, 'analyzed', null)
  const updated = projectsRepo.get(ctx.db, opts.projectId)
  if (updated) ctx.events.publish({ type: 'project:update', project: updated })

  const summary: AnalysisSummary = {
    foundMoments: moments.length,
    keptCandidates: persisted.length,
    variationsGrouped,
    rejected: rejected.length,
    provider: providerLabel
  }
  ctx.logger.info('analysis', 'done', `project=${opts.projectId} moments=${summary.foundMoments} kept=${summary.keptCandidates}`)
  return summary
}

async function aiDiscovery(
  ctx: AppContext,
  opts: AnalysisOptions,
  segments: TranscriptSegment[],
  project: { name: string; duration: number | null },
  params: { minSeconds: number; maxSeconds: number; maxCandidates: number; preset: string },
  rejections: string[]
): Promise<ValidatedWithScores[]> {
  const numbered = segments.map((s) => ({ id: s.id, start: s.startTime, end: s.endTime, text: s.text }))
  const userPrompt = buildDiscoveryUserPrompt({
    segments: numbered,
    durationPreset: params.preset as 'short' | 'medium' | 'long' | 'mixed',
    minSeconds: params.minSeconds,
    maxSeconds: params.maxSeconds,
    maxCandidates: params.maxCandidates,
    sourceTitle: project.name,
    sourceDurationSeconds: project.duration
  })

  // --- Pass 1: discovery
  let raws: RawCandidate[] = []
  const maxRetries = 1
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const system = attempt === 0 ? DISCOVERY_SYSTEM : `${DISCOVERY_SYSTEM}\n\nCRITICAL: Your previous response was not parseable JSON. Respond with ONLY the JSON object — no fences, no prose.`
    opts.onEvent('discovering', 0.2 + attempt * 0.15, attempt === 0 ? 'Asking the AI provider to find moments' : 'Model output was malformed — retrying with a stricter prompt')
    const raw = await chatComplete(
      ctx,
      opts.providerId === 'anthropic' ? 'anthropic' : 'openai-compatible',
      [
        { role: 'system', content: system },
        { role: 'user', content: userPrompt }
      ],
      { jsonMode: true, signal: opts.signal }
    )
    const parsed = extractJson<{ candidates?: RawCandidate[] }>(raw)
    const validatedResponse = rawCandidatesResponseSchema.safeParse(parsed)
    if (validatedResponse.success) {
      raws = validatedResponse.data.candidates
      break
    }
    if (attempt === maxRetries) {
      throw new AppError(
        'AI_RETURNED_INVALID_JSON',
        'The AI provider responded, but its candidate list could not be parsed.',
        'Retry the analysis, or switch to another provider/model in Settings → AI.',
        raw.slice(-800)
      )
    }
  }

  // --- Validate + convert to times
  const validCtx = {
    segments,
    sourceDuration: project.duration,
    durationPreset: params.preset as 'short' | 'medium' | 'long' | 'mixed'
  }
  const validated: ValidatedWithScores[] = []
  for (const raw of raws) {
    const result = validateCandidate(raw, validCtx)
    if ('candidate' in result) {
      validated.push({ ...result.candidate, scores: null, overallScore: null, scoreExplanation: null })
    } else {
      // structurally impossible timestamps / bad ranges are dropped, not trusted
      rejections.push(result.rejection)
      ctx.logger.warn('analysis', 'candidate.rejected', result.rejection)
    }
  }
  if (validated.length === 0) {
    throw new AppError(
      'ANALYSIS_NO_VALID_CANDIDATES',
      'The AI returned candidates, but none referenced valid transcript segments.',
      'This can happen with very short transcripts. Try the local heuristic provider or a longer duration preset.'
    )
  }

  // --- Pass 2: audit scores
  opts.onEvent('scoring', 0.6, 'Auditing candidates')
  const scoringContext = validated.map((c, index) => ({
    index,
    title: c.title,
    excerpt: c.transcriptExcerpt,
    durationSeconds: c.endTime - c.startTime
  }))
  const scoringRaw = await chatComplete(
    ctx,
    opts.providerId === 'anthropic' ? 'anthropic' : 'openai-compatible',
    [
      { role: 'system', content: SCORING_SYSTEM },
      { role: 'user', content: buildScoringUserPrompt({ candidates: scoringContext }) }
    ],
    { jsonMode: true, signal: opts.signal }
  )
  const scoringParsed = extractJson<{ scores?: RawScores[] }>(scoringRaw)
  const scoringValidated = rawScoresResponseSchema.safeParse(scoringParsed)

  if (scoringValidated.success) {
    const byIndex = new Map(scoringValidated.data.scores.map((s) => [s.candidateIndex, s]))
    for (const [index, cand] of validated.entries()) {
      const s = byIndex.get(index)
      if (s) {
        const scores: ScoreBreakdown = {
          hook: clampScore(s.hook),
          contextCompleteness: clampScore(s.contextCompleteness),
          clarity: clampScore(s.clarity),
          retention: clampScore(s.retention),
          emotionalImpact: clampScore(s.emotionalImpact),
          standaloneValue: clampScore(s.standaloneValue),
          shareability: clampScore(s.shareability),
          visualSuitability: clampScore(s.visualSuitability)
        }
        cand.scores = scores
        cand.overallScore = aggregateScore(scores)
        cand.scoreExplanation = s.explanation || 'No explanation was provided by the model.'
      }
    }
  } else {
    // Scoring is optional-ish: candidates remain usable without audit numbers
    ctx.logger.warn('analysis', 'scoring.invalid', 'audit scores could not be parsed; candidates kept without scores')
  }

  return validated
}

// ------------------------------------------------------------- providers ----

export async function listAnalysisProviders(ctx: AppContext): Promise<ProviderAvailability[]> {
  const settings = getSettings(ctx)
  const openaiOk = Boolean(settings.ai.openai.baseUrl && settings.ai.openai.model) && ctx.secrets.get('ai:openai-compatible') != null
  const anthropicOk = Boolean(settings.ai.anthropic.model) && ctx.secrets.get('ai:anthropic') != null
  return [
    {
      id: 'heuristic-local',
      label: 'Local heuristic analyzer',
      kind: 'analysis',
      available: true,
      configured: true,
      message: 'Always available. Offline keyword/cue analysis — not an AI model. Good for structure, weaker at meaning.'
    },
    {
      id: 'openai-compatible',
      label: 'OpenAI-compatible endpoint',
      kind: 'analysis',
      available: openaiOk,
      configured: openaiOk,
      message: openaiOk
        ? `Sends the transcript to ${settings.ai.openai.baseUrl} for semantic analysis.`
        : 'Requires base URL, model, and API key in Settings → AI.',
      fixHint: 'Settings → AI'
    },
    {
      id: 'anthropic',
      label: 'Anthropic (Claude)',
      kind: 'analysis',
      available: anthropicOk,
      configured: anthropicOk,
      message: anthropicOk
        ? 'Sends the transcript to api.anthropic.com for semantic analysis.'
        : 'Requires an Anthropic API key in Settings → AI.',
      fixHint: 'Settings → AI'
    }
  ]
}

export function getCandidates(ctx: AppContext, projectId: string): ClipCandidate[] {
  return candidatesRepo.listForProject(ctx.db, projectId)
}

export function updateCandidateStatus(ctx: AppContext, id: string, status: ClipCandidate['status']): ClipCandidate {
  const updated = candidatesRepo.updateStatus(ctx.db, id, status)
  if (!updated) throw new AppError('CANDIDATE_NOT_FOUND', 'That clip candidate no longer exists.')
  return updated
}
