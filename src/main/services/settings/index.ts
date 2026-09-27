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

export function updateSettings(ctx: AppContext, patch: Record<string, unknown>): AppSettings {
  const current = settingsRepo.load(ctx.db)
  const merged: Record<string, unknown> = {}
  for (const key of Object.keys(current)) {
    const sectionPatch = patch[key]
    merged[key] =
      sectionPatch && typeof sectionPatch === 'object' && !Array.isArray(sectionPatch)
        ? { ...(current[key as keyof typeof current] as object), ...(sectionPatch as object) }
        : current[key as keyof typeof current]
  }
  const parsed = appSettingsSchema.safeParse(merged)
  if (!parsed.success) {
    throw new AppError('SETTINGS_INVALID', 'The settings update failed validation.', 'Check the values and try again.', parsed.error.message)
  }
  settingsRepo.save(ctx.db, parsed.data)
  if (parsed.data.advanced.logLevel) ctx.logger.setLevel(parsed.data.advanced.logLevel)
  return parsed.data
}
