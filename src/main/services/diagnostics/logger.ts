import fs from 'node:fs'
import path from 'node:path'

/**
 * Structured logger: timestamp · subsystem · operation · status · message.
 * Secrets never reach logs — redaction runs on every line (SECURITY.md).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  time: string
  level: LogLevel
  subsystem: string
  operation: string
  message: string
  data?: unknown
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{6,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{6,}/gi,
  /("(?:api[-_]?key|key|token|secret|password|authorization)"\s*[:=]\s*")[^"]{4,}(")/gi,
  /\bxoxb-[A-Za-z0-9-]+/g,
  /\bAIza[A-Za-z0-9_-]{10,}\b/g
]

export function redact(text: string): string {
  let out = text
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (m, p1, p2) => {
      if (p1 !== undefined && p2 !== undefined) return `${p1}***${p2}`
      return `${m.slice(0, 4)}…***`
    })
  }
  return out
}

export interface Logger {
  debug(subsystem: string, operation: string, message: string, data?: unknown): void
  info(subsystem: string, operation: string, message: string, data?: unknown): void
  warn(subsystem: string, operation: string, message: string, data?: unknown): void
  error(subsystem: string, operation: string, message: string, data?: unknown): void
  recentErrors(limit: number): LogEntry[]
  setLevel(level: LogLevel): void
  logFile(): string
}

export function createLogger(opts: { logsDir: string; level: LogLevel }): Logger {
  let level = opts.level
  const recent: LogEntry[] = []
  const date = new Date().toISOString().slice(0, 10)
  const file = path.join(opts.logsDir, `app-${date}.log`)

  function write(entry: LogEntry): void {
    if (LEVEL_ORDER[entry.level] < LEVEL_ORDER[level]) return
    const line = redact(JSON.stringify(entry))
    recent.push(entry)
    if (recent.length > 200) recent.splice(0, recent.length - 200)
    try {
      fs.appendFileSync(file, line + '\n')
    } catch {
      /* logging must never crash the app */
    }
    const consoleMsg = `[${entry.subsystem}] ${entry.operation}: ${entry.message}`
    if (entry.level === 'error') console.error(consoleMsg)
    else if (entry.level === 'warn') console.warn(consoleMsg)
    else console.log(consoleMsg)
  }

  return {
    debug: (subsystem, operation, message, data) => write({ time: new Date().toISOString(), level: 'debug', subsystem, operation, message, data }),
    info: (subsystem, operation, message, data) => write({ time: new Date().toISOString(), level: 'info', subsystem, operation, message, data }),
    warn: (subsystem, operation, message, data) => write({ time: new Date().toISOString(), level: 'warn', subsystem, operation, message, data }),
    error: (subsystem, operation, message, data) => write({ time: new Date().toISOString(), level: 'error', subsystem, operation, message, data }),
    recentErrors: (limit) => recent.filter((e) => e.level === 'error' || e.level === 'warn').slice(-limit),
    setLevel: (l) => {
      level = l
    },
    logFile: () => file
  }
}
