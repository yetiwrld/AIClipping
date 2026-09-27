import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { makeTestContext } from '../helpers/context'
import type { AppContext } from '../../src/main/services/app-context'
import { chatComplete, extractJson } from '../../src/main/services/ai/chat'
import { updateSettings } from '../../src/main/services/settings'
import { AppError } from '@shared/errors'
import type { AiProviderRuntimeConfig } from '@shared/types'

/**
 * AI chat adapters against a local mock HTTP server (never the real
 * internet). Verifies wire formats, error mapping, and JSON repair.
 */

let ctx: AppContext
let cleanup: () => Promise<void>
let server: http.Server
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

  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      behavior.lastRequest = { headers: req.headers, body: raw ? JSON.parse(raw) : null }
      res.writeHead(behavior.status, { 'Content-Type': 'application/json', ...(behavior.headers ?? {}) })
      res.end(behavior.body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  ctx.secrets.set('ai:openai-compatible', 'test-key-openai')
  ctx.secrets.set('ai:anthropic', 'test-key-anthropic')
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await cleanup()
})

afterEach(() => {
  behavior = { status: 200, body: '{}' }
})

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
    server.removeAllListeners('request')
    server.on('request', (req, res) => {
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
      server.removeAllListeners('request')
      server.on('request', (req, res) => {
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
