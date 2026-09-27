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
            <button className="btn ghost sm" onClick={props.onClose} aria-label="Close dialog">
              <X size={15} />
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
        <AlertTriangle size={13} style={{ verticalAlign: -2, marginRight: 5 }} />
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
        <div style={{ marginTop: 9 }}>
          <button className="btn sm" onClick={props.onRetry}>
            {props.retryLabel ?? 'Retry'}
          </button>
        </div>
      )}
      {code && <div className="tiny" style={{ marginTop: 6 }}>Code: {code}</div>}
    </div>
  )
}

export function scoreColor(score: number | null | undefined): string {
  if (score == null) return 'var(--text-3)'
  if (score >= 75) return 'var(--success)'
  if (score >= 50) return 'var(--accent)'
  if (score >= 35) return 'var(--warn)'
  return 'var(--danger)'
}

export function ScoreRing(props: { score: number | null; size?: number; label?: string }) {
  const pct = props.score ?? 0
  return (
    <div
      className="score-ring"
      style={{ ['--pct' as string]: pct, ['--size' as string]: `${props.size ?? 46}px`, ['--ring-color' as string]: scoreColor(props.score) }}
      title={props.label ?? (props.score != null ? `Overall estimate: ${props.score}/100` : 'Not scored yet')}
    >
      <span>{props.score != null ? pct : '–'}</span>
    </div>
  )
}

export function EmptyState(props: { icon: React.ReactNode; title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{props.icon}</div>
      <div style={{ fontWeight: 650, fontSize: 15 }}>{props.title}</div>
      {props.hint && <div className="muted" style={{ maxWidth: 420, fontSize: 13 }}>{props.hint}</div>}
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
        <div style={{ fontSize: 13, fontWeight: 550 }}>{props.label}</div>
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
  if (level === 'success') return <CheckCircle2 size={15} color="var(--success)" />
  if (level === 'error') return <XCircle size={15} color="var(--danger)" />
  if (level === 'warn') return <AlertTriangle size={15} color="var(--warn)" />
  return <Info size={15} color="var(--accent)" />
}

export function Spinner({ size = 14 }: { size?: number }) {
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
