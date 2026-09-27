import React, { useMemo, useState } from 'react'
import { BarChart3, Scissors, ThumbsDown, ChevronRight, ScanSearch, Cpu } from 'lucide-react'
import { api, errMessage } from '../../api/client'
import { useAppStore } from '../../stores/app'
import { useDataStore } from '../../stores/data'
import { EmptyState, ErrorBox, ScoreValue, Spinner, scoreColor } from '../../components/ui'
import type { ClipCandidate, ScoreBreakdown } from '@shared/types'
import { formatClock } from '@shared/utils/time'

const DIMENSION_LABELS: Record<keyof ScoreBreakdown, string> = {
  hook: 'Hook strength',
  contextCompleteness: 'Context completeness',
  clarity: 'Clarity',
  retention: 'Retention potential',
  emotionalImpact: 'Emotional impact',
  standaloneValue: 'Standalone value',
  shareability: 'Shareability',
  visualSuitability: 'Visual suitability'
}

export function MomentsTab() {
  const app = useAppStore()
  const data = useDataStore()
  const project = data.activeProject!
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const analyzeTask = data.tasks.find((t) => t.type === 'analyze' && t.projectId === project.id && (t.state === 'running' || t.state === 'queued'))
  const analyzing = project.status === 'analyzing' || Boolean(analyzeTask)

  const aiProvider = app.settings?.ai.activeProvider ?? 'none'
  const canUseAi = aiProvider === 'openai-compatible' || aiProvider === 'anthropic'

  const moments = useMemo(() => {
    const groups = new Map<string, ClipCandidate[]>()
    for (const c of data.candidates) {
      if (c.status === 'rejected') continue
      const list = groups.get(c.momentKey) ?? []
      list.push(c)
      groups.set(c.momentKey, list)
    }
    return [...groups.values()].map((list) => list.sort((a, b) => a.rankInMoment - b.rankInMoment))
  }, [data.candidates])

  async function analyze(providerId: 'heuristic-local' | 'openai-compatible' | 'anthropic') {
    // Duplicate-submission guard: refuse while an analyze task is already in flight
    if (data.tasks.some((t) => t.type === 'analyze' && t.projectId === project.id && (t.state === 'running' || t.state === 'queued'))) {
      app.toast({ level: 'warn', message: 'An analysis is already running for this project.' })
      return
    }
    setError(null)
    setBusy(true)
    try {
      await api['analysis.start']({ projectId: project.id, providerId })
      const providerLabel =
        providerId === 'heuristic-local' ? 'local heuristic analyzer (offline)' : `${providerId} — transcript text will be sent to that endpoint`
      app.toast({ level: 'info', message: `Analysis started with the ${providerLabel}.` })
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  async function createClip(candidate: ClipCandidate) {
    try {
      const clip = await api['clips.createFromCandidate']({ candidateId: candidate.id })
      await data.loadClips(project.id)
      await data.loadCandidates(project.id)
      app.openEditor(clip.id, project.id)
    } catch (err) {
      app.toast({ level: 'error', ...errMessage(err) })
    }
  }

  async function reject(candidate: ClipCandidate) {
    try {
      await api['analysis.updateCandidate']({ id: candidate.id, patch: { status: 'rejected' } })
      await data.loadCandidates(project.id)
    } catch (err) {
      app.toast({ level: 'error', ...errMessage(err) })
    }
  }

  if (data.transcript.length === 0) {
    return (
      <div className="empty" style={{ padding: '72px 20px' }}>
        <BarChart3 size={28} className="empty-icon" />
        <div style={{ fontWeight: 600, fontSize: 13.5 }}>Analysis needs a transcript</div>
        <div className="muted" style={{ maxWidth: 400, fontSize: 12.5, lineHeight: 1.55 }}>
          Transcribe the video or import a transcript first — the analyzer reads the transcript, never the raw video.
        </div>
      </div>
    )
  }

  return (
    <div className="stack">
      <div className="toolbar" style={{ borderBottom: 'none', paddingBottom: 0, marginBottom: 8 }}>
        <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>
          <strong style={{ color: 'var(--text-1)' }}>{moments.length}</strong> moment{moments.length === 1 ? '' : 's'}
          <span style={{ color: 'var(--text-3)' }}> · {data.candidates.filter((c) => c.status !== 'rejected').length} candidates</span>
        </span>
        {analyzeTask?.message && (
          <span className="row" style={{ fontSize: 12, color: 'var(--text-2)', gap: 7 }}>
            <Spinner size={12} /> {analyzeTask.message} {analyzeTask.progress != null && `· ${Math.round(analyzeTask.progress * 100)}%`}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={() => void analyze('heuristic-local')} disabled={analyzing || busy}>
          <Cpu size={13} /> Analyze — local heuristic
        </button>
        {canUseAi && (
          <button className="btn primary" onClick={() => void analyze(aiProvider)} disabled={analyzing || busy}>
            <ScanSearch size={13} /> Analyze — {aiProvider === 'anthropic' ? 'Anthropic' : 'AI endpoint'}
          </button>
        )}
        {canUseAi && (
          <span className="tiny">sends transcript text only — never the video</span>
        )}
      </div>

      {error ? <ErrorBox error={error} onRetry={() => void analyze('heuristic-local')} /> : null}

      {moments.length === 0 && !analyzing ? (
        <div className="empty" style={{ padding: '72px 20px' }}>
          <BarChart3 size={28} className="empty-icon" />
          <div style={{ fontWeight: 600, fontSize: 13.5 }}>No moments discovered yet</div>
          <div className="muted" style={{ maxWidth: 400, fontSize: 12.5, lineHeight: 1.55 }}>
            Run the analyzer to find candidate clips. The local heuristic works offline; a configured AI provider gives better
            semantic quality.
          </div>
        </div>
      ) : (
        <div className="moment-list">
          {moments.map((list, i) => (
            <MomentRow
              key={list[0].momentKey}
              index={i}
              candidates={list}
              onCreate={(c) => void createClip(c)}
              onReject={(c) => void reject(c)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function MomentRow({
  index,
  candidates,
  onCreate,
  onReject
}: {
  index: number
  candidates: ClipCandidate[]
  onCreate: (c: ClipCandidate) => void
  onReject: (c: ClipCandidate) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [variationIdx, setVariationIdx] = useState(0)
  const candidate = candidates[variationIdx] ?? candidates[0]
  const isHeuristic = candidate.provider === 'heuristic-local'
  const existingClip = useDataStore((s) => s.clips.find((c) => c.candidateId === candidate.id))

  return (
    <div className="moment-row">
      <div
        className="moment-head"
        role="button"
        tabIndex={0}
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setExpanded(!expanded)
          }
        }}
        aria-expanded={expanded}
      >
        <span className="moment-index">Clip {String(index + 1).padStart(2, '0')}</span>
        <span className="moment-timecodes">
          {formatClock(candidate.startTime)} — {formatClock(candidate.endTime)}
          <span style={{ color: 'var(--text-3)' }}> · {Math.round(candidate.endTime - candidate.startTime)}s</span>
        </span>
        <span className="moment-title" title={candidate.title}>{candidate.title}</span>
        <span className="moment-audit">
          <ScoreValue score={candidate.overallScore} label={`Overall estimate: ${candidate.overallScore ?? '–'}/100`} />
        </span>
        <ChevronRight
          size={14}
          className="muted"
          style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }}
        />
      </div>

      {expanded && (
        <div className="moment-body">
          <div className="row wrap" style={{ gap: 8 }}>
            <span className="chip">{candidate.clipType.replace(/-/g, ' ')}</span>
            <span className="tiny" title={isHeuristic ? 'Produced by the offline heuristic analyzer — not an AI model' : `Produced by ${candidate.provider}`}>
              source: {isHeuristic ? 'local heuristic (not an AI model)' : candidate.provider}
            </span>
            {candidate.status === 'converted' && <span className="chip success">clipped</span>}
            <span style={{ flex: 1 }} />
            {candidates.length > 1 && (
              <span className="row" style={{ gap: 8 }}>
                <span className="tiny">variations</span>
                <span className="segmented">
                  {candidates.map((c, i) => (
                    <button
                      key={c.id}
                      className={i === variationIdx ? 'active' : ''}
                      onClick={() => setVariationIdx(i)}
                      title={`${Math.round(c.endTime - c.startTime)}s · score ${c.overallScore ?? '–'}`}
                    >
                      {i === 0 ? 'Best' : `Alt ${i}`}
                    </button>
                  ))}
                </span>
              </span>
            )}
          </div>

          {candidate.hook && (
            <div style={{ fontSize: 12.5, color: 'var(--text-2)' }}>
              <span className="audit-label" style={{ marginRight: 8 }}>Hook</span>
              <em>“{candidate.hook}”</em>
            </div>
          )}

          <div className="tiny" style={{ color: 'var(--text-2)', lineHeight: 1.55 }}>
            {candidate.reason}
          </div>

          {candidate.scores && (
            <ScoreBreakdownView scores={candidate.scores} explanation={candidate.scoreExplanation} provider={candidate.provider} />
          )}

          <div className="excerpt">
            “{candidate.transcriptExcerpt.slice(0, 460)}
            {candidate.transcriptExcerpt.length > 460 ? '…' : ''}”
          </div>

          <div className="row" style={{ gap: 8 }}>
            <button className="btn primary sm" onClick={() => onCreate(candidate)} disabled={existingClip != null}>
              <Scissors size={12} /> {existingClip ? 'Clip created' : 'Create clip'}
            </button>
            {existingClip && (
              <button className="btn sm" onClick={() => useAppStore.getState().openEditor(existingClip.id, existingClip.projectId)}>
                Open editor
              </button>
            )}
            <button className="btn ghost sm" onClick={() => onReject(candidate)} title="Reject this moment">
              <ThumbsDown size={12} /> Reject
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export function ScoreBreakdownView({ scores, explanation, provider }: { scores: ScoreBreakdown; explanation: string | null; provider: string }) {
  return (
    <div className="stack sm">
      {(Object.keys(DIMENSION_LABELS) as Array<keyof ScoreBreakdown>).map((key) => (
        <div className="bar-row" key={key}>
          <span className="bar-label">{DIMENSION_LABELS[key]}</span>
          <div className="score-bar-track">
            <div className="score-bar-fill" style={{ width: `${scores[key]}%`, background: scoreColor(scores[key]) }} />
          </div>
          <span className="bar-value">{scores[key]}</span>
        </div>
      ))}
      {explanation && (
        <div className="tiny" style={{ lineHeight: 1.55, color: 'var(--text-2)', marginTop: 4 }}>
          <strong>Why this score</strong> — {explanation}
        </div>
      )}
      <div className="tiny" style={{ color: 'var(--text-3)' }}>
        Performance Audit — an estimate by <strong>{provider === 'heuristic-local' ? 'the local heuristic analyzer (not an AI model)' : provider}</strong>.
        It reflects defined content characteristics and is not a prediction of views.
      </div>
    </div>
  )
}
