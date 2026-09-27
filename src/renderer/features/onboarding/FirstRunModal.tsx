import React, { useState } from 'react'
import { ShieldCheck, HardDrive, Cpu, KeyRound, ArrowRight } from 'lucide-react'
import { api } from '../../api/client'
import { useAppStore } from '../../stores/app'

/**
 * First-run experience (spec §84): welcome, local-first philosophy, real
 * dependency check, and a path to provider setup — without a forced wizard.
 */
export function FirstRunModal() {
  const app = useAppStore()
  const [step, setStep] = useState(0)

  async function finish() {
    await app.saveSettings({ general: { firstRunCompleted: true } })
  }

  const deps = app.dependencies
  const missing = deps.filter((d) => !d.available && (d.id === 'ffmpeg' || d.id === 'ffprobe'))

  return (
    <div className="modal-backdrop">
      <div className="modal wide" role="dialog" aria-label="Welcome">
        <div className="modal-head">
          <div className="modal-title">{step === 0 ? 'Welcome to Clipwright Studio' : 'Environment check'}</div>
        </div>
        <div className="modal-body">
          {step === 0 ? (
            <>
              <div className="row" style={{ gap: 12 }}>
                <ShieldCheck size={20} color="var(--success)" />
                <div>
                  <strong>Local-first by design.</strong>
                  <div className="muted" style={{ fontSize: 13, marginTop: 3 }}>
                    Your videos are processed on this machine with FFmpeg. Nothing is uploaded, and the app contains no
                    telemetry of any kind.
                  </div>
                </div>
              </div>
              <div className="row" style={{ gap: 12 }}>
                <KeyRound size={20} color="var(--warn)" />
                <div>
                  <strong>AI is optional and modular.</strong>
                  <div className="muted" style={{ fontSize: 13, marginTop: 3 }}>
                    Clip discovery works offline with the built-in heuristic analyzer. If you connect an AI provider
                    (Settings → AI), only transcript text is ever sent — never your video files.
                  </div>
                </div>
              </div>
              <div className="row" style={{ gap: 12 }}>
                <HardDrive size={20} color="var(--accent)" />
                <div>
                  <strong>You stay in control.</strong>
                  <div className="muted" style={{ fontSize: 13, marginTop: 3 }}>
                    The AI recommends moments and explains why. Every clip, caption, crop and description stays editable,
                    and scores are always labeled as estimates — never guarantees.
                  </div>
                </div>
              </div>
            </>
          ) : (
            <>
              {deps.map((d) => (
                <div className="dep-row" key={d.id}>
                  <span className={`status ${d.available ? 'success' : 'danger'}`}><span className="dot" /></span>
                  <span className="dep-name">{d.label}</span>
                  <span className="dep-msg">{d.message}</span>
                </div>
              ))}
              {missing.length > 0 && (
                <div className="error-box">
                  <div className="error-title">Core media tools are missing</div>
                  <div className="error-hint">Rendering and media analysis need FFmpeg. Set a custom path in Settings → Advanced or reinstall the app.</div>
                </div>
              )}
              <div className="tiny">
                Workspace: <span className="mono">{app.appInfo?.workspaceRoot}</span> — this is where projects, transcripts and
                renders are stored. You can inspect it any time.
              </div>
            </>
          )}
        </div>
        <div className="modal-foot">
          {step === 0 ? (
            <>
              <button className="btn ghost" onClick={() => void finish()}>
                Skip
              </button>
              <button className="btn primary" onClick={() => setStep(1)}>
                Check environment <ArrowRight size={14} />
              </button>
            </>
          ) : (
            <>
              <button className="btn ghost" onClick={() => setStep(0)}>
                Back
              </button>
              <button className="btn primary" onClick={() => void finish()}>
                <Cpu size={14} /> Start creating
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
