import type { StructuredError } from './types'

/**
 * Application error with a code, a human-readable message and an optional
 * hint. Every error surfaced to the UI must answer: what happened, why it
 * might have happened, and what the user can do now.
 */
export class AppError extends Error {
  readonly code: string
  readonly hint?: string
  readonly details?: string

  constructor(code: string, message: string, hint?: string, details?: string) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.hint = hint
    this.details = details
  }

  toStructured(): StructuredError {
    return { code: this.code, message: this.message, hint: this.hint, details: this.details }
  }
}

export function toStructuredError(err: unknown): StructuredError {
  if (err instanceof AppError) return err.toStructured()
  if (err instanceof Error) {
    return {
      code: 'INTERNAL',
      message: err.message || 'An unexpected error occurred.',
      hint: 'Try again. If the problem repeats, check the logs (Settings → Advanced → Open logs).'
    }
  }
  return {
    code: 'INTERNAL',
    message: typeof err === 'string' ? err : 'An unexpected error occurred.'
  }
}

/** Result envelope used by the HTTP transport and internal service calls. */
export type Result<T> = { ok: true; value: T } | { ok: false; error: StructuredError }

export function ok<T>(value: T): Result<T> {
  return { ok: true, value }
}

export function fail<T = never>(error: StructuredError): Result<T> {
  return { ok: false, error }
}
