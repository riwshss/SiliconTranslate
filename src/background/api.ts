import { ApiError } from '../core/errors'
import { createSseParser } from '../core/sse'
import type { ChatMessage } from '../core/prompt'

export interface ApiConfig {
  readonly baseUrl: string
  readonly model: string
  /** Extra request headers, e.g. the anonymous install id for the Silk backend. */
  readonly headers?: Readonly<Record<string, string>>
}

interface ChatOptions {
  readonly signal?: AbortSignal
  readonly maxTokens?: number
  readonly temperature?: number
}

const MAX_RETRIES = 3
/** Rate limits (per-minute quotas) clear slowly: wait longer and more often than for 5xx. */
const MAX_RATE_LIMIT_RETRIES = 5
const BASE_DELAY_MS = 800
const RATE_LIMIT_BASE_DELAY_MS = 2_000
const MAX_DELAY_MS = 20_000
const DEFAULT_MAX_TOKENS = 4096

function chatBody(cfg: ApiConfig, messages: ChatMessage[], stream: boolean, opts: ChatOptions) {
  return {
    model: cfg.model,
    messages,
    stream,
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new ApiError('aborted'))
      },
      { once: true },
    )
  })
}

function retryDelay(res: Response | null, attempt: number): number {
  const header = Number(res?.headers.get('retry-after'))
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, MAX_DELAY_MS)
  const base = res?.status === 429 ? RATE_LIMIT_BASE_DELAY_MS : BASE_DELAY_MS
  const jitter = Math.random() * base * 0.5
  return Math.min(base * 2 ** attempt + jitter, MAX_DELAY_MS)
}

let rateLimitListener: (() => void) | null = null

/** Called on every 429, so the caller can lower its concurrency. */
export function onRateLimited(listener: () => void): void {
  rateLimitListener = listener
}

/** Header the Silk backend sets on its own errors, so they are classified without reading the body. */
const SILK_ERROR_HEADER = 'x-silk-error'

async function errorFromResponse(res: Response): Promise<ApiError> {
  const silkError = res.headers.get(SILK_ERROR_HEADER)
  if (silkError === 'quota_exceeded') return new ApiError('quota')
  if (silkError === 'upgrade_required' || res.status === 402) return new ApiError('upgrade')
  if (silkError === 'model_locked') return new ApiError('model-locked')
  const raw = await res.text().catch(() => '')
  let detail = raw.slice(0, 200)
  try {
    const json = JSON.parse(raw) as { message?: string; error?: { message?: string } | string }
    const nested = typeof json.error === 'string' ? json.error : json.error?.message
    detail = (json.message ?? nested ?? detail).slice(0, 200)
  } catch {
    // Not JSON: keep the raw snippet.
  }
  if (res.status === 401 || res.status === 403) return new ApiError('auth', detail)
  if (res.status === 429) return new ApiError('rate-limit', detail)
  if (res.status >= 500) return new ApiError('server', `HTTP ${res.status}`)
  return new ApiError('bad-request', detail || `HTTP ${res.status}`)
}

/** fetch with exponential backoff on 429 / 5xx / network failures. */
export async function fetchWithRetry(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response
    try {
      res = await fetch(url, { ...init, signal })
    } catch (err) {
      if (signal?.aborted) throw new ApiError('aborted')
      if (attempt >= MAX_RETRIES) throw new ApiError('network', err instanceof Error ? err.message : String(err))
      await sleep(retryDelay(null, attempt), signal)
      continue
    }
    if (res.ok) return res
    // A spent quota or missing plan is a final answer, not a transient 429.
    if (res.headers.has(SILK_ERROR_HEADER) || res.status === 402) throw await errorFromResponse(res)
    const isRateLimited = res.status === 429
    if (isRateLimited) rateLimitListener?.()
    const isRetryable = isRateLimited || res.status >= 500
    if (!isRetryable || attempt >= (isRateLimited ? MAX_RATE_LIMIT_RETRIES : MAX_RETRIES)) throw await errorFromResponse(res)
    await res.body?.cancel().catch(() => undefined)
    await sleep(retryDelay(res, attempt), signal)
  }
}

function headers(cfg: ApiConfig): HeadersInit {
  return {
    'Content-Type': 'application/json',
    ...cfg.headers,
  }
}

interface ChunkPayload {
  error?: { message?: string } | string
  choices?: Array<{ delta?: { content?: string | null }; message?: { content?: string | null } }>
}

function parsePayload(data: string): ChunkPayload {
  try {
    return JSON.parse(data) as ChunkPayload
  } catch {
    throw new ApiError('bad-response', data.slice(0, 120))
  }
}

/** Streams `delta.content` pieces of an OpenAI-compatible chat completion (SSE). */
export async function* streamChat(cfg: ApiConfig, messages: ChatMessage[], opts: ChatOptions = {}): AsyncGenerator<string> {
  const res = await fetchWithRetry(
    `${cfg.baseUrl}/chat/completions`,
    { method: 'POST', headers: headers(cfg), body: JSON.stringify(chatBody(cfg, messages, true, opts)) },
    opts.signal,
  )
  // Some proxies ignore `stream: true` and answer with plain JSON.
  if ((res.headers.get('content-type') ?? '').includes('application/json')) {
    const json = parsePayload(await res.text())
    const content = json.choices?.[0]?.message?.content
    if (typeof content !== 'string') throw new ApiError('bad-response', 'missing content')
    yield content
    return
  }
  if (!res.body) throw new ApiError('bad-response', 'emptyReply')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const pending: string[] = []
  let isDone = false
  const sse = createSseParser((data) => {
    if (data === '[DONE]') {
      isDone = true
      return
    }
    const json = parsePayload(data)
    if (json.error) {
      const message = typeof json.error === 'string' ? json.error : json.error.message
      throw new ApiError('server', message ?? 'stream error')
    }
    const piece = json.choices?.[0]?.delta?.content
    if (piece) pending.push(piece)
  })
  try {
    while (!isDone) {
      const { value, done } = await reader.read()
      if (done) break
      sse.push(decoder.decode(value, { stream: true }))
      while (pending.length) yield pending.shift() as string
    }
    sse.end()
    while (pending.length) yield pending.shift() as string
  } catch (err) {
    if (opts.signal?.aborted) throw new ApiError('aborted')
    throw err
  } finally {
    reader.cancel().catch(() => undefined)
  }
}
