import React, { useState } from 'react'
import {
  Bot, AudioLines, Video, Captions, Package, HardDrive, Wrench, ShieldCheck,
  Download, FolderOpen, KeyRound, Trash2, TestTube2, Save
, RefreshCw, ChevronRight } from 'lucide-react'
import { api, errMessage, isElectron } from '../../api/client'
import { useAppStore } from '../../stores/app'
import { Field, Switch, formatBytes, Spinner, ErrorBox } from '../../components/ui'
import { CAPTION_STYLES, QUALITY_PRESETS, RESOLUTION_PRESETS } from '@shared/constants'
import type { AiProviderRuntimeConfig } from '@shared/types'

type Section = 'ai' | 'transcription' | 'video' | 'captions' | 'export' | 'storage' | 'advanced'

export function SettingsPage() {
  const app = useAppStore()
  const [section, setSection] = useState<Section>('ai')
  const settings = app.settings

  if (!settings) {
    return (
      <div className="page" style={{ display: 'grid', placeItems: 'center' }}>
        <Spinner size={22} />
      </div>
    )
  }

  const sections: Array<{ id: Section; label: string; icon: React.ReactNode }> = [
    { id: 'ai', label: 'AI providers', icon: <Bot size={14} /> },
    { id: 'transcription', label: 'Transcription', icon: <AudioLines size={14} /> },
    { id: 'video', label: 'Video & rendering', icon: <Video size={14} /> },
    { id: 'captions', label: 'Captions', icon: <Captions size={14} /> },
    { id: 'export', label: 'Export', icon: <Package size={14} /> },
    { id: 'storage', label: 'Storage & privacy', icon: <HardDrive size={14} /> },
    { id: 'advanced', label: 'Advanced', icon: <Wrench size={14} /> }
  ]

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Settings</div>
          <div className="page-subtitle">Application preferences — stored locally in the workspace database.</div>
        </div>
      </div>

      <div className="settings-layout">
        <div className="settings-nav">
          {sections.map((s) => (
            <button
              key={s.id}
              className={`nav-item ${section === s.id ? 'active' : ''}`}
              style={{ width: '100%' }}
              onClick={() => setSection(s.id)}
            >
              {s.icon} {s.label}
            </button>
          ))}
        </div>

        <div className="settings-content stack">
          {section === 'ai' && <AiSection />}
          {section === 'transcription' && <TranscriptionSection />}
          {section === 'video' && <VideoSection />}
          {section === 'captions' && <CaptionsSection />}
          {section === 'export' && <ExportSection />}
          {section === 'storage' && <StorageSection />}
          {section === 'advanced' && <AdvancedSection />}
        </div>
      </div>
    </div>
  )
}

// ================================================================== AI ====

