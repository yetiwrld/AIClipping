import React from 'react'
import { X, AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react'
import { errMessage } from '../api/client'

/** Small shared UI primitives — thin, accessible wrappers over the CSS. */

export function Modal(props: {
  title: string
  onClose?: () => void
  children: React.ReactNode
  footer?: React.ReactNode
  wide?: boolean
}) {
  return (
    <div
      className="modal-backdrop"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && props.onClose) props.onClose()
      }}
    >
      <div className={`modal ${props.wide ? 'wide' : ''}`} role="dialog" aria-label={props.title}>
        <div className="modal-head">
          <div className="modal-title">{props.title}</div>
          <div className="header-spacer" />
          {props.onClose && (
            <button className="btn ghost sm icon" onClick={props.onClose} aria-label="Close dialog">
              <X size={14} />
            </button>
          )}
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer && <div className="modal-foot">{props.footer}</div>}
      </div>
    </div>
  )
}

export function ProgressBar(props: { value: number; success?: boolean; danger?: boolean }) {
  const pct = Math.round(Math.min(1, Math.max(0, props.value)) * 100)
  return (
    <div className="progress-track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className={`progress-fill ${props.success ? 'success' : ''} ${props.danger ? 'danger' : ''}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

export function ErrorBox(props: { error: unknown; onRetry?: () => void; retryLabel?: string }) {
  const { message, hint, code, details } = errMessage(props.error) as { message: string; hint?: string; code?: string; details?: string }
  return (
    <div className="error-box" role="alert">
      <div className="error-title">
        <AlertTriangle size={12} style={{ verticalAlign: -1, marginRight: 5 }} />
        {message}
      </div>
      {hint && <div className="error-hint">{hint}</div>}
      {details && (
        <details className="error-details">
          <summary>Technical details</summary>
          <pre>{details}</pre>
        </details>
      )}
      {props.onRetry && (
        <div style={{ marginTop: 8 }}>
          <button className="btn sm" onClick={props.onRetry}>
            {props.retryLabel ?? 'Retry'}
          </button>
        </div>
      )}
      {code && <div className="tiny" style={{ marginTop: 6 }}>Code: {code}</div>}
    </div>
  )
}

/**
 * Score color: mostly neutral. Strong scores use the accent; weak ones get
 * semantic warnings. Mid-range stays deliberately quiet.
 */
export function scoreColor(score: number | null | undefined): string {
  if (score == null) return 'var(--text-3)'
  if (score >= 75) return 'var(--accent)'
  if (score >= 35) return 'var(--text-2)'
  return 'var(--danger)'
}

/** Compact analytical score value — "86 / 100" — no ring, no gauge. */
export function ScoreValue(props: { score: number | null; size?: 'sm' | 'lg'; label?: string }) {
  const s = props.score
  return (
    <span
      className="audit-value"
      style={{
        fontSize: props.size === 'lg' ? 22 : 15,
        color: scoreColor(s),
        fontWeight: 600
      }}
      title={props.label ?? (s != null ? `Overall estimate: ${s}/100` : 'Not scored yet')}
    >
      {s != null ? s : '–'}
      <span className="audit-max">/100</span>
    </span>
  )
}

/** Legacy name kept so existing imports resolve; renders the analytical value. */
export function ScoreRing(props: { score: number | null; size?: number; label?: string }) {
  return <ScoreValue score={props.score} label={props.label} />
}

export function EmptyState(props: { icon: React.ReactNode; title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{props.icon}</div>
      <div style={{ fontWeight: 600, fontSize: 13.5 }}>{props.title}</div>
      {props.hint && <div className="muted" style={{ maxWidth: 400, fontSize: 12.5, lineHeight: 1.55 }}>{props.hint}</div>}
      {props.action}
    </div>
  )
}

export function Field(props: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <label className="field-label">{props.label}</label>
      {props.children}
      {props.hint && <div className="field-hint">{props.hint}</div>}
    </div>
  )
}

export function Switch(props: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <div className="switch-row">
      <div>
        <div style={{ fontSize: 12.5, fontWeight: 550 }}>{props.label}</div>
        {props.hint && <div className="field-hint">{props.hint}</div>}
      </div>
      <button
        className={`switch ${props.checked ? 'on' : ''}`}
        role="switch"
        aria-checked={props.checked}
        aria-label={props.label}
        disabled={props.disabled}
        onClick={() => props.onChange(!props.checked)}
      />
    </div>
  )
}

export function ToastIcon({ level }: { level: 'info' | 'success' | 'warn' | 'error' }) {
  if (level === 'success') return <CheckCircle2 size={14} color="var(--success)" />
  if (level === 'error') return <XCircle size={14} color="var(--danger)" />
  if (level === 'warn') return <AlertTriangle size={14} color="var(--warn)" />
  return <Info size={14} color="var(--accent)" />
}

export function Spinner({ size = 13 }: { size?: number }) {
  return (
    <svg className="spin" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-label="Loading">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = bytes
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

/** "2h ago" / "3d ago" — for compact last-modified display. */
export function formatRelative(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`
  return new Date(t).toLocaleDateString()
}
