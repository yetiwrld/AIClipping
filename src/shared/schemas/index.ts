import { z } from 'zod'

/**
 * Zod schemas. Everything crossing a trust boundary passes through one of
 * these: IPC payloads, AI output, imported transcript files, settings.
 */

// ------------------------------------------------------------------ primitives

export const uuidSchema = z.string().min(8).max(64)
export const isoDateSchema = z.string().min(4)

// ------------------------------------------------------------------ settings

const httpUrlOrEmpty = z
  .string()
  .max(300)
  .refine(
    (v) => {
      if (v === '') return true
      try {
        const u = new URL(v)
        return u.protocol === 'http:' || u.protocol === 'https:'
      } catch {
        return false
      }
    },
    { message: 'Base URL must be a complete http(s) URL, e.g. https://api.gonkarouter.io/v1' }
  )

export const aiProviderRuntimeConfigSchema = z.object({
  baseUrl: httpUrlOrEmpty,
  model: z.string().max(120),
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().min(64).max(128000),
  jsonMode: z.boolean(),
  supportsAudio: z.boolean(),
  authStyle: z.enum(['bearer', 'x-api-key', 'both']).optional()
})

export const appSettingsSchema = z.object({
  general: z.object({
    firstRunCompleted: z.boolean()
  }),
  ai: z.object({
    activeProvider: z.enum(['heuristic-local', 'openai-compatible', 'anthropic', 'none']),
    openai: aiProviderRuntimeConfigSchema,
    anthropic: aiProviderRuntimeConfigSchema
  }),
  transcription: z.object({
    providerId: z.enum(['import-file', 'faster-whisper-local', 'openai-compatible']),
    language: z.string().max(12),
    whisperModel: z.enum(['tiny', 'base', 'small', 'medium']),
    whisperCompute: z.enum(['auto', 'int8', 'float16'])
  }),
  video: z.object({
    targetDurationPreset: z.enum(['short', 'medium', 'long', 'mixed']),
    renderPreset: z.enum(['ultrafast', 'veryfast', 'medium', 'slow']),
    crf: z.number().int().min(0).max(51),
    useHardwareEncoder: z.boolean(),
    audioNormalize: z.boolean(),
    codec: z.enum(['h264', 'hevc']),
    /** Default resolution/quality tiers for new clips. */
    defaultResolution: z.enum(['720p', '1080p', '1440p', '2160p']),
    defaultQuality: z.enum(['draft', 'standard', 'high', 'maximum']),
    /** Encoder selection: auto (hw when available), cpu, or hardware-only. */
    hardwareEncoding: z.enum(['auto', 'cpu', 'hardware']),
    silence: z.object({
      mode: z.enum(['off', 'auto', 'aggressive', 'custom']),
      minSilenceMs: z.number().int().min(200).max(5000),
      paddingMs: z.number().int().min(0).max(1000),
      maxCutSec: z.number().int().min(0).max(30)
    })
  }),
  captions: z.object({
    defaultStyleId: z.string().max(40)
  }),
  export: z.object({
    preset: z.enum(['tiktok', 'reels', 'shorts', 'generic']),
    includeMetadataFiles: z.boolean(),
    filenameTemplate: z.string().max(80)
  }),
  advanced: z.object({
    logLevel: z.enum(['debug', 'info', 'warn', 'error']),
    renderConcurrency: z.number().int().min(1).max(4),
    ffmpegPath: z.string().max(400),
    ffprobePath: z.string().max(400)
  })
})

// ------------------------------------------------------------------ transcript

export const wordTimingSchema = z.object({
  word: z.string().min(1).max(120),
  start: z.number().min(0),
  end: z.number().min(0)
})

export const transcriptResultSchema = z.object({
  language: z.string().max(12).nullish(),
  segments: z
    .array(
      z.object({
        start: z.number().min(0),
        end: z.number().min(0),
        text: z.string().min(1).max(4000),
        speaker: z.string().max(60).nullish(),
        confidence: z.number().min(0).max(1).nullish(),
        words: z.array(wordTimingSchema).nullish()
      })
    )
    .min(1)
})

// ----------------------------------------------------------------- AI output

/** Raw candidate exactly as the model must return it (segment ids, not times). */
export const rawCandidateSchema = z.object({
  startSegmentId: z.number().int().min(0),
  endSegmentId: z.number().int().min(0),
  title: z.string().min(1).max(140),
  hook: z.string().max(240).default(''),
  reason: z.string().max(1200).default(''),
  clipType: z
    .enum([
      'strong-opinion',
      'story',
      'advice',
      'surprising-fact',
      'emotional-moment',
      'debate',
      'humor',
      'transformation',
      'lesson',
      'question-answer',
      'quote',
      'other'
    ])
    .default('other'),
  transcript: z.string().max(6000).optional()
})