function AiSection() {
  const app = useAppStore()
  const settings = app.settings!
  const [hints, setHints] = useState<Record<string, string>>({})
  const [testing, setTesting] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; message: string; endpoint: string; model: string; latencyMs: number | null }>>({})
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({})
  const [error, setError] = useState<unknown>(null)

  React.useEffect(() => {
    void api['settings.secretHints']().then(setHints).catch(() => undefined)
  }, [])

  async function saveProvider(providerId: 'openai' | 'anthropic', patch: Partial<AiProviderRuntimeConfig>) {
    await app.saveSettings({ ai: { [providerId]: patch } as Record<string, unknown> })
  }

  async function saveKey(secretKey: 'ai:openai-compatible' | 'ai:anthropic', value: string) {
    try {
      if (!value.trim()) {
        await api['settings.deleteSecret']({ key: secretKey })
      } else {
        await api['settings.setSecret']({ key: secretKey, value: value.trim() })
      }
      setKeyDraft((d) => ({ ...d, [secretKey]: '' }))
      const h = await api['settings.secretHints']()
      setHints(h)
      await app.bootstrap()
      app.toast({ level: 'success', message: value.trim() ? 'API key stored locally.' : 'API key removed.' })
    } catch (err) {
      setError(err)
    }
  }

  async function test(providerId: 'openai-compatible' | 'anthropic') {
    setTesting(providerId)
    setTestResult((r) => {
      const next = { ...r }
      delete next[providerId]
      return next
    })
    try {
      const result = await api['settings.testAiProvider']({ providerId })
      setTestResult((r) => ({ ...r, [providerId]: result }))
    } catch (err) {
      const { message } = errMessage(err)
      setTestResult((r) => ({ ...r, [providerId]: { ok: false, message, endpoint: '', model: '', latencyMs: null } }))
    } finally {
      setTesting(null)
    }
  }

  return (
    <>
      <div className="settings-section">
        <div className="section-title">Analysis provider</div>
        <div className="field">
          <select
            className="select"
            value={settings.ai.activeProvider}
            onChange={(e) => void app.saveSettings({ ai: { activeProvider: e.target.value } })}
          >
            <option value="none">None — use the local heuristic when analyzing</option>
            <option value="heuristic-local">Local heuristic (offline)</option>
            <option value="openai-compatible">OpenAI-compatible endpoint</option>
            <option value="anthropic">Anthropic (Claude)</option>
          </select>
          <div className="field-hint">
            When an AI provider is active, analysis sends <strong>transcript text only</strong> — never your video files.
          </div>
        </div>
      </div>

      {error && <ErrorBox error={error} />}

      <ProviderForm
        title="OpenAI-compatible endpoint"
        providers="OpenAI, OpenRouter, Groq, Together, LM Studio, Ollama…"
        providerId="openai-compatible"
        secretKey="ai:openai-compatible"
        config={settings.ai.openai}
        hint={hints['ai:openai-compatible']}
        keyDraft={keyDraft['ai:openai-compatible'] ?? ''}
        onKeyDraft={(v) => setKeyDraft((d) => ({ ...d, 'ai:openai-compatible': v }))}
        onSave={(patch) => void saveProvider('openai', patch)}
        onSaveKey={(v) => void saveKey('ai:openai-compatible', v)}
        onTest={() => void test('openai-compatible')}
        testing={testing === 'openai-compatible'}
        testResult={testResult['openai-compatible']}
        audioOption
      />

      <ProviderForm
        title="Anthropic (Claude)"
        providers="Direct Anthropic API"
        providerId="anthropic"
        secretKey="ai:anthropic"
        config={settings.ai.anthropic}
        hint={hints['ai:anthropic']}
        keyDraft={keyDraft['ai:anthropic'] ?? ''}
        onKeyDraft={(v) => setKeyDraft((d) => ({ ...d, 'ai:anthropic': v }))}
        onSave={(patch) => void saveProvider('anthropic', patch)}
        onSaveKey={(v) => void saveKey('ai:anthropic', v)}
        onTest={() => void test('anthropic')}
        testing={testing === 'anthropic'}
        testResult={testResult['anthropic']}
      />

      <div className="settings-section">
        <div className="row">
          <ShieldCheck size={14} color="var(--success)" />
          <strong style={{ fontSize: 13 }}>Privacy — exactly what leaves this machine</strong>
        </div>
        <div className="field-hint" style={{ lineHeight: 1.7, marginTop: 6 }}>
          Import, inspection, thumbnails, reframing, caption burn-in and rendering: <strong>always local</strong>.
          Local Whisper transcription: <strong>always local</strong>. Cloud transcription (only if you select it): the extracted
          audio track is sent to the endpoint you configured. AI analysis and metadata generation (only if you select a provider):
          transcript text is sent. There is no telemetry, no analytics, and no account.
        </div>
      </div>
    </>
  )
}

