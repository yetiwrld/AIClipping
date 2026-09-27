import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { makeTestContext } from '../helpers/context'
import type { AppContext } from '../../src/main/services/app-context'
import { chatComplete, extractJson, openaiChatUrl } from '../../src/main/services/ai/chat'
import { testAiProvider } from '../../src/main/services/ai/test'
import { getSettings } from '../../src/main/services/settings'
import { updateSettings } from '../../src/main/services/settings'
import { AppError } from '@shared/errors'
import type { AiProviderRuntimeConfig } from '@shared/types'

/**
 * AI chat adapters against a local mock HTTP server (never the real
 * internet). Verifies wire formats, error mapping, and JSON repair.
 */

let ctx: AppContext
let cleanup: (() => Promise<void>) | undefined
let server: http.Server | null = null
let baseUrl: string

/** Canned behavior for the next request (mutated per test). */
let behavior: {
  status: number
  body: string
  headers?: Record<string, string>
  /** captured request for wire-format assertions */
  lastRequest?: { headers: http.IncomingHttpHeaders; body: any }
}

const FULL_OPENAI: AiProviderRuntimeConfig = {
  baseUrl: '', model: '', temperature: 0.4, maxTokens: 2048, jsonMode: false, supportsAudio: false
}
const FULL_ANTHROPIC: AiProviderRuntimeConfig = {
  baseUrl: '', model: '', temperature: 0.4, maxTokens: 2048, jsonMode: false, supportsAudio: false
}

