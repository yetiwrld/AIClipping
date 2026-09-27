import React, { useMemo, useState } from 'react'
import { Sparkles, Scissors, ThumbsDown, ChevronDown, ChevronUp } from 'lucide-react'
import { api, errMessage } from '../../api/client'
import { useAppStore } from '../../stores/app'
import { useDataStore } from '../../stores/data'
import { EmptyState, ErrorBox, ScoreRing, Spinner, scoreColor } from '../../components/ui'
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
      <div className="card">
        <EmptyState
          icon={<Sparkles size={38} className="empty-icon" />}
          title="Analysis needs a transcript"
          hint="Transcribe the video or import a transcript first — the analyzer reads the transcript, never the raw video."
        />
      </div>
    )
  }

  return (
    <div className="stack">
      <div className="card pad-sm">
        <div className="row wrap">
          <span style={{ fontSize: 13 }}>
            <strong>{moments.length}</strong> moment{moments.length === 1 ? '' : 's'} · {data.candidates.filter((c) => c.status !== 'rejected').length} candidates
          </span>
          <span className="header-spacer" />
          {analyzeTask?.message && (
            <span className="row muted" style={{ fontSize: 12.5 }}>
              <Spinner /> {analyzeTask.message} {analyzeTask.progress != null && `· ${Math.round(analyzeTask.progress * 100)}%`}
            </span>
          )}
          <button className="btn" onClick={() => void analyze('heuristic-local')} disabled={analyzing || busy}>
            <Sparkles size={14} /> Analyze (local heuristic)
          </button>
          {canUseAi && (
            <button className="btn primary" onClick={() => void analyze(aiProvider)} disabled={analyzing || busy}>
              <Sparkles size={14} /> Analyze with {aiProvider === 'anthropic' ? 'Anthropic' : 'AI endpoint'}
            </button>
          )}
        </div>
        {canUseAi && (
          <div className="tiny" style={{ marginTop: 6 }}>
            “Analyze with AI endpoint” sends the transcript text (not the video) to your configured provider.
          </div>
        )}
      </div>

      {error ? <ErrorBox error={error} onRetry={() => void analyze('heuristic-local')} /> : null}

      {moments.length === 0 && !analyzing ? (
        <div className="card">
          <EmptyState
            icon={<Sparkles size={38} className="empty-icon" />}
            title="No moments discovered yet"
            hint="Run the analyzer to find candidate clips. The local heuristic works offline; a configured AI provider gives better semantic quality."
          />
        </div>
      ) : (
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(430px, 1fr))' }}>
          {moments.map((list, i) => (
            <MomentCard
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

function MomentCard({
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
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <ScoreRing score={candidate.overallScore} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 650, fontSize: 14, lineHeight: 1.35 }}>{candidate.title}</div>
          <div className="row wrap" style={{ marginTop: 4, gap: 6 }}>
            <span className="chip">
              {formatClock(candidate.startTime)} → {formatClock(candidate.endTime)}
            </span>
            <span className="chip">{Math.round(candidate.endTime - candidate.startTime)}s</span>
            <span className="chip">{candidate.clipType.replace(/-/g, ' ')}</span>
            <span className={`chip ${isHeuristic ? 'warn' : 'accent'}`} title={isHeuristic ? 'Produced by the offline heuristic analyzer — not an AI model' : `Produced by ${candidate.provider}`}>
              {isHeuristic ? 'heuristic' : 'AI'}
            </span>
            {candidate.status === 'converted' && <span className="chip success">clipped</span>}
          </div>
        </div>
      </div>

      {candidates.length > 1 && (
        <div className="row" style={{ gap: 6 }}>
          <span className="tiny">Variations:</span>
          {candidates.map((c, i) => (
            <button
              key={c.id}
              className={`btn sm ${i === variationIdx ? 'primary' : ''}`}
              onClick={() => setVariationIdx(i)}
              title={`${Math.round(c.endTime - c.startTime)}s · score ${c.overallScore ?? '–'}`}
            >
              {i === 0 ? 'Best' : `Alt ${i}`}
            </button>
          ))}
        </div>
      )}

      {candidate.hook && (
        <div style={{ fontSize: 13 }}>
          <span className="tiny">Hook — </span>
          <em>“{candidate.hook}”</em>
        </div>
      )}

      <div className="tiny" style={{ color: 'var(--text-2)', lineHeight: 1.5 }}>
        <Sparkles size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
        {candidate.reason}
      </div>

      {expanded && (
        <>
          {candidate.scores && <ScoreBreakdownView scores={candidate.scores} explanation={candidate.scoreExplanation} provider={candidate.provider} />}
          <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.6, background: 'var(--bg-2)', borderRadius: 8, padding: '10px 12px' }}>
            “{candidate.transcriptExcerpt.slice(0, 460)}
            {candidate.transcriptExcerpt.length > 460 ? '…' : ''}”
          </div>
        </>
      )}

      <div className="row" style={{ marginTop: 'auto', paddingTop: 4 }}>
        <button className="btn primary sm" onClick={() => onCreate(candidate)} disabled={existingClip != null}>
          <Scissors size={13} /> {existingClip ? 'Clip created' : 'Create clip'}
        </button>
        {existingClip && (
          <button className="btn sm" onClick={() => useAppStore.getState().openEditor(existingClip.id, existingClip.projectId)}>
            Open editor
          </button>
        )}
        <button className="btn ghost sm" onClick={() => setExpanded(!expanded)}>
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />} {expanded ? 'Less' : 'Audit & excerpt'}
        </button>
        <span style={{ flex: 1 }} />
        <button className="btn ghost sm" onClick={() => onReject(candidate)} title="Reject this moment">
          <ThumbsDown size={13} />
        </button>
      </div>
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
        <div className="tiny" style={{ lineHeight: 1.5, color: 'var(--text-2)' }}>
          <strong>Why this score?</strong> {explanation}
        </div>
      )}
      <div className="tiny" style={{ color: 'var(--text-3)' }}>
        Performance Audit — an estimate by <strong>{provider === 'heuristic-local' ? 'the local heuristic analyzer (not an AI model)' : provider}</strong>.
        It reflects defined content characteristics and is not a prediction of views.
      </div>
    </div>
  )
}
