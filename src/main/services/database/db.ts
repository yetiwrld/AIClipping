import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import initSqlJs, { type SqlJsDatabase } from 'sql.js'

/**
 * SQLite database backed by sql.js (WASM). Whole-file atomic persistence:
 * `db.export()` → temp file → rename (ADR-003 / ADR-011).
 *
 * Persistence policy: debounced after writes, plus explicit flush points
 * (after every service transaction the caller may `persistNow()`; shutdown
 * always flushes). At our data scale (metadata + transcripts, MBs) a full
 * export is a few milliseconds.
 */
export class AppDatabase {
  private db!: SqlJsDatabase
  private file!: string
  private timer: NodeJS.Timeout | null = null
  private pending = false
  private closed = false

  private constructor() {}

  static async open(file: string, moduleDir: string): Promise<AppDatabase> {
    const impl = new AppDatabase()
    const wasmPath = locateSqlWasm(moduleDir)
    const SQL = await initSqlJs({ locateFile: () => wasmPath })
    impl.db = new SQL.Database(fs.existsSync(file) ? fs.readFileSync(file) : undefined)
    impl.file = file
    impl.db.run('PRAGMA foreign_keys = ON')
    return impl
  }

  exec(sql: string): void {
    this.db.exec(sql)
    this.schedulePersist()
  }

  run(sql: string, params: unknown[] = []): { changes: number } {
    this.db.run(sql, params as never)
    this.schedulePersist()
    return { changes: this.db.getRowsModified() }
  }

  all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    const stmt = this.db.prepare(sql)
    try {
      stmt.bind(params as never)
      const rows: T[] = []
      while (stmt.step()) rows.push(stmt.getAsObject() as T)
      return rows
    } finally {
      stmt.free()
    }
  }

  get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | undefined {
    return this.all<T>(sql, params)[0]
  }

  transaction<T>(fn: () => T): T {
    this.db.run('BEGIN')
    try {
      const result = fn()
      this.db.run('COMMIT')
      this.schedulePersist()
      return result
    } catch (err) {
      try {
        this.db.run('ROLLBACK')
      } catch {
        /* already rolled back */
      }
      throw err
    }
  }

  schedulePersist(): void {
    this.pending = true
    if (this.closed) return
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.persistNow()
    }, 250)
    // Do not keep the process alive just for a pending flush.
    this.timer.unref?.()
  }

  async persistNow(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.pending || this.closed) return
    this.pending = false
    const data = Buffer.from(this.db.export())
    const tmp = `${this.file}.tmp`
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true })
    await fs.promises.writeFile(tmp, data)
    await fs.promises.rename(tmp, this.file)
  }

  close(): void {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.db.close()
  }

  get isOpen(): boolean {
    return !this.closed
  }
}

/** Locate sql-wasm.wasm across dev / packaged / tsx / vitest layouts. */
function locateSqlWasm(moduleDir: string): string {
  const rel = path.join('node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')

  // 1. require.resolve (CJS runtime)
  try {
    const req = typeof require === 'function' ? createRequire(__filename) : createRequire(path.join(moduleDir, 'noop.js'))
    return req.resolve('sql.js/dist/sql-wasm.wasm')
  } catch {
    /* try next strategy */
  }

  // 2. walk up from the module dir looking for node_modules
  let dir = moduleDir
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, rel)
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  // 3. cwd
  const cwdCandidate = path.join(process.cwd(), rel)
  if (fs.existsSync(cwdCandidate)) return cwdCandidate

  throw new Error(
    `sql-wasm.wasm could not be located (moduleDir=${moduleDir}). ` +
      'Reinstall dependencies or set the workspace to a project checkout.'
  )
}