export const rawCandidatesResponseSchema = z.object({
  candidates: z.array(rawCandidateSchema).min(1)
})

/** Raw audit scores as returned by the scoring pass. */
export const rawScoresSchema = z.object({
  candidateIndex: z.number().int().min(0),
  hook: z.number().min(0).max(100),
  contextCompleteness: z.number().min(0).max(100),
  clarity: z.number().min(0).max(100),
  retention: z.number().min(0).max(100),
  emotionalImpact: z.number().min(0).max(100),
  standaloneValue: z.number().min(0).max(100),
  shareability: z.number().min(0).max(100),
  visualSuitability: z.number().min(0).max(100),
  explanation: z.string().max(2000).default('')
})

export const rawScoresResponseSchema = z.object({
  scores: z.array(rawScoresSchema).min(1)
})

export const rawMetadataResponseSchema = z.object({
  title: z.string().min(1).max(160),
  description: z.string().max(1200).default(''),
  hashtags: z.array(z.string().min(1).max(60)).max(15).default([]),
  cta: z.string().max(160).default('')
})

// ------------------------------------------------------------------ clips

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected a #rrggbb color')

export const captionOverridesSchema = z.object({
  fontSizePct: z.number().min(1.5).max(9).optional(),
  positionY: z.number().min(0.05).max(0.95).optional(),
  emphasis: z.boolean().optional(),
  uppercase: z.boolean().optional(),
  maxWordsPerCue: z.number().int().min(1).max(10).optional(),
  textColor: hexColor.optional(),
  highlightColor: hexColor.optional(),
  boxOpacity: z.number().min(0).max(1).optional(),
  outlineWidth: z.number().min(0).max(12).optional(),
  shadow: z.number().min(0).max(12).optional()
})

export const silenceRangeSchema = z.object({
  start: z.number().min(0),
  end: z.number().min(0)
}).refine((r) => r.end > r.start, 'end must be after start')

export const clipPatchSchema = z.object({
  startTime: z.number().min(0).optional(),
  endTime: z.number().min(0).optional(),
  aspectRatio: z.enum(['9:16', '1:1', '4:5', '16:9']).optional(),
  cropMode: z.enum(['fit', 'center', 'top', 'bottom', 'smart', 'manual']).optional(),
  cropX: z.number().min(0).max(1).optional(),
  zoom: z.number().min(1).max(3).optional(),
  captionStyleId: z.string().max(40).optional(),
  captionOverrides: captionOverridesSchema.optional(),
  captionTextEdits: z.record(z.string(), z.string()).optional(),
  captionCueSplits: z.record(z.string(), z.number().int().min(1).max(20)).optional(),
  captionCueMerges: z.record(z.string(), z.boolean()).optional(),
  captionTimingOffsets: z.record(z.string(), z.number().min(-5).max(5)).optional(),
  silenceCuts: z.array(silenceRangeSchema).max(400).optional(),
  smartCropKeyframes: z
    .array(
      z.object({
        start: z.number().min(0),
        end: z.number().min(0),
        x: z.number().min(0),
        y: z.number().min(0),
        w: z.number().int().min(2),
        h: z.number().int().min(2)
      })
    )
    .max(64)
    .optional(),
  outputResolution: z.enum(['720p', '1080p', '1440p', '2160p']).optional(),
  outputQuality: z.enum(['draft', 'standard', 'high', 'maximum']).optional(),
  outputFps: z.enum(['source', '24', '25', '30', '50', '60']).optional(),
  title: z.string().max(200).optional(),
  description: z.string().max(4000).optional(),
  hashtags: z.array(z.string().max(60)).max(20).optional(),
  cta: z.string().max(200).optional()
})

export const candidatePatchSchema = z.object({
  status: z.enum(['discovered', 'approved', 'rejected', 'converted']).optional()
})

// ------------------------------------------------------------------ IPC payloads