function ProviderForm(props: {
  title: string
  providers: string
  providerId: 'openai-compatible' | 'anthropic'
  secretKey: string
  config: AiProviderRuntimeConfig
  hint?: string
  keyDraft: string
  onKeyDraft: (v: string) => void
  onSave: (patch: Partial<AiProviderRuntimeConfig>) => void
  onSaveKey: (v: string) => void
  onTest: () => void
  testing: boolean
  testResult?: { ok: boolean; message: string; endpoint: string; model: string; latencyMs: number | null }
  audioOption?: boolean
}) {
  const app = useAppStore()
  const [local, setLocal] = useState(props.config)
  return (
    <div className="settings-section stack">
      <div className="row">
        <div className="section-title" style={{ marginBottom: 0 }}>{props.title}</div>
        <span style={{ flex: 1 }} />
        {props.hint && <span className="chip" title="Stored API key (masked)"><KeyRound size={11} /> {props.hint}</span>}
      </div>
      <div className="tiny">{props.providers}</div>

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field
          label={props.providerId === 'anthropic' ? 'Base URL (blank = official API)' : 'Base URL (e.g. https://api.gonkarouter.io/v1)'}
          hint={props.providerId === 'anthropic' ? undefined : 'OpenAI-compatible chat endpoint. Usually ends with /v1 — /chat/completions is appended automatically.'}
        >
          <input
            className="input"
            defaultValue={local.baseUrl}
            placeholder="https://api.openai.com/v1"
            onBlur={(e) => {
              const v = e.target.value.trim()
              if (v && !/^https?:\/\//i.test(v)) {
                app.toast({ level: 'error', message: 'Base URL must start with http:// or https://', hint: `You entered “${v}” — include the full address, e.g. https://api.gonkarouter.io/v1` })
                return
              }
              setLocal({ ...local, baseUrl: v })
              props.onSave({ baseUrl: v })
            }}
          />
        </Field>
        <Field label="Model" hint="Exactly as your provider lists it — e.g. gpt-4o-mini or zai-org/GLM-5.3-Flash. Never altered by the app.">
          <input className="input" defaultValue={local.model} onBlur={(e) => { setLocal({ ...local, model: e.target.value.trim() }); props.onSave({ model: e.target.value.trim() }) }} placeholder={props.providerId === 'anthropic' ? 'claude-sonnet-4-5' : 'gpt-4o-mini'} />
        </Field>
      </div>

      <Field label={`API key ${props.hint ? '(stored — enter a new one to replace)' : ''}`}>
        <div className="row">
          <input
            className="input"
            type="password"
            placeholder={props.hint ? '•••• stored' : 'sk-…'}
            value={props.keyDraft}
            onChange={(e) => props.onKeyDraft(e.target.value)}
          />
          <button className="btn" onClick={() => props.onSaveKey(props.keyDraft)} disabled={!props.keyDraft.trim() && !props.hint}>
            <Save size={13} /> Save
          </button>
          {props.hint && (
            <button className="btn ghost" title="Remove stored key" onClick={() => props.onSaveKey('')}>
              <Trash2 size={13} />
            </button>
          )}
        </div>
        <div className="field-hint">Keys are stored in a protected local file inside the workspace — never in the database, logs, or diagnostics.</div>
      </Field>

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label={`Temperature — ${local.temperature}`}>
          <input type="range" min={0} max={1} step={0.05} defaultValue={local.temperature}
            onChange={(e) => setLocal({ ...local, temperature: parseFloat(e.target.value) })}
            onMouseUp={() => props.onSave({ temperature: local.temperature })} />
        </Field>
        <Field label="Max output tokens" hint="64 – 128,000. Raise it if replies are cut off mid-JSON.">
          <input className="input" type="number" min={64} max={128000} defaultValue={local.maxTokens}
            onBlur={(e) => { const raw = parseInt(e.target.value, 10); const v = Math.min(128000, Math.max(64, Number.isFinite(raw) ? raw : 4096)); setLocal({ ...local, maxTokens: v }); props.onSave({ maxTokens: v }) }} />
        </Field>
      </div>

      {props.providerId === 'openai-compatible' && (
        <Field label="API key header" hint="Bearer is the OpenAI-compatible standard (OpenAI, OpenRouter, Groq, Together, GonkaRouter). Switch to x-api-key only if your gateway requires it.">
          <select
            className="select"
            value={local.authStyle ?? 'bearer'}
            onChange={(e) => { setLocal({ ...local, authStyle: e.target.value as 'bearer' | 'x-api-key' | 'both' }); props.onSave({ authStyle: e.target.value as 'bearer' | 'x-api-key' | 'both' }) }}
          >
            <option value="bearer">Authorization: Bearer (default)</option>
            <option value="x-api-key">x-api-key</option>
            <option value="both">Send both headers</option>
          </select>
        </Field>
      )}

      <Switch label="Request JSON response format" hint="Some gateways reject response_format — the app automatically retries without it once; disable if errors persist." checked={local.jsonMode} onChange={(v) => { setLocal({ ...local, jsonMode: v }); props.onSave({ jsonMode: v }) }} />
      {props.audioOption && (
        <Switch
          label="This endpoint accepts audio transcription uploads"
          hint="Enables the “Transcribe via cloud” option. OpenAI and Groq do; many chat-only proxies do not."
          checked={local.supportsAudio}
          onChange={(v) => { setLocal({ ...local, supportsAudio: v }); props.onSave({ supportsAudio: v }) }}
        />
      )}

      <div className="row">
        <button className="btn" onClick={props.onTest} disabled={props.testing}>
          {props.testing ? <Spinner size={12} /> : <TestTube2 size={13} />} {props.testing ? 'Testing…' : 'Test connection'}
        </button>
        {props.testResult && (
          <span className={`status ${props.testResult.ok ? 'success' : 'danger'}`}>
            <span className="dot" />
            {props.testResult.ok ? 'Connected' : 'Failed'}
          </span>
        )}
      </div>
      {props.testResult && (
        <div className="field-hint" style={{ lineHeight: 1.6 }}>
          {props.testResult.message}
          <br />
          <span className="tiny">
            Endpoint <span className="mono">{props.testResult.endpoint || '—'}</span>
            {' · '}Model <span className="mono">{props.testResult.model || '—'}</span>
            {props.testResult.latencyMs != null && ` · ${(props.testResult.latencyMs / 1000).toFixed(1)}s`}
          </span>
        </div>
      )}
    </div>
  )
}

