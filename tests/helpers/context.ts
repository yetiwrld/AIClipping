import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAppContext } from '../../src/main/services/app-context'
import type { AppContext } from '../../src/main/services/app-context'

/**
 * Creates a REAL application context backed by a throwaway workspace
 * directory (SQLite DB + logs + project folders). Used by integration tests
 * so they exercise the genuine service stack, including bundled FFmpeg.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..')

let counter = 0

export async function makeTestContext(): Promise<{ ctx: AppContext; cleanup: () => Promise<void> }> {
  // os.tmpdir() — the suite must run on Windows too (C:\tmp does not exist).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clipwright-test-'))
  const ctx = await createAppContext({
    workspaceRoot: root,
    appVersion: '0.0.0-test',
    isElectron: false,
    moduleDir: REPO_ROOT,
    logLevel: 'error'
  })
  counter += 1
  if (counter > 50) {
    throw new Error('test context leak: more than 50 contexts created')
  }
  const cleanup = async (): Promise<void> => {
    await ctx.shutdown().catch(() => undefined)
    rmTempDir(root)
  }
  return { ctx, cleanup }
}

/**
 * Remove a throwaway workspace. On Windows, Defender/indexers briefly hold
 * handles on freshly-written media files (EPERM/EBUSY on rmSync) — Node's
 * built-in retries absorb that. A leftover temp dir must never fail the
 * suite: the OS reclaims %TEMP% eventually.
 */
export function rmTempDir(root: string): void {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
  } catch (err) {
    console.warn(`[test] could not remove temp workspace ${root} — ${String(err)}`)
  }
}

export const FIXTURES_DIR = path.join(REPO_ROOT, 'tests', 'fixtures')
export const SAMPLE_VIDEO = path.join(FIXTURES_DIR, 'media', 'sample.mp4')
export const SILENCE_VIDEO = path.join(FIXTURES_DIR, 'media', 'silence.mp4')
export const FORENSIC_VIDEO = path.join(FIXTURES_DIR, 'media', 'forensic.mp4')
export const SAMPLE_TRANSCRIPT = path.join(FIXTURES_DIR, 'transcript.json')

export function requireFixtures(): void {
  const missing: string[] = []
  if (!fs.existsSync(SAMPLE_VIDEO)) missing.push('sample.mp4')
  if (!fs.existsSync(SILENCE_VIDEO)) missing.push('silence.mp4')
  if (!fs.existsSync(FORENSIC_VIDEO)) missing.push('forensic.mp4')
  if (!fs.existsSync(SAMPLE_TRANSCRIPT)) missing.push('transcript.json')
  if (missing.length > 0) {
    throw new Error(
      `Test fixtures are missing: ${missing.join(', ')}. Run "npm run fixtures" first (generates tests/fixtures/media/ + transcript.json).`
    )
  }
}
