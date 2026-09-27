#!/usr/bin/env tsx
/**
 * Mock OpenAI-compatible gateway for offline provider verification.
 *
 * Mimics how GonkaRouter (and OpenAI-compatible gateways generally) behave:
 *   POST {base}/v1/chat/completions
 *   auth: Authorization: Bearer <key> OR x-api-key: <key> (both accepted)
 *
 * Distinguishes requests by system-prompt content and answers with schema-
 * valid payloads for Clipwright's three AI workflows (discovery / audit
 * scoring / metadata), plus a trivial "pong" for connection tests.
 *
 * Usage:  npx tsx scripts/mock-gonka.ts [port]     (default 8901)
 * Then point Settings → AI → OpenAI-compatible at:
 *   Base URL: http://127.0.0.1:8901/v1
 *   Model:    any value (e.g. zai-org/GLM-5.3-Flash)
 *   API key:  gk-test-key-123
 *
 * Dev utility only — never used by the app itself.
 */
import http from 'node:http'

const PORT = Number(process.argv[2] ?? 8901)
const VALID_KEY = 'gk-test-key-123'

function chatCompletion(content: string): string {
  return JSON.stringify({ id: 'mock-gonka', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] })
}

const server = http.createServer((req, res) => {
  if (!req.url || !req.url.endsWith('/chat/completions') || req.method !== 'POST') {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `Not found: ${req.method} ${req.url}` } }))
    return
  }
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    // Accept either documented auth style, like the real gateway
    const auth = req.headers['authorization']
    const xKey = req.headers['x-api-key']
    const keyOk = auth === `Bearer ${VALID_KEY}` || xKey === VALID_KEY
    if (!keyOk) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Invalid API key', code: 'invalid_api_key' } }))
      return
    }

    let body: { messages?: Array<{ role: string; content: string }>; model?: string; response_format?: unknown }
    try {
      body = JSON.parse(raw)
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Invalid JSON body' } }))
      return
    }

    const system = body.messages?.find((m) => m.role === 'system')?.content ?? ''
    const user = body.messages?.find((m) => m.role === 'user')?.content ?? ''

    // --- connection test ---
    if (/Reply with exactly: pong/i.test(user)) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(chatCompletion('pong'))
      return
    }

    // --- Pass 1: moment discovery → pick real segment ids from the prompt ---
    if (/meticulous short-form video editor/i.test(system)) {
      const ids = [...user.matchAll(/^(\d+) \[/gm)].map((m) => Number(m[1]))
      if (ids.length < 2) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(chatCompletion('{"candidates":[]}'))
        return
      }
      // Spans sized for the medium preset (30–60s target): ~3.2s per segment
      const a = ids[0]
      const b = ids[Math.min(12, ids.length - 1)]
      const c = ids[Math.max(0, ids.length - 14)]
      const d = ids[ids.length - 1]
      const candidates = [
        { startSegmentId: a, endSegmentId: b, title: 'Why most creators quit too early', hook: 'Ninety percent of creators quit right before it works.', reason: 'A concrete, contrarian claim delivered with conviction — strong standalone hook and a complete thought.', clipType: 'strong-opinion', transcriptExcerpt: '' },
        { startSegmentId: c, endSegmentId: d, title: 'The one system that fixed my editing', hook: 'I stopped editing chronologically.', reason: 'Actionable process advice with a clear before/after — useful standalone.', clipType: 'advice', transcriptExcerpt: '' }
      ]
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(chatCompletion(JSON.stringify({ candidates })))
      return
    }

    // --- Pass 2: audit scoring → one entry per CANDIDATE n in the prompt ---
    if (/audit short-form video clips/i.test(system)) {
      const count = [...user.matchAll(/^CANDIDATE (\d+)/gm)].length
      const scores = Array.from({ length: Math.max(1, count) }, (_, i) => ({
        candidateIndex: i,
        hook: 78 + i, contextCompleteness: 84, clarity: 88, retention: 72, emotionalImpact: 64,
        standaloneValue: 81, shareability: 70, visualSuitability: 77,
        explanation: 'Mock audit: clear, self-contained point with a strong opening claim; limited emotional range.'
      }))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(chatCompletion(JSON.stringify({ scores })))
      return
    }

    // --- metadata generation ---
    if (/platform-ready metadata/i.test(system)) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(chatCompletion(JSON.stringify({
        title: 'Why most creators quit too early',
        description: 'The hard truth about consistency — and the one change that makes it sustainable.',
        hashtags: ['#creators', '#consistency', '#contentstrategy'],
        cta: 'Follow for more creator breakdowns.'
      })))
      return
    }

    // --- unknown purpose: refuse rather than hallucinate a workflow answer ---
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(chatCompletion('mock-gonka: unrecognized request (this mock only answers discovery/scoring/metadata/pong)'))
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock-gonka listening on http://127.0.0.1:${PORT}/v1`)
  console.log(`  key: ${VALID_KEY}   model: any (e.g. zai-org/GLM-5.3-Flash)`)
})
