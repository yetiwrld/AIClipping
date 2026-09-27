import type { AppSettings } from '@shared/types'
import { appSettingsSchema } from '@shared/schemas'
import { AppError } from '@shared/errors'
import type { AppContext } from '../app-context'
import { settingsRepo } from '../database/repositories'

export { SecretStore, type SecretCodec } from './secrets'

/**
 * App settings (general/ai/transcription/video/captions/export/advanced).
 * Stored as one JSON document in SQLite; validated with zod on read+write.
 */

export function getSettings(ctx: AppContext): AppSettings {
  return settingsRepo.load(ctx.db)
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export function updateSettings(ctx: AppContext, patch: Record<string, unknown>): AppSettings {
  const current = settingsRepo.load(ctx.db)
  // Two-level merge: section (ai/video/…) → provider or field. The settings
  // forms send partial patches like { ai: { openai: { baseUrl } } }; replacing
  // ai.openai wholesale would drop the sibling fields and fail validation.
  const merged: Record<string, unknown> = {}
  for (const key of Object.keys(current)) {
    const sectionPatch = patch[key]
    if (!isPlainObject(sectionPatch)) {
      merged[key] = current[key as keyof typeof current]
      continue
    }
    const section: Record<string, unknown> = { ...(current[key as keyof typeof current] as unknown as Record<string, unknown>) }
    for (const sub of Object.keys(sectionPatch)) {
      const subPatch = sectionPatch[sub]
      section[sub] = isPlainObject(subPatch) && isPlainObject(section[sub])
        ? { ...(section[sub] as Record<string, unknown>), ...subPatch }
        : subPatch
    }
    merged[key] = section
  }
  const parsed = appSettingsSchema.safeParse(merged)
  if (!parsed.success) {
    // Surface the first concrete issue so the user knows which field to fix.
    const first = parsed.error.issues[0]
    const where = first ? `${first.path.join('.') || 'settings'}: ` : ''
    throw new AppError(
      'SETTINGS_INVALID',
      `The settings update failed validation — ${where}${first?.message ?? 'check the values and try again.'}`,
      'Fix the highlighted field and save again.',
      parsed.error.message
    )
  }
  settingsRepo.save(ctx.db, parsed.data)
  if (parsed.data.advanced.logLevel) ctx.logger.setLevel(parsed.data.advanced.logLevel)
  return parsed.data
}
