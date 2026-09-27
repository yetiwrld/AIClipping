import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { AppEvent } from '@shared/types'
import { AppDatabase } from './database/db'
import { runMigrations } from './database/migrations'
import { createLogger, type Logger } from './diagnostics/logger'
import { SecretStore, type SecretCodec } from './settings/secrets'

/**
 * AppContext is the dependency root for every service. Services import NO
 * Electron APIs — the context carries everything they need, which is what
 * lets the same code run under Electron, the browser preview server, and
 * Vitest (ADR-007).
 */
export interface AppContext {
  workspaceRoot: string
  appVersion: string
  platform: NodeJS.Platform
  isElectron: boolean
  /** Directory of the running main bundle — used to locate resources */
  moduleDir: string
  /** resources/ dir (fonts, python scripts) — repo `resources/` in dev,
   *  `process.resourcesPath` in a packaged app */
  resourcesDir: string
  db: AppDatabase
  events: EventBus
  logger: Logger
  secrets: SecretStore
  paths: {
    projectsDir: string
    databaseFile: string
    secretsFile: string
    exportsDir: string
    logsDir: string
    modelsDir: string
    fontsDir: string
  }
  projectDir(projectId: string): string
  shutdown(): Promise<void>
}

export class EventBus extends EventEmitter {
  constructor() {
    super()
    this.setMaxListeners(100)
  }
  publish(event: AppEvent): void {
    this.emit('event', event)
  }
  subscribe(cb: (event: AppEvent) => void): () => void {
    this.on('event', cb)
    return () => this.off('event', cb)
  }
}

export interface CreateContextOptions {
  workspaceRoot?: string
  appVersion: string
  isElectron: boolean
  moduleDir: string
  resourcesDir?: string
  logLevel?: 'debug' | 'info' | 'warn' | 'error'
  secretCodec?: SecretCodec
}

function findResourcesDir(moduleDir: string, explicit?: string): string {
  if (explicit && fs.existsSync(explicit)) return explicit
  // dev: walk up from the module dir until `resources/fonts` exists
  let dir = moduleDir
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'resources')
    if (fs.existsSync(path.join(candidate, 'fonts'))) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return path.join(process.cwd(), 'resources')
}

export async function createAppContext(opts: CreateContextOptions): Promise<AppContext> {
  const workspaceRoot = path.resolve(opts.workspaceRoot ?? process.env.CLIPWRIGHT_WORKSPACE ?? path.join(process.cwd(), '.workspace'))
  const moduleDir = path.resolve(opts.moduleDir)
  const resourcesDir = findResourcesDir(moduleDir, opts.resourcesDir)

  const paths = {
    projectsDir: path.join(workspaceRoot, 'projects'),
    databaseFile: path.join(workspaceRoot, 'database', 'app.db'),
    secretsFile: path.join(workspaceRoot, 'secrets.json'),
    exportsDir: path.join(workspaceRoot, 'exports'),
    logsDir: path.join(workspaceRoot, 'logs'),
    modelsDir: path.join(workspaceRoot, 'models'),
    fontsDir: path.join(resourcesDir, 'fonts')
  }
  for (const dir of [workspaceRoot, paths.projectsDir, path.dirname(paths.databaseFile), paths.exportsDir, paths.logsDir, paths.modelsDir]) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const events = new EventBus()
  const logger = createLogger({ logsDir: paths.logsDir, level: opts.logLevel ?? 'info' })
  const db = await AppDatabase.open(paths.databaseFile, moduleDir)
  const schemaVersion = runMigrations(db)
  const secrets = new SecretStore(paths.secretsFile, opts.secretCodec)
  logger.info('app', 'context.ready', `workspace=${workspaceRoot} schema=v${schemaVersion}`)

  const ctx: AppContext = {
    workspaceRoot,
    appVersion: opts.appVersion,
    platform: process.platform,
    isElectron: opts.isElectron,
    moduleDir,
    resourcesDir,
    db,
    events,
    logger,
    secrets,
    paths,
    projectDir(projectId: string) {
      return path.join(paths.projectsDir, projectId)
    },
    async shutdown() {
      await db.persistNow()
      db.close()
      logger.info('app', 'context.shutdown', 'database persisted')
    }
  }
  return ctx
}
