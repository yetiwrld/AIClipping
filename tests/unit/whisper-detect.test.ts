import { describe, it, expect, vi, beforeEach } from 'vitest'
import { pythonCandidates, detectLocalWhisper } from '../../src/main/services/transcription/index'

/**
 * B-011 regression: local-Whisper detection must probe EVERY Python
 * candidate (python / py / python3), not stop at the first one found.
 * Windows machines routinely have several interpreters, and the package
 * may be installed in any of them.
 */

const state = {
  binaries: {} as Record<string, string | null>,
  packages: {} as Record<string, boolean>
}

vi.mock('../../src/main/services/media/ffmpeg', () => ({
  whichSync: (name: string): string | null => state.binaries[name] ?? null,
  runProcess: async (binary: string) => {
    const ok = state.packages[binary] ?? false
    return ok
      ? { code: 0, stdout: 'ok', stderr: '' }
      : { code: 1, stdout: '', stderr: "ModuleNotFoundError: No module named 'faster_whisper'" }
  }
}))

beforeEach(() => {
  state.binaries = {}
  state.packages = {}
})

describe('detectLocalWhisper (B-011)', () => {
  it('tries the next candidate when the first Python lacks the package', async () => {
    const [first, second] = pythonCandidates()
    state.binaries = { [first]: `/usr/bin/${first}`, [second]: '/opt/real/python' }
    state.packages = { '/opt/real/python': true } // package is in the SECOND interpreter
    const r = await detectLocalWhisper()
    expect(r.installed).toBe(true)
    expect(r.python).toBe('/opt/real/python')
  })

  it('does not probe the same interpreter twice when two names resolve to it', async () => {
    const [first, second] = pythonCandidates()
    state.binaries = { [first]: '/usr/bin/python3', [second]: '/usr/bin/python3' }
    state.packages = { '/usr/bin/python3': true }
    const r = await detectLocalWhisper()
    expect(r.installed).toBe(true)
    expect(r.python).toBe('/usr/bin/python3')
  })

  it('reports the exact interpreter path and install command when no candidate has the package', async () => {
    const [first] = pythonCandidates()
    state.binaries = { [first]: '/usr/bin/python' }
    state.packages = {}
    const r = await detectLocalWhisper()
    expect(r.installed).toBe(false)
    expect(r.python).toBe('/usr/bin/python')
    expect(r.message).toContain('"/usr/bin/python" -m pip install faster-whisper')
  })

  it('mentions the other discovered interpreters when several lack the package', async () => {
    const [first, second] = pythonCandidates()
    state.binaries = { [first]: '/usr/bin/python', [second]: '/opt/other/python' }
    state.packages = {}
    const r = await detectLocalWhisper()
    expect(r.installed).toBe(false)
    expect(r.message).toContain('/opt/other/python')
  })

  it('handles a broken/stub interpreter by moving on to the next candidate', async () => {
    const [first, second] = pythonCandidates()
    state.binaries = { [first]: '/stub/python', [second]: '/real/python' }
    state.packages = { '/stub/python': false, '/real/python': true }
    const r = await detectLocalWhisper()
    expect(r.installed).toBe(true)
    expect(r.python).toBe('/real/python')
  })

  it('reports Python missing entirely when nothing is on PATH', async () => {
    const r = await detectLocalWhisper()
    expect(r.installed).toBe(false)
    expect(r.message).toMatch(/Python was not found/)
  })
})
