import { AppError } from '@shared/errors'
import type { AppContext } from '../app-context'
import { getSettings } from '../settings'
import { authHeaders, openaiChatUrl } from './chat'

/**
 * Live provider connection test (spec §QA): sends a minimal chat request
 * ("Reply with exactly: pong") and verifies the model actually answers.
 * Never reports success from settings alone; never exposes the API key.
 */

export interface ProviderTestResult {
  ok: boolean
  message: string
  /** Human-readable endpoint echo for diagnostics (never the key). */
  endpoint: string
  model: string
  latencyMs: number | null
}

export async function testAiProvider(
  ctx: AppContext,
  p: { providerId: 'openai-compatible' | 'anthropic'; baseUrl?: string; model?: string }
): Promise<ProviderTestResult> {
  const settings = getSettings(ctx)
  const key = ctx.secrets.get(`ai:${p.providerId}`)

  const fail = (message: string, baseUrl: string, model: string): ProviderTestResult => ({
    ok: false, message, endpoint: baseUrl || '(not set)', model: model || '(not set)', latencyMs: null
  })

  if (!key) {
    return fail('No API key is set for this provider. Save a key first.', p.baseUrl ?? '', p.model ?? '')
  }
  const cfg = p.providerId === 'anthropic' ? settings.ai.anthropic : settings.ai.openai
  const baseUrl = (p.baseUrl || cfg.baseUrl).trim()
  const model = (p.model || cfg.model).trim()
  if (!baseUrl || !model) {
    return fail('Base URL and model are required before testing.', baseUrl, model)
  }
  try {
    new URL(baseUrl)
  } catch {
    return fail(`“${baseUrl}” is not a valid URL — include http:// or https://.`, baseUrl, model)
  }

  const started = Date.now()
  try {
    let res: Response
    if (p.providerId === 'anthropic') {
      const url = `${baseUrl.replace(/\/+$/, '').replace(/\/v1\/messages$/, '')}/v1/messages`
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with exactly: pong' }] }),
        signal: AbortSignal.timeout(30_000)
      })
    } else {
      res = await fetch(openaiChatUrl(baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(key, cfg.authStyle) },
        body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with exactly: pong' }] }),
        signal: AbortSignal.timeout(30_000)
      })
    }
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: `Authentication failed (HTTP ${res.status}) — the endpoint rejected the API key. Check the key and the auth-header style.`, endpoint: baseUrl, model, latencyMs }
    }
    if (res.status === 404) {
      return { ok: false, message: `Not found (HTTP 404) — check the base URL path (usually ends with /v1) and the model name “${model}”.`, endpoint: baseUrl, model, latencyMs }
    }
    if (res.status === 429) {
      return { ok: false, message: 'Rate-limited (HTTP 429) — the key works, but the provider is throttling. Try again shortly.', endpoint: baseUrl, model, latencyMs }
    }
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '')
      const detail = bodyText.slice(-300).replace(/\s+/g, ' ').trim()
      return { ok: false, message: `The endpoint returned HTTP ${res.status}.${detail ? ` Provider said: ${detail}` : ''}`, endpoint: baseUrl, model, latencyMs }
    }

    // Verify the response actually carries model output
    const text = await res.text()
    let content = ''
    try {
      const parsed = JSON.parse(text) as {
        choices?: Array<{ message?: { content?: unknown }; text?: string }>
        content?: Array<{ type?: string; text?: string }>
        error?: { message?: string }
      }
      if (parsed.error) {
        return { ok: false, message: `The provider returned an error: ${parsed.error.message ?? 'unknown'}`, endpoint: baseUrl, model, latencyMs }
      }
      const c = parsed.choices?.[0]?.message?.content
      if (typeof c === 'string') content = c
      else if (Array.isArray(c)) content = c.map((x: { text?: string }) => x.text ?? '').join('')
      else if (typeof parsed.choices?.[0]?.text === 'string') content = parsed.choices[0].text
      else if (Array.isArray(parsed.content)) content = parsed.content.filter((x) => x.type === 'text').map((x) => x.text ?? '').join('')
    } catch {
      return { ok: false, message: 'The endpoint answered, but the response was not valid JSON — it may not be an OpenAI-compatible chat API.', endpoint: baseUrl, model, latencyMs }
    }
    if (!content.trim()) {
      return { ok: false, message: 'The endpoint answered, but the reply contained no message content. Check the model name.', endpoint: baseUrl, model, latencyMs }
    }
    return {
      ok: true,
      message: `Connection successful — model responded correctly (“${content.trim().slice(0, 24)}”) in ${(latencyMs / 1000).toFixed(1)}s.`,
      endpoint: baseUrl,
      model,
      latencyMs
    }
  } catch (err) {
    if (err instanceof AppError) throw err
    const reason = err instanceof Error ? err.message : 'network error'
    const hint = /timeout|aborted/i.test(reason) ? 'The request timed out after 30s.' : 'Check the base URL and your internet connection.'
    return fail(`Could not reach the endpoint — ${reason}. ${hint}`, baseUrl, model)
  }
}
