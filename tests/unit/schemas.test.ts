import { describe, it, expect } from 'vitest'
import {
  rawCandidateSchema, rawScoresSchema, ipcPayloads, appSettingsSchema
} from '@shared/schemas'

describe('AI output schemas (defense against model drift)', () => {
  const goodCandidate = {
    startSegmentId: 1,
    endSegmentId: 4,
    title: 'A moment',
    clipType: 'advice'
  }

  it('accepts a minimal candidate and applies defaults', () => {
    const parsed = rawCandidateSchema.parse(goodCandidate)
    expect(parsed.hook).toBe('')
    expect(parsed.reason).toBe('')
  })

  it('rejects unknown clip types', () => {
    expect(rawCandidateSchema.safeParse({ ...goodCandidate, clipType: 'viral-banger' }).success).toBe(false)
  })

  it('rejects non-integer or negative segment ids', () => {
    expect(rawCandidateSchema.safeParse({ ...goodCandidate, startSegmentId: 1.5 }).success).toBe(false)
    expect(rawCandidateSchema.safeParse({ ...goodCandidate, startSegmentId: -1 }).success).toBe(false)
  })

  it('rejects scores outside 0–100', () => {
    const base = { candidateIndex: 0, hook: 50, contextCompleteness: 50, clarity: 50, retention: 50, emotionalImpact: 50, standaloneValue: 50, shareability: 50, visualSuitability: 50 }
    expect(rawScoresSchema.safeParse({ ...base, hook: 101 }).success).toBe(false)
    expect(rawScoresSchema.safeParse({ ...base, hook: -1 }).success).toBe(false)
    expect(rawScoresSchema.safeParse(base).success).toBe(true)
  })
})