// ======================================================== transcription ==

function TranscriptionSection() {
  const app = useAppStore()
  const settings = app.settings!
  const t = settings.transcription
  const local = app.dependencies.find((d) => d.id === 'faster-whisper-local')
  const [rechecking, setRechecking] = React.useState(false)

  async function recheck() {
    setRechecking(true)
    await app.refreshDependencies()
    setRechecking(false)
    const fresh = useAppStore.getState().dependencies.find((d) => d.id === 'faster-whisper-local')
    app.toast(
      fresh?.available
        ? { level: 'success', message: 'Local Whisper is now available.' }
        : { level: 'warn', message: 'Still not detected.', hint: fresh?.message }
    )
  }

  return (
    <div className="settings-section stack">
      <div className="section-title">Transcription</div>
      {local && !local.available && (
        <div className="error-box">
          <div className="error-title">{local.message}</div>
          <div className="field-hint">After installing, press Re-check — no app restart needed.</div>
          <div style={{ marginTop: 8 }}>
            <button className="btn sm" onClick={() => void recheck()} disabled={rechecking}>
              {rechecking ? <Spinner size={11} /> : <RefreshCw size={12} />} {rechecking ? 'Checking…' : 'Re-check'}
            </button>
          </div>
        </div>
      )}
      <Field label="Default provider">
        <select className="select" value={t.providerId} onChange={(e) => void app.saveSettings({ transcription: { providerId: e.target.value } })}>
          <option value="import-file">Import transcript file (offline)</option>
          <option value="faster-whisper-local">Local Whisper — faster-whisper (offline)</option>
          <option value="openai-compatible">OpenAI-compatible cloud endpoint</option>
        </select>
      </Field>
      <Field label="Language" hint="“auto” detects per video.">
        <input className="input" defaultValue={t.language} onBlur={(e) => void app.saveSettings({ transcription: { language: e.target.value } })} placeholder="auto" />
      </Field>
      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Local Whisper model" hint="tiny/fast → medium/accurate. Downloads once, then cached offline.">
          <select className="select" value={t.whisperModel} onChange={(e) => void app.saveSettings({ transcription: { whisperModel: e.target.value } })}>
            <option value="tiny">tiny — fastest</option>
            <option value="base">base — balanced</option>
            <option value="small">small — better</option>
            <option value="medium">medium — best (slow on CPU)</option>
          </select>
        </Field>
        <Field label="Compute type">
          <select className="select" value={t.whisperCompute} onChange={(e) => void app.saveSettings({ transcription: { whisperCompute: e.target.value } })}>
            <option value="int8">int8 — CPU friendly</option>
            <option value="float16">float16 — needs GPU</option>
            <option value="auto">auto</option>
          </select>
        </Field>
      </div>
      <div className="dep-row">
        <span className={`status ${local?.available ? 'success' : 'warn'}`}><span className="dot" /></span>
        <span className="dep-msg">{local?.message ?? 'Checking…'}</span>
      </div>
    </div>
  )
}

