import fs from 'node:fs'
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
  const root = fs.mkdtempSync(path.join('/tmp', 'clipwright-test-'))
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
    fs.rmSync(root, { recursive: true, force: true })
  }
  return { ctx, cleanup }
}

export const FIXTURES_DIR = path.join(REPO_ROOT, 'tests', 'fixtures')
export const SAMPLE_VIDEO = path.join(FIXTURES_DIR, 'media', 'sample.mp4')
export const SAMPLE_TRANSCRIPT = path.join(FIXTURES_DIR, 'transcript.json')

export function requireFixtures(): void {
  if (!fs.existsSync(SAMPLE_VIDEO) || !fs.existsSync(SAMPLE_TRANSCRIPT)) {
    throw new Error(
      'Test fixtures are missing. Run `npm run fixtures` first (generates tests/fixtures/media/sample.mp4 + transcript.json).'
    )
  }
}