describe('IPC payload validation (the explicit bridge contract)', () => {
  it('every declared API method has a payload schema', () => {
    for (const method of Object.keys(ipcPayloads)) {
      expect(ipcPayloads[method as keyof typeof ipcPayloads]).toBeDefined()
    }
    // every method the renderer can call must be present (exhaustive list)
    const expected = [
      'app.getInfo', 'app.diagnostics', 'app.checkDependencies',
      'projects.list', 'projects.create', 'projects.get', 'projects.rename', 'projects.delete',
      'projects.storage', 'projects.updateSettings',
      'media.importFile', 'media.importUrl', 'media.checkUrl', 'media.pickSourceFile', 'media.pickTranscriptFile',
      'media.checkPlayback', 'media.renderProxy', 'media.filmstrip', 'media.waveform',
      'transcript.get', 'transcript.start', 'transcript.import',
      'analysis.providers', 'analysis.start', 'analysis.getCandidates', 'analysis.updateCandidate',
      'analysis.detectSilence',
      'clips.list', 'clips.createFromCandidate', 'clips.update', 'clips.delete', 'clips.generateMetadata',
      'clips.optimizeBoundaries',
      'renders.queue', 'renders.list', 'renders.cancel', 'renders.retry',
      'tasks.list', 'tasks.cancel', 'tasks.resume', 'tasks.discard',
      'settings.get', 'settings.update', 'settings.setSecret', 'settings.deleteSecret',
      'settings.secretHints', 'settings.testAiProvider',
      'exports.run',
      'system.revealPath', 'system.copyToClipboard', 'system.openLogsFolder', 'system.exportDiagnostics', 'system.fontUrl'
    ]
    expect(Object.keys(ipcPayloads).sort()).toEqual([...expected].sort())
  })

  it('projects.create requires a non-empty name', () => {
    expect(ipcPayloads['projects.create'].safeParse({ name: 'My project' }).success).toBe(true)
    expect(ipcPayloads['projects.create'].safeParse({ name: '' }).success).toBe(false)
    expect(ipcPayloads['projects.create'].safeParse({ name: 'x', description: 'extra' }).success).toBe(false) // strict
  })

  it('projects.delete defaults confirm to false (backend refuses without an explicit true)', () => {
    const noConfirm = ipcPayloads['projects.delete'].safeParse({ id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })
    expect(noConfirm.success).toBe(true)
    if (noConfirm.success) expect(noConfirm.data.confirm).toBe(false)
    const confirmed = ipcPayloads['projects.delete'].safeParse({ id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', confirm: true })
    expect(confirmed.success).toBe(true)
    if (confirmed.success) expect(confirmed.data.confirm).toBe(true)
  })
})

describe('app settings schema', () => {
  it('rejects an empty object (validation-only — defaults live in settingsRepo)', () => {
    expect(appSettingsSchema.safeParse({}).success).toBe(false)
  })

  it('accepts a complete settings object', () => {
    const parsed = appSettingsSchema.safeParse({
      general: { firstRunCompleted: true },
      ai: {
        activeProvider: 'none',
        openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', temperature: 0.2, maxTokens: 4096, jsonMode: true, supportsAudio: false },
        anthropic: { baseUrl: '', model: 'claude-sonnet-4-5', temperature: 0.2, maxTokens: 4096, jsonMode: false, supportsAudio: false }
      },
      transcription: { providerId: 'import-file', language: 'auto', whisperModel: 'base', whisperCompute: 'int8' },
      video: {
        targetDurationPreset: 'medium', crf: 20, renderPreset: 'veryfast', useHardwareEncoder: true, audioNormalize: true,
        defaultResolution: '1080p', defaultQuality: 'standard', hardwareEncoding: 'auto',
        silence: { mode: 'auto', minSilenceMs: 700, paddingMs: 130, maxCutSec: 8 }
      },
      captions: { defaultStyleId: 'classic' },
      export: { preset: 'tiktok', filenameTemplate: '{index}_{slug}', includeMetadataFiles: true },
      advanced: { ffmpegPath: '', ffprobePath: '', logLevel: 'info', renderConcurrency: 2 }
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects unknown resolution/quality/silence values', () => {
    const base = {
      general: { firstRunCompleted: true },
      ai: {
        activeProvider: 'none',
        openai: { baseUrl: '', model: '', temperature: 0.2, maxTokens: 4096, jsonMode: true, supportsAudio: false },
        anthropic: { baseUrl: '', model: '', temperature: 0.2, maxTokens: 4096, jsonMode: false, supportsAudio: false }
      },
      transcription: { providerId: 'import-file', language: 'auto', whisperModel: 'base', whisperCompute: 'int8' },
      captions: { defaultStyleId: 'classic' },
      export: { preset: 'tiktok', filenameTemplate: '{index}_{slug}', includeMetadataFiles: true },
      advanced: { ffmpegPath: '', ffprobePath: '', logLevel: 'info', renderConcurrency: 2 }
    }
    expect(
      appSettingsSchema.safeParse({
        ...base,
        video: { targetDurationPreset: 'medium', crf: 20, renderPreset: 'veryfast', useHardwareEncoder: true, audioNormalize: true, defaultResolution: '480p', defaultQuality: 'standard', hardwareEncoding: 'auto', silence: { mode: 'auto', minSilenceMs: 700, paddingMs: 130, maxCutSec: 8 } }
      }).success
    ).toBe(false)
    expect(
      appSettingsSchema.safeParse({
        ...base,
        video: { targetDurationPreset: 'medium', crf: 20, renderPreset: 'veryfast', useHardwareEncoder: true, audioNormalize: true, defaultResolution: '1080p', defaultQuality: 'ultra', hardwareEncoding: 'auto', silence: { mode: 'auto', minSilenceMs: 700, paddingMs: 130, maxCutSec: 8 } }
      }).success
    ).toBe(false)
  })

  it('rejects out-of-range values', () => {
    expect(appSettingsSchema.safeParse({
      general: { firstRunCompleted: true },
      ai: {
        activeProvider: 'none',
        openai: { baseUrl: '', model: '', temperature: 5, maxTokens: 4096, jsonMode: true, supportsAudio: false },
        anthropic: { baseUrl: '', model: '', temperature: 0.2, maxTokens: 4096, jsonMode: false, supportsAudio: false }
      },
      transcription: { providerId: 'import-file', language: 'auto', whisperModel: 'base', whisperCompute: 'int8' },
      video: { targetDurationPreset: 'medium', crf: 99, renderPreset: 'veryfast', useHardwareEncoder: true, audioNormalize: true, defaultResolution: '1080p', defaultQuality: 'standard', hardwareEncoding: 'auto', silence: { mode: 'auto', minSilenceMs: 700, paddingMs: 130, maxCutSec: 8 } },
      captions: { defaultStyleId: 'classic' },
      export: { preset: 'tiktok', filenameTemplate: '{index}_{slug}', includeMetadataFiles: true },
      advanced: { ffmpegPath: '', ffprobePath: '', logLevel: 'info', renderConcurrency: 2 }
    }).success).toBe(false)
  })
})