beforeAll(async () => {
  const made = await makeTestContext()
  ctx = made.ctx
  cleanup = made.cleanup

  const srv = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      behavior.lastRequest = { headers: req.headers, body: raw ? JSON.parse(raw) : null }
      res.writeHead(behavior.status, { 'Content-Type': 'application/json', ...(behavior.headers ?? {}) })
      res.end(behavior.body)
    })
  })
  server = srv
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`

  ctx.secrets.set('ai:openai-compatible', 'test-key-openai')
  ctx.secrets.set('ai:anthropic', 'test-key-anthropic')
})

afterAll(async () => {
  // Guarded: when beforeAll fails (e.g. missing fixtures), afterAll still runs
  // and must not mask the real error with a secondary crash.
  const s = server
  if (s) await new Promise<void>((resolve) => s.close(() => resolve()))
  await cleanup?.()
})

/** The mock server — tests only run after a successful beforeAll. */
function srv(): http.Server {
  if (!server) throw new Error('mock server was not started')
  return server
}

afterEach(() => {
  behavior = { status: 200, body: '{}' }
})

/** Configure a standard working provider for the response-validation suite. */
function beforeEachConfig(): void {
  updateSettings(ctx, { ai: { openai: { ...FULL_OPENAI, baseUrl, model: 'm' } } })
}

/** Restore the default mock handler after a custom one. */
function restoreDefaultHandler(): void {
  srv().removeAllListeners('request')
  srv().on('request', (req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      behavior.lastRequest = { headers: req.headers, body: raw ? JSON.parse(raw) : null }
      res.writeHead(behavior.status, { 'Content-Type': 'application/json', ...(behavior.headers ?? {}) })
      res.end(behavior.body)
    })
  })
}


describe('OpenAI-compatible adapter', () => {
  it('sends the documented wire format and returns the message content', async () => {
    updateSettings(ctx, { ai: { openai: { ...FULL_OPENAI, baseUrl, model: 'test-model', jsonMode: true, temperature: 0.1, maxTokens: 512 } } })

    behavior = {
      status: 200,
      body: JSON.stringify({ choices: [{ message: { content: '{"candidates":[]}' } }] })
    }
    const out = await chatComplete(ctx, 'openai-compatible', [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' }
    ])
    expect(out).toBe('{"candidates":[]}')

    const req = behavior.lastRequest!
    expect(req.headers['authorization']).toBe('Bearer test-key-openai')
    expect(req.body.model).toBe('test-model')
    expect(req.body.response_format).toEqual({ type: 'json_object' })
    expect(req.body.messages).toHaveLength(2)
  })

  it('retries once without response_format when the endpoint rejects it (400)', async () => {
    let calls = 0
    srv().removeAllListeners('request')
    srv().on('request', (req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        calls += 1
        const body = JSON.parse(raw)
        if (calls === 1) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'response_format not supported' } }))
        } else {
          behavior.lastRequest = { headers: req.headers, body }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ choices: [{ message: { content: 'ok-after-retry' } }] }))
        }
      })
    })
    try {
      const out = await chatComplete(ctx, 'openai-compatible', [{ role: 'user', content: 'x' }])
      expect(out).toBe('ok-after-retry')
      expect(calls).toBe(2)
      expect(behavior.lastRequest!.body.response_format).toBeUndefined()
    } finally {
      // restore the default handler
      srv().removeAllListeners('request')
      srv().on('request', (req, res) => {
        let raw = ''
        req.on('data', (c) => (raw += c))
        req.on('end', () => {
          behavior.lastRequest = { headers: req.headers, body: raw ? JSON.parse(raw) : null }
          res.writeHead(behavior.status, { 'Content-Type': 'application/json' })
          res.end(behavior.body)
        })
      })
    }
  })

  it('maps auth/rate/404 errors to structured codes', async () => {
    updateSettings(ctx, { ai: { openai: { ...FULL_OPENAI, baseUrl, model: 'test-model' } } })

    behavior = { status: 401, body: JSON.stringify({ error: { message: 'bad key' } }) }
    await expect(chatComplete(ctx, 'openai-compatible', [{ role: 'user', content: 'x' }])).rejects.toMatchObject({
      code: 'AI_UNAUTHORIZED'
    })

    behavior = { status: 403, body: '{}' }
    await expect(chatComplete(ctx, 'openai-compatible', [{ role: 'user', content: 'x' }])).rejects.toMatchObject({
      code: 'AI_UNAUTHORIZED'
    })

    behavior = { status: 429, body: '{}' }
    await expect(chatComplete(ctx, 'openai-compatible', [{ role: 'user', content: 'x' }])).rejects.toMatchObject({
      code: 'AI_RATE_LIMITED'
    })

    behavior = { status: 404, body: '{}' }
    await expect(chatComplete(ctx, 'openai-compatible', [{ role: 'user', content: 'x' }])).rejects.toMatchObject({
      code: 'AI_NOT_FOUND'
    })

    behavior = { status: 500, body: '{}' }
    await expect(chatComplete(ctx, 'openai-compatible', [{ role: 'user', content: 'x' }])).rejects.toMatchObject({
      code: 'AI_HTTP_ERROR'
    })
  })

  it('refuses to run unconfigured (no silent fake success)', async () => {
    updateSettings(ctx, { ai: { openai: { ...FULL_OPENAI } } })
    await expect(chatComplete(ctx, 'openai-compatible', [{ role: 'user', content: 'x' }])).rejects.toMatchObject({
      code: 'AI_NOT_CONFIGURED'
    })

    updateSettings(ctx, { ai: { openai: { ...FULL_OPENAI, baseUrl, model: 'm' } } })
    ctx.secrets.delete('ai:openai-compatible')
    try {
      await expect(chatComplete(ctx, 'openai-compatible', [{ role: 'user', content: 'x' }])).rejects.toMatchObject({
        code: 'AI_NO_KEY'
      })
    } finally {
      ctx.secrets.set('ai:openai-compatible', 'test-key-openai')
    }
  })
})

describe('Anthropic adapter', () => {
  it('sends the Anthropic wire format (x-api-key, version, system split)', async () => {
    updateSettings(ctx, { ai: { anthropic: { ...FULL_ANTHROPIC, baseUrl, model: 'claude-test', maxTokens: 256 } } })

    behavior = {
      status: 200,
      body: JSON.stringify({ content: [{ type: 'text', text: 'anthropic says hi' }, { type: 'tool_use' }] })
    }
    const out = await chatComplete(ctx, 'anthropic', [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hello' }
    ])
    expect(out).toBe('anthropic says hi')

    const req = behavior.lastRequest!
    expect(req.headers['x-api-key']).toBe('test-key-anthropic')
    expect(req.headers['anthropic-version']).toBe('2023-06-01')
    // system prompt split out of messages
    expect(req.body.system).toBe('be brief')
    expect(req.body.messages).toHaveLength(1)
    expect(req.body.messages[0].role).toBe('user')
    expect(req.body.model).toBe('claude-test')
  })

  it('maps 401 to AI_UNAUTHORIZED', async () => {
    behavior = { status: 401, body: '{}' }
    await expect(chatComplete(ctx, 'anthropic', [{ role: 'user', content: 'x' }])).rejects.toMatchObject({
      code: 'AI_UNAUTHORIZED'
    })
  })
})

describe('extractJson (model-output repair)', () => {
  it('parses plain JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
  })

  it('parses fenced JSON blocks', () => {
    expect(extractJson('Here you go:\n```json\n{"a": 2}\n```\nEnjoy!')).toEqual({ a: 2 })
    expect(extractJson('```\n{"a": 3}\n```')).toEqual({ a: 3 })
  })

  it('parses JSON embedded in prose', () => {
    expect(extractJson('The result is {"a": 4} as requested')).toEqual({ a: 4 })
  })

  it('repairs trailing commas', () => {
    expect(extractJson('{"a": 1, "b": [1, 2, 3,]}')).toEqual({ a: 1, b: [1, 2, 3] })
  })

  it('returns null for unparseable output (caller reports, never fabricates)', () => {
    expect(extractJson('no json here at all')).toBeNull()
    expect(extractJson('')).toBeNull()
  })
})

describe('openaiChatUrl — base URL normalization', () => {
  it('appends /chat/completions to /v1 bases (GonkaRouter, OpenAI, OpenRouter, Groq)', () => {
    expect(openaiChatUrl('https://api.gonkarouter.io/v1')).toBe('https://api.gonkarouter.io/v1/chat/completions')
    expect(openaiChatUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/chat/completions')
    expect(openaiChatUrl('https://openrouter.ai/api/v1')).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(openaiChatUrl('https://api.groq.com/openai/v1')).toBe('https://api.groq.com/openai/v1/chat/completions')
  })
  it('normalizes trailing slashes without doubling paths', () => {
    expect(openaiChatUrl('https://api.gonkarouter.io/v1/')).toBe('https://api.gonkarouter.io/v1/chat/completions')
    expect(openaiChatUrl('https://api.gonkarouter.io/v1///')).toBe('https://api.gonkarouter.io/v1/chat/completions')
  })
  it('never double-appends when the full endpoint is already configured', () => {
    expect(openaiChatUrl('https://api.gonkarouter.io/v1/chat/completions')).toBe('https://api.gonkarouter.io/v1/chat/completions')
    expect(openaiChatUrl('https://api.gonkarouter.io/v1/chat/completions/')).toBe('https://api.gonkarouter.io/v1/chat/completions')
  })
  it('supports root-mounted self-hosted endpoints', () => {
    expect(openaiChatUrl('http://localhost:8000')).toBe('http://localhost:8000/chat/completions')
    expect(openaiChatUrl('http://192.168.1.10:8080/api')).toBe('http://192.168.1.10:8080/api/chat/completions')
  })
})

describe('auth styles (GonkaRouter-compatible header selection)', () => {
  it('defaults to Authorization: Bearer', async () => {
    updateSettings(ctx, { ai: { openai: { ...FULL_OPENAI, baseUrl, model: 'm' } } })
    behavior = { status: 200, body: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) }
    await chatComplete(ctx, 'openai-compatible', [{ role: 'user', content: 'x' }])
    expect(behavior.lastRequest!.headers['authorization']).toBe('Bearer test-key-openai')
    expect(behavior.lastRequest!.headers['x-api-key']).toBeUndefined()
  })
  it('sends x-api-key when selected', async () => {
    updateSettings(ctx, { ai: { openai: { ...FULL_OPENAI, baseUrl, model: 'm', authStyle: 'x-api-key' } } })
    behavior = { status: 200, body: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) }
    await chatComplete(ctx, 'openai-compatible', [{ role: 'user', content: 'x' }])
    expect(behavior.lastRequest!.headers['x-api-key']).toBe('test-key-openai')
    expect(behavior.lastRequest!.headers['authorization']).toBeUndefined()
  })
  it('sends both headers when selected', async () => {
    updateSettings(ctx, { ai: { openai: { ...FULL_OPENAI, baseUrl, model: 'm', authStyle: 'both' } } })
    behavior = { status: 200, body: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) }
    await chatComplete(ctx, 'openai-compatible', [{ role: 'user', content: 'x' }])
    expect(behavior.lastRequest!.headers['x-api-key']).toBe('test-key-openai')
    expect(behavior.lastRequest!.headers['authorization']).toBe('Bearer test-key-openai')
  })
  it('passes model IDs with slashes, dots and mixed case through verbatim', async () => {
    updateSettings(ctx, { ai: { openai: { ...FULL_OPENAI, baseUrl, model: 'zai-org/GLM-5.3-Flash' } } })
    behavior = { status: 200, body: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) }
    await chatComplete(ctx, 'openai-compatible', [{ role: 'user', content: 'x' }])
    expect(behavior.lastRequest!.body.model).toBe('zai-org/GLM-5.3-Flash')
  })
})

describe('response validation (compatible providers differ in shape)', () => {
  beforeEach(() => beforeEachConfig())
  it('rejects 200 responses carrying an error object', async () => {
    behavior = { status: 200, body: JSON.stringify({ error: { message: 'insufficient credits' } }) }
    await expect(chatComplete(ctx, 'openai-compatible', [{ role: 'user', content: 'x' }])).rejects.toMatchObject({
      code: 'AI_PROVIDER_INVALID_RESPONSE'
    })
  })
  it('rejects 200 responses with no message content and explains finish_reason=length', async () => {
    behavior = { status: 200, body: JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }) }
    const err = await chatComplete(ctx, 'openai-compatible', [{ role: 'user', content: 'x' }]).catch((e) => e)
    expect(err.code).toBe('AI_PROVIDER_INVALID_RESPONSE')
    expect(err.hint).toMatch(/max-token/i)
  })
  it('rejects 200 responses with an empty choices array', async () => {
    behavior = { status: 200, body: JSON.stringify({ choices: [] }) }
    await expect(chatComplete(ctx, 'openai-compatible', [{ role: 'user', content: 'x' }])).rejects.toMatchObject({
      code: 'AI_PROVIDER_INVALID_RESPONSE'
    })
  })
  it('accepts legacy completions shape choices[0].text', async () => {
    behavior = { status: 200, body: JSON.stringify({ choices: [{ text: 'legacy reply' }] }) }
    await expect(chatComplete(ctx, 'openai-compatible', [{ role: 'user', content: 'x' }])).resolves.toBe('legacy reply')
  })
  it('accepts content as an array of parts', async () => {
    behavior = { status: 200, body: JSON.stringify({ choices: [{ message: { content: [{ type: 'text', text: 'part-1 ' }, { type: 'text', text: 'part-2' }] } }] }) }
    await expect(chatComplete(ctx, 'openai-compatible', [{ role: 'user', content: 'x' }])).resolves.toBe('part-1 part-2')
  })
  it('rejects non-JSON 200 bodies with a clear diagnostic', async () => {
    behavior = { status: 200, body: '<html>gateway login page</html>' }
    await expect(chatComplete(ctx, 'openai-compatible', [{ role: 'user', content: 'x' }])).rejects.toMatchObject({
      code: 'AI_BAD_RESPONSE'
    })
  })
  it('retries without response_format on 422 as well as 400', async () => {
    let calls = 0
    srv().removeAllListeners('request')
    srv().on('request', (req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        calls += 1
        if (calls === 1) {
          res.writeHead(422, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'response_format is not supported' } }))
        } else {
          behavior.lastRequest = { headers: req.headers, body: JSON.parse(raw) }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ choices: [{ message: { content: 'ok-422-retry' } }] }))
        }
      })
    })
    try {
      updateSettings(ctx, { ai: { openai: { ...FULL_OPENAI, baseUrl, model: 'm', jsonMode: true } } })
      const out = await chatComplete(ctx, 'openai-compatible', [{ role: 'user', content: 'x' }])
      expect(out).toBe('ok-422-retry')
      expect(calls).toBe(2)
      expect(behavior.lastRequest!.body.response_format).toBeUndefined()
    } finally {
      restoreDefaultHandler()
    }
  })
})

describe('settings persistence — partial provider patches (regression)', () => {
  it('a partial ai.openai patch preserves sibling fields instead of failing validation', async () => {
    // exactly what the settings UI sends when a single field changes
    const before = getSettings(ctx).ai.openai
    const updated = updateSettings(ctx, { ai: { openai: { baseUrl: 'https://api.gonkarouter.io/v1' } } })
    expect(updated.ai.openai.baseUrl).toBe('https://api.gonkarouter.io/v1')
    expect(updated.ai.openai.model).toBe(before.model)
    expect(updated.ai.openai.temperature).toBe(before.temperature)
    expect(updated.ai.openai.maxTokens).toBe(before.maxTokens)
    expect(updated.ai.openai.jsonMode).toBe(before.jsonMode)
    expect(updated.ai.anthropic).toEqual(before ? getSettings(ctx).ai.anthropic : undefined) // untouched section
    // persists across a fresh read
    expect(getSettings(ctx).ai.openai.baseUrl).toBe('https://api.gonkarouter.io/v1')
  })
  it('rejects a base URL without a protocol', () => {
    try {
      updateSettings(ctx, { ai: { openai: { baseUrl: 'api.gonkarouter.io/v1' } } })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as AppError).code).toBe('SETTINGS_INVALID')
      expect((err as AppError).message).toMatch(/Base URL/)
    }
  })
  it('rejects invalid token/temperature values', () => {
    expect(() => updateSettings(ctx, { ai: { openai: { maxTokens: -5 } } })).toThrow()
    expect(() => updateSettings(ctx, { ai: { openai: { temperature: 9 } } })).toThrow()
  })
})

describe('testAiProvider — live connection test semantics', () => {
  it('fails with a clear message when no key is stored', async () => {
    ctx.secrets.delete('ai:openai-compatible')
    try {
      const r = await testAiProvider(ctx, { providerId: 'openai-compatible' })
      expect(r.ok).toBe(false)
      expect(r.message).toMatch(/No API key/i)
    } finally {
      ctx.secrets.set('ai:openai-compatible', 'test-key-openai')
    }
  })
  it('fails with a clear message for a malformed base URL (passed as an override)', async () => {
    updateSettings(ctx, { ai: { openai: { ...FULL_OPENAI, baseUrl, model: 'm' } } })
    const r = await testAiProvider(ctx, { providerId: 'openai-compatible', baseUrl: 'not-a-url' })
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/not a valid URL/)
  })
  it('reports authentication failure on 401', async () => {
    updateSettings(ctx, { ai: { openai: { ...FULL_OPENAI, baseUrl, model: 'm' } } })
    behavior = { status: 401, body: '{}' }
    const r = await testAiProvider(ctx, { providerId: 'openai-compatible' })
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/Authentication failed/)
    expect(r.latencyMs).not.toBeNull()
  })
  it('reports missing endpoint/model on 404', async () => {
    behavior = { status: 404, body: '{}' }
    const r = await testAiProvider(ctx, { providerId: 'openai-compatible' })
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/404/)
  })
  it('succeeds only when the model actually answers, and reports latency', async () => {
    behavior = { status: 200, body: JSON.stringify({ choices: [{ message: { content: 'pong' } }] }) }
    const r = await testAiProvider(ctx, { providerId: 'openai-compatible' })
    expect(r.ok).toBe(true)
    expect(r.message).toMatch(/Connection successful/)
    expect(r.message).toMatch(/pong/)
    expect(r.latencyMs).toBeGreaterThanOrEqual(0)
    expect(r.endpoint).toBe(baseUrl)
    expect(r.model).toBe('m')
    // the request must have carried the key and the minimal prompt
    expect(behavior.lastRequest!.headers['authorization']).toBe('Bearer test-key-openai')
    expect(behavior.lastRequest!.body.messages[0].content).toMatch(/pong/)
  })
  it('fails when a 200 response carries no content (never fake success)', async () => {
    behavior = { status: 200, body: JSON.stringify({ choices: [] }) }
    const r = await testAiProvider(ctx, { providerId: 'openai-compatible' })
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/no message content/)
  })
  it('fails with a connectivity message for an unreachable endpoint', async () => {
    updateSettings(ctx, { ai: { openai: { ...FULL_OPENAI, baseUrl: 'http://127.0.0.1:9', model: 'm' } } })
    const r = await testAiProvider(ctx, { providerId: 'openai-compatible' })
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/Could not reach the endpoint/)
  })
  it('uses the x-api-key header when the auth style is selected', async () => {
    updateSettings(ctx, { ai: { openai: { ...FULL_OPENAI, baseUrl, model: 'm', authStyle: 'x-api-key' } } })
    behavior = { status: 200, body: JSON.stringify({ choices: [{ message: { content: 'pong' } }] }) }
    const r = await testAiProvider(ctx, { providerId: 'openai-compatible' })
    expect(r.ok).toBe(true)
    expect(behavior.lastRequest!.headers['x-api-key']).toBe('test-key-openai')
    expect(behavior.lastRequest!.headers['authorization']).toBeUndefined()
  })
})
