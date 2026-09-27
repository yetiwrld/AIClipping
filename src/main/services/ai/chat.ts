import { AppError } from '@shared/errors'
import type { AppContext } from '../app-context'
import { getSettings } from '../settings'
import type { AiProviderRuntimeConfig } from '@shared/types'

/**
 * Chat providers: OpenAI-compatible endpoints and Anthropic. Plain fetch,
 * timeouts, friendly error mapping. API keys come from the SecretStore and
 * never leave this module except into the request header.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  temperature?: number
  maxTokens?: number
  jsonMode?: boolean
  timeoutMs?: number
  signal?: AbortSignal
}

export type ChatProviderId = 'openai-compatible' | 'anthropic'

export async function chatComplete(
  ctx: AppContext,
  providerId: ChatProviderId,
  messages: ChatMessage[],
  opts: ChatOptions = {}
): Promise<string> {
  if (providerId === 'anthropic') return anthropicChat(ctx, messages, opts)
  return openaiChat(ctx, messages, opts)
}

function getProviderConfig(ctx: AppContext, providerId: ChatProviderId): AiProviderRuntimeConfig & { key: string | null } {
  // merged + validated settings (defaults when nothing stored)
  const stored = getSettings(ctx).ai
  const cfg: AiProviderRuntimeConfig = providerId === 'anthropic' ? stored.anthropic : stored.openai
  const key = ctx.secrets.get(`ai:${providerId}`)
  return {
    baseUrl: cfg?.baseUrl ?? '',
    model: cfg?.model ?? '',
    temperature: cfg?.temperature ?? 0.4,
    maxTokens: cfg?.maxTokens ?? 2048,
    jsonMode: cfg?.jsonMode ?? false,
    supportsAudio: cfg?.supportsAudio ?? false,
    key
  }
}

async function openaiChat(ctx: AppContext, messages: ChatMessage[], opts: ChatOptions): Promise<string> {
  const cfg = getProviderConfig(ctx, 'openai-compatible')
  if (!cfg.baseUrl || !cfg.model) {
    throw new AppError('AI_NOT_CONFIGURED', 'The AI provider is not configured.', 'Set the base URL and model in Settings → AI.')
  }
  if (!cfg.key) {
    throw new AppError('AI_NO_KEY', 'No API key is set for this provider.', 'Add the key in Settings → AI.')
  }

  const base = cfg.baseUrl.replace(/\/+$/, '')
  const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    temperature: opts.temperature ?? cfg.temperature,
    max_tokens: opts.maxTokens ?? cfg.maxTokens
  }
  if (opts.jsonMode ?? cfg.jsonMode) body.response_format = { type: 'json_object' }

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.any([opts.signal ?? new AbortController().signal, AbortSignal.timeout(opts.timeoutMs ?? 120_000)])
    })
  } catch (err) {
    if (opts.signal?.aborted) throw new AppError('PROCESS_CANCELLED', 'The AI request was cancelled.')
    throw new AppError('AI_NETWORK_ERROR', `The AI endpoint could not be reached.`, 'Check the base URL and your internet connection in Settings → AI.', String(err))
  }
  if (res.status === 400 && body.response_format) {
    // Some endpoints reject response_format — retry once without it
    delete body.response_format
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000)
    })
  }
  return finishResponse(res, 'openai-compatible')
}

async function anthropicChat(ctx: AppContext, messages: ChatMessage[], opts: ChatOptions): Promise<string> {
  const cfg = getProviderConfig(ctx, 'anthropic')
  if (!cfg.model) {
    throw new AppError('AI_NOT_CONFIGURED', 'The Anthropic provider is not configured.', 'Set the model in Settings → AI.')
  }
  if (!cfg.key) {
    throw new AppError('AI_NO_KEY', 'No Anthropic API key is set.', 'Add the key in Settings → AI.')
  }
  const base = (cfg.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '')
  const url = base.endsWith('/v1/messages') ? base : `${base}/v1/messages`
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  const rest = messages.filter((m) => m.role !== 'system')

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: cfg.model,
        system: system || undefined,
        max_tokens: opts.maxTokens ?? cfg.maxTokens,
        temperature: opts.temperature ?? cfg.temperature,
        messages: rest
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000)
    })
  } catch (err) {
    throw new AppError('AI_NETWORK_ERROR', 'The Anthropic endpoint could not be reached.', 'Check your internet connection and API key.', String(err))
  }
  const text = await finishResponse(res, 'anthropic')
  try {
    const parsed = JSON.parse(text)
    const content = parsed?.content
    if (Array.isArray(content)) {
      return content.filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text).join('')
    }
    return text
  } catch {
    return text
  }
}

async function finishResponse(res: Response, provider: string): Promise<string> {
  const text = await res.text()
  if (res.status === 401 || res.status === 403) {
    throw new AppError('AI_UNAUTHORIZED', 'The AI provider rejected the API key.', 'Check the API key in Settings → AI.')
  }
  if (res.status === 404) {
    throw new AppError('AI_NOT_FOUND', 'The endpoint or model was not found (HTTP 404).', 'Check the base URL and model name in Settings → AI.', text.slice(-600))
  }
  if (res.status === 429) {
    throw new AppError('AI_RATE_LIMITED', 'The AI provider rate-limited this request.', 'Wait a moment and try again.')
  }
  if (!res.ok) {
    throw new AppError('AI_HTTP_ERROR', `The AI provider returned HTTP ${res.status}.`, 'Check the provider configuration in Settings → AI.', text.slice(-800))
  }
  try {
    if (provider === 'openai-compatible') {
      const parsed = JSON.parse(text)
      const content = parsed?.choices?.[0]?.message?.content
      if (typeof content === 'string') return content
      if (Array.isArray(content)) return content.map((c: { text?: string }) => c.text ?? '').join('')
    }
    return text
  } catch {
    throw new AppError('AI_BAD_RESPONSE', 'The AI provider response could not be read.', undefined, text.slice(-600))
  }
}

// ------------------------------------------------------------- JSON repair --

/**
 * Extract JSON from model output: strips fences/prose, applies safe repairs
 * (trailing commas, smart quotes). Returns null when nothing parses.
 */
export function extractJson<T>(raw: string): T | null {
  let text = raw.trim()

  // Strip markdown fences
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) text = fence[1].trim()

  // Grab the outermost JSON object or array if prose surrounds it
  if (!text.startsWith('{') && !text.startsWith('[')) {
    const objStart = text.indexOf('{')
    const arrStart = text.indexOf('[')
    const start = objStart === -1 ? arrStart : arrStart === -1 ? objStart : Math.min(objStart, arrStart)
    if (start === -1) return null
    const objEnd = text.lastIndexOf('}')
    const arrEnd = text.lastIndexOf(']')
    const end = Math.max(objEnd, arrEnd)
    if (end <= start) return null
    text = text.slice(start, end + 1)
  }

  const attempts = [
    text,
    text.replace(/,\s*([}\]])/g, '$1'), // trailing commas
    text.replace(/,\s*([}\]])/g, '$1').replace(/[“”]/g, '"').replace(/[‘’]/g, "'"),
    text.replace(/,\s*([}\]])/g, '$1').replace(/\n/g, '\\n')
  ]
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt) as T
    } catch {
      /* next */
    }
  }
  return null
}
