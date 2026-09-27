import fs from 'node:fs'

/**
 * SecretStore: provider API keys in <workspace>/secrets.json (mode 0600),
 * optionally encrypted with the OS keychain (Electron safeStorage) via an
 * injected codec. Secrets never enter the database, logs, diagnostics, or
 * the renderer — only masked hints (SECURITY.md).
 */

export interface SecretCodec {
  /** Returns null when the platform keychain is unavailable. */
  encrypt(plain: string): string | null
  decrypt(payload: string): string | null
}

const PLAIN_CODEC: SecretCodec = { encrypt: (p) => `plain:${p}`, decrypt: (p) => (p.startsWith('plain:') ? p.slice(6) : null) }

export class SecretStore {
  private cache: Record<string, string> | null = null
  private codec: SecretCodec

  constructor(private file: string, codec?: SecretCodec) {
    this.codec = codec ?? PLAIN_CODEC
  }

  private load(): Record<string, string> {
    if (this.cache) return this.cache
    try {
      if (fs.existsSync(this.file)) {
        this.cache = JSON.parse(fs.readFileSync(this.file, 'utf-8'))
      }
    } catch {
      this.cache = {}
    }
    return (this.cache ??= {})
  }

  private flush(data: Record<string, string>): void {
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 })
    fs.renameSync(tmp, this.file)
    this.cache = data
  }

  set(key: string, value: string): void {
    const data = this.load()
    const encrypted = this.codec.encrypt(value)
    data[key] = encrypted ?? `plain:${value}`
    this.flush(data)
  }

  get(key: string): string | null {
    const raw = this.load()[key]
    if (!raw) return null
    return this.codec.decrypt(raw) ?? (raw.startsWith('plain:') ? raw.slice(6) : null)
  }

  delete(key: string): void {
    const data = this.load()
    delete data[key]
    this.flush(data)
  }

  /** Masked hints for the renderer: `sk-…4f2a` */
  hints(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [key, raw] of Object.entries(this.load())) {
      const value = this.codec.decrypt(raw) ?? (raw.startsWith('plain:') ? raw.slice(6) : '')
      if (value) out[key] = `${value.slice(0, 3)}…${value.slice(-4)}`
    }
    return out
  }

  encryptionWarning(): string | null {
    return this.codec === PLAIN_CODEC
      ? 'API keys are stored in a protected local file (mode 0600), not encrypted with the OS keychain.'
      : null
  }
}