export const ipcPayloads = {
  'app.getInfo': z.object({}).strict(),
  'app.diagnostics': z.object({}).strict(),
  'app.checkDependencies': z.object({}).strict(),

  'projects.list': z.object({}).strict(),
  'projects.create': z.object({ name: z.string().min(1).max(120) }).strict(),
  'projects.get': z.object({ id: uuidSchema }).strict(),
  'projects.rename': z.object({ id: uuidSchema, name: z.string().min(1).max(120) }).strict(),
  'projects.delete': z
    .object({ id: uuidSchema, confirm: z.boolean().default(false) })
    .strict(),
  'projects.storage': z.object({ id: uuidSchema }).strict(),
  'projects.updateSettings': z
    .object({
      id: uuidSchema,
      settings: z.object({
        durationPreset: z.enum(['short', 'medium', 'long', 'mixed']).optional(),
        maxCandidates: z.number().int().min(1).max(40).optional()
      })
    })
    .strict(),

  'media.checkUrl': z.object({ url: z.string().min(1).max(2000) }).strict(),
  'media.importFile': z.object({ projectId: uuidSchema, filePath: z.string().min(1).max(1000).optional() }).strict(),
  'media.importUrl': z.object({ projectId: uuidSchema, url: z.string().url() }).strict(),
  'media.checkPlayback': z.object({ projectId: uuidSchema }).strict(),
  'media.renderProxy': z.object({ projectId: uuidSchema }).strict(),
  'media.filmstrip': z
    .object({ projectId: uuidSchema, count: z.number().int().min(6).max(48).default(24) })
    .strict(),
  'media.waveform': z
    .object({ projectId: uuidSchema, buckets: z.number().int().min(10).max(4000).default(1200) })
    .strict(),
  'media.pickSourceFile': z.object({}).strict(),
  'media.pickTranscriptFile': z.object({}).strict(),

  'transcript.get': z.object({ projectId: uuidSchema }).strict(),
  'transcript.start': z
    .object({
      projectId: uuidSchema,
      providerId: z.enum(['faster-whisper-local', 'openai-compatible'])
    })
    .strict(),
  'transcript.import': z
    .object({ projectId: uuidSchema, filePath: z.string().min(1).max(1000).optional() })
    .strict(),

  'analysis.providers': z.object({}).strict(),
  'analysis.start': z
    .object({
      projectId: uuidSchema,
      providerId: z.enum(['heuristic-local', 'openai-compatible', 'anthropic'])
    })
    .strict()
  ,
  'analysis.getCandidates': z.object({ projectId: uuidSchema }).strict(),

  'analysis.detectSilence': z
    .object({
      clipId: uuidSchema,
      mode: z.enum(['auto', 'aggressive', 'custom']).default('auto'),
      minSilenceMs: z.number().int().min(200).max(5000).optional(),
      paddingMs: z.number().int().min(0).max(1000).optional(),
      maxCutSec: z.number().int().min(0).max(30).optional()
    })
    .strict(),

  'clips.optimizeBoundaries': z.object({ clipId: uuidSchema }).strict(),
  'clips.analyzeSmartCrop': z.object({ clipId: uuidSchema }).strict(),

  'projects.relinkSource': z.object({ id: uuidSchema, filePath: z.string().min(1).max(1000) }).strict(),
  'analysis.updateCandidate': z
    .object({ id: uuidSchema, patch: candidatePatchSchema })
    .strict(),

  'clips.list': z.object({ projectId: uuidSchema }).strict(),
  'clips.createFromCandidate': z.object({ candidateId: uuidSchema }).strict(),
  'clips.update': z.object({ id: uuidSchema, patch: clipPatchSchema }).strict(),
  'clips.delete': z.object({ id: uuidSchema }).strict(),
  'clips.generateMetadata': z.object({ id: uuidSchema }).strict(),

  'renders.queue': z.object({ clipId: uuidSchema, preview: z.boolean().default(false) }).strict(),
  'renders.list': z.object({ projectId: uuidSchema.optional() }).strict(),
  'renders.cancel': z.object({ id: uuidSchema }).strict(),
  'renders.retry': z.object({ id: uuidSchema }).strict(),

  'tasks.list': z.object({ projectId: uuidSchema.optional() }).strict(),
  'tasks.cancel': z.object({ id: uuidSchema }).strict(),
  'tasks.resume': z.object({ id: uuidSchema }).strict(),
  'tasks.discard': z.object({ id: uuidSchema }).strict(),

  'settings.get': z.object({}).strict(),
  'settings.update': z.object({ patch: z.record(z.string(), z.unknown()) }).strict(),
  'settings.setSecret': z.object({ key: z.string().min(1).max(60), value: z.string().min(1).max(400) }).strict(),
  'settings.deleteSecret': z.object({ key: z.string().min(1).max(60) }).strict(),
  'settings.secretHints': z.object({}).strict(),
  'settings.testAiProvider': z
    .object({
      providerId: z.enum(['openai-compatible', 'anthropic']),
      baseUrl: z.string().max(300).default(''),
      model: z.string().max(120).default('')
    })
    .strict(),

  'exports.run': z
    .object({
      clipIds: z.array(uuidSchema).min(1).max(50),
      includeMetadata: z.boolean().default(true)
    })
    .strict(),

  'system.revealPath': z.object({ path: z.string().min(1).max(1000) }).strict(),
  'system.copyToClipboard': z.object({ text: z.string().max(50000) }).strict(),
  'system.openLogsFolder': z.object({}).strict(),
  'system.exportDiagnostics': z.object({}).strict(),
  'system.fontUrl': z.object({ file: z.string().max(120) }).strict()
} as const

export type IpcMethodName = keyof typeof ipcPayloads