// =============================================================== video ===

function VideoSection() {
  const app = useAppStore()
  const settings = app.settings!
  const v = settings.video
  return (
    <div className="settings-section stack">
      <div className="section-title">Video & rendering</div>
      <Field label="Default discovery duration preset">
        <select className="select" value={v.targetDurationPreset} onChange={(e) => void app.saveSettings({ video: { targetDurationPreset: e.target.value } })}>
          <option value="short">Short · 15–30s</option>
          <option value="medium">Medium · 30–60s</option>
          <option value="long">Long · 60–90s</option>
          <option value="mixed">Mixed · 15–90s</option>
        </select>
      </Field>
      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Default output resolution" hint="Applied to new clips; each clip can override it in the editor.">
          <select className="select" value={v.defaultResolution} onChange={(e) => void app.saveSettings({ video: { defaultResolution: e.target.value } })}>
            {RESOLUTION_PRESETS.map((r) => (
              <option key={r.id} value={r.id}>{r.label} — {r.hint}</option>
            ))}
          </select>
        </Field>
        <Field label="Default output quality" hint="Draft is for quick checks; Standard/high/max balance size vs fidelity.">
          <select className="select" value={v.defaultQuality} onChange={(e) => void app.saveSettings({ video: { defaultQuality: e.target.value } })}>
            {QUALITY_PRESETS.map((q) => (
              <option key={q.id} value={q.id}>{q.label} — {q.hint}</option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Encoder">
        <select className="select" value={v.hardwareEncoding} onChange={(e) => void app.saveSettings({ video: { hardwareEncoding: e.target.value } })}>
          <option value="auto">Auto — hardware when available, CPU fallback</option>
          <option value="cpu">CPU (libx264) — most compatible</option>
          <option value="hardware">Hardware only — fail with a clear error if unavailable</option>
        </select>
        <div className="field-hint">
          Hardware encoders: NVENC / QSV / AMF / VideoToolbox. In Auto mode a failed hardware render is retried on CPU automatically.
        </div>
      </Field>
      <details className="inspector-section">
        <summary>
          Advanced export <ChevronRight size={13} className="chev" />
        </summary>
        <div className="inspector-body stack" style={{ gap: 10 }}>
          <Field
            label="Video codec"
            hint="H.264 plays everywhere. HEVC (H.265) is ~30% smaller but older editors/platforms may reject it — choose it only when you know the target supports it."
          >
            <select
              className="select"
              value={v.codec ?? 'h264'}
              onChange={(e) => void app.saveSettings({ video: { codec: e.target.value as 'h264' | 'hevc' } })}
            >
              <option value="h264">H.264 (libx264) — maximum compatibility</option>
              <option value="hevc">HEVC / H.265 (libx265) — smaller files</option>
            </select>
          </Field>
          <div className="field-hint">
            Applies to final renders. Quick preview renders always use H.264 for speed, and hardware encoders are H.264-only.
          </div>
        </div>
      </details>
      <Switch
        label="Normalize loudness (EBU R128)"
        hint="Consistent -16 LUFS across clips — recommended for social platforms."
        checked={v.audioNormalize}
        onChange={(val) => void app.saveSettings({ video: { audioNormalize: val } })}
      />
      <div className="divider" />
      <div className="section-title">Silence detection</div>
      <Field label="Mode">
        <select className="select" value={v.silence.mode} onChange={(e) => void app.saveSettings({ video: { silence: { mode: e.target.value } } })}>
          <option value="off">Off — never suggest silence cuts</option>
          <option value="auto">Standard — balanced detection</option>
          <option value="aggressive">Aggressive — remove shorter pauses too</option>
        </select>
      </Field>
      {v.silence.mode !== 'off' && (
        <div className="grid" style={{ gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          <Field label={`Min silence — ${v.silence.minSilenceMs} ms`}>
            <input type="range" min={200} max={2000} step={50} defaultValue={v.silence.minSilenceMs}
              onMouseUp={(e) => void app.saveSettings({ video: { silence: { minSilenceMs: parseInt((e.target as HTMLInputElement).value, 10) } } })} />
          </Field>
          <Field label={`Padding — ${v.silence.paddingMs} ms`}>
            <input type="range" min={0} max={500} step={10} defaultValue={v.silence.paddingMs}
              onMouseUp={(e) => void app.saveSettings({ video: { silence: { paddingMs: parseInt((e.target as HTMLInputElement).value, 10) } } })} />
          </Field>
          <Field label={`Max single cut — ${v.silence.maxCutSec}s`}>
            <input type="range" min={1} max={20} step={1} defaultValue={v.silence.maxCutSec}
              onMouseUp={(e) => void app.saveSettings({ video: { silence: { maxCutSec: parseInt((e.target as HTMLInputElement).value, 10) } } })} />
          </Field>
        </div>
      )}
      <Field label={`Render concurrency — ${settings.advanced.renderConcurrency}`} hint="More than 1 renders multiple clips at once but multiplies CPU load.">
        <input type="range" min={1} max={4} step={1} defaultValue={settings.advanced.renderConcurrency}
          onMouseUp={(e) => void app.saveSettings({ advanced: { renderConcurrency: parseInt((e.target as HTMLInputElement).value, 10) } })} />
      </Field>
    </div>
  )
}

// ============================================================ captions ===

function CaptionsSection() {
  const app = useAppStore()
  const settings = app.settings!
  return (
    <div className="settings-section stack">
      <div className="section-title">Captions</div>
      <Field label="Default caption style for new clips">
        <select className="select" value={settings.captions.defaultStyleId} onChange={(e) => void app.saveSettings({ captions: { defaultStyleId: e.target.value } })}>
          {CAPTION_STYLES.map((s) => (
            <option key={s.id} value={s.id}>{s.label} — {s.description}</option>
          ))}
        </select>
      </Field>
      <div className="field-hint">
        Per-clip overrides (size, position, emphasis, uppercase, words per cue) are adjustable in the clip editor. Captions are
        burned in at render time with the bundled Inter font, so output looks identical on every machine.
      </div>
    </div>
  )
}

// ============================================================== export ===

function ExportSection() {
  const app = useAppStore()
  const settings = app.settings!
  return (
    <div className="settings-section stack">
      <div className="section-title">Export</div>
      <Field label="Platform preset" hint="Controls metadata generation targets and export defaults.">
        <select className="select" value={settings.export.preset} onChange={(e) => void app.saveSettings({ export: { preset: e.target.value } })}>
          <option value="generic">Generic Vertical</option>
          <option value="tiktok">TikTok</option>
          <option value="reels">Instagram Reels</option>
          <option value="shorts">YouTube Shorts</option>
        </select>
      </Field>
      <Field label="Filename template" hint="Placeholders: {index} {slug} {title} {date}. Windows-illegal characters are always sanitized.">
        <input className="input" defaultValue={settings.export.filenameTemplate} onBlur={(e) => void app.saveSettings({ export: { filenameTemplate: e.target.value } })} />
      </Field>
      <Switch label="Write metadata files (.txt + .json) next to exported clips" checked={settings.export.includeMetadataFiles} onChange={(v) => void app.saveSettings({ export: { includeMetadataFiles: v } })} />
    </div>
  )
}

// ============================================================== storage ==

function StorageSection() {
  const app = useAppStore()
  const [diag, setDiag] = useState<import('@shared/types').DiagnosticsReport | null>(null)
  const [exported, setExported] = useState<string | null>(null)

  React.useEffect(() => {
    void api['app.diagnostics']().then(setDiag).catch(() => undefined)
  }, [])

  return (
    <>
      <div className="settings-section stack">
        <div className="section-title">Storage & privacy</div>
        <div className="tiny">Workspace root</div>
        <div className="mono" style={{ wordBreak: 'break-all' }}>{app.appInfo?.workspaceRoot}</div>
        {diag?.disk && (
          <table className="table">
            <tbody>
              <tr><td style={{ color: 'var(--text-3)' }}>Free disk space</td><td>{formatBytes(diag.disk.freeBytes)}</td></tr>
            </tbody>
          </table>
        )}
        <div className="field-hint">
          Projects keep their own folders (source, transcripts, renders, thumbnails, cache). Deleting a project removes its folder
          after an explicit confirmation; exports are kept.
        </div>
        {isElectron ? (
          <button className="btn" onClick={() => void api['system.openLogsFolder']().catch((e) => app.toast({ level: 'warn', ...errMessage(e) }))}>
            <FolderOpen size={14} /> Open workspace logs
          </button>
        ) : (
          <div className="tiny">Open the workspace folder from the desktop app.</div>
        )}
      </div>

      <div className="settings-section stack">
        <div className="section-title">Diagnostics export</div>
        <div className="field-hint">
          A JSON report with app version, OS, enabled providers, FFmpeg version, schema version, recent error codes and
          non-sensitive configuration. <strong>Never includes API keys.</strong>
        </div>
        <div className="row">
          <button
            className="btn"
            onClick={async () => {
              try {
                const result = await api['system.exportDiagnostics']()
                setExported(result.path)
                app.toast({ level: 'success', message: 'Diagnostics exported.', actionLabel: isElectron ? 'Reveal file' : undefined, action: isElectron ? () => void api['system.revealPath']({ path: result.path }) : undefined })
              } catch (err) {
                app.toast({ level: 'error', ...errMessage(err) })
              }
            }}
          >
            <Download size={14} /> Export diagnostics report
          </button>
          {exported && <span className="tiny mono">{exported}</span>}
        </div>
      </div>
    </>
  )
}

// ============================================================= advanced ==

function AdvancedSection() {
  const app = useAppStore()
  const settings = app.settings!
  const deps = app.dependencies
  const ffmpeg = deps.find((d) => d.id === 'ffmpeg')
  const ffprobe = deps.find((d) => d.id === 'ffprobe')

  return (
    <div className="settings-section stack">
      <div className="section-title">Advanced</div>
      <Field label="FFmpeg path override" hint="Blank = auto-detect (system PATH, then the bundled binary).">
        <input className="input mono" defaultValue={settings.advanced.ffmpegPath} placeholder={ffmpeg?.available ? `auto: ${ffmpeg.message}` : 'not detected'} onBlur={(e) => void app.saveSettings({ advanced: { ffmpegPath: e.target.value } })} />
      </Field>
      <Field label="FFprobe path override">
        <input className="input mono" defaultValue={settings.advanced.ffprobePath} placeholder={ffprobe?.available ? 'auto-detected' : 'not detected'} onBlur={(e) => void app.saveSettings({ advanced: { ffprobePath: e.target.value } })} />
      </Field>
      <Field label="Log level">
        <select className="select" value={settings.advanced.logLevel} onChange={(e) => void app.saveSettings({ advanced: { logLevel: e.target.value } })}>
          <option value="debug">debug — verbose, for support</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </select>
      </Field>
      <div className="divider" />
      <div className="section-title">Dependency status</div>
      {deps.map((d) => (
        <div className="dep-row" key={d.id}>
          <span className={`status ${d.available ? 'success' : 'danger'}`}><span className="dot" /></span>
          <span className="dep-name">{d.label}</span>
          <span className="dep-msg">{d.message}{d.version ? ` (v${d.version})` : ''}</span>
          {!d.available && d.fixHint && <span className="chip warn">{d.fixHint}</span>}
        </div>
      ))}
    </div>
  )
}
