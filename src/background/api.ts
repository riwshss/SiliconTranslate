import { ApiError } from '../core/errors'
import { createSseParser } from '../core/sse'
import type { ErrorCode } from '../shared/messages'

export interface ApiConfig {
  readonly baseUrl: string
  readonly model: string
  /** Extra request headers, e.g. the signed install token for the Silk backend. */
  readonly headers?: Readonly<Record<string, string>>
}

/** Body of POST /v1/translate: data only; the backend writes the prompt. */
export interface TranslateBody {
  readonly target: string
  readonly title?: string
  readonly kind: 'page' | 'selection'
  readonly texts: readonly string[]
}

/** A finished page paragraph (by its index in `texts`) or a piece of a selection translation. */
export type TranslateEvent = { readonly index: number; readonly text: string } | { readonly delta: string }

const MAX_RETRIES = 3
/** Rate limits (per-minute quotas) clear slowly: wait longer and more often than for 5xx. */
const MAX_RATE_LIMIT_RETRIES = 5
const BASE_DELAY_MS = 800
const RATE_LIMIT_BASE_DELAY_MS = 2_000
const MAX_DELAY_MS = 20_000

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

/**
 * Backend errors that are a final answer. Its upstream_error (502) and server_error (500) also
 * carry the header but are transient, so they go through the normal 5xx retries.
 */
const FINAL_SILK_ERRORS = new Set(['quota_exceeded', 'upgrade_required', 'model_locked', 'unauthorized', 'bad_request', 'gone'])

const SILK_ERROR_CODES: Readonly<Record<string, ErrorCode>> = {
  quota_exceeded: 'quota',
  upgrade_required: 'upgrade',
  model_locked: 'model-locked',
  unauthorized: 'auth',
  bad_request: 'bad-request',
  gone: 'bad-request',
  upstream_error: 'server',
  server_error: 'server',
}

/** A backend error code (header or stream event) as the extension's error. */
export function errorFromSilkCode(code: string, detail = ''): ApiError {
  return new ApiError(SILK_ERROR_CODES[code] ?? 'server', detail)
}

async function errorFromResponse(res: Response): Promise<ApiError> {
  const silkError = res.headers.get(SILK_ERROR_HEADER)
  if (res.status === 402) return new ApiError('upgrade')
  if (silkError === 'quota_exceeded' || silkError === 'upgrade_required' || silkError === 'model_locked') return errorFromSilkCode(silkError)
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
    if (FINAL_SILK_ERRORS.has(res.headers.get(SILK_ERROR_HEADER) ?? '') || res.status === 402) throw await errorFromResponse(res)
    const isRateLimited = res.status === 429
    if (isRateLimited) rateLimitListener?.()
    const isRetryable = isRateLimited || res.status >= 500
    if (!isRetryable || attempt >= (isRateLimited ? MAX_RATE_LIMIT_RETRIES : MAX_RETRIES)) throw await errorFromResponse(res)
    await res.body?.cancel().catch(() => undefined)
    await sleep(retryDelay(res, attempt), signal)
  }
}

interface EventPayload {
  index?: unknown
  text?: unknown
  delta?: unknown
  error?: { code?: string; message?: string }
}

function parseEvent(data: string): EventPayload {
  try {
    return JSON.parse(data) as EventPayload
  } catch {
    throw new ApiError('bad-response', data.slice(0, 120))
  }
}

/**
 * Streams the events of a Silk backend translation (POST /v1/translate, server-sent events).
 * An `error` event (e.g. the provider failed after cached paragraphs were sent) is thrown.
 */
export async function* streamTranslate(cfg: ApiConfig, body: TranslateBody, signal?: AbortSignal): AsyncGenerator<TranslateEvent> {
  const res = await fetchWithRetry(
    `${cfg.baseUrl}/translate`,
    { method: 'POST', headers: { 'Content-Type': 'application/json', ...cfg.headers }, body: JSON.stringify({ model: cfg.model, ...body }) },
    signal,
  )
  if (!res.body) throw new ApiError('bad-response', 'emptyReply')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  /** In arrival order; an error is thrown only after the events before it were handed out. */
  const pending: Array<TranslateEvent | ApiError> = []
  let isDone = false
  const sse = createSseParser((data) => {
    if (data === '[DONE]') {
      isDone = true
      return
    }
    const event = parseEvent(data)
    if (event.error) pending.push(errorFromSilkCode(event.error.code ?? '', event.error.message ?? ''))
    else if (typeof event.delta === 'string') pending.push({ delta: event.delta })
    else if (Number.isInteger(event.index) && typeof event.text === 'string') pending.push({ index: event.index as number, text: event.text })
  })
  const next = (): TranslateEvent => {
    const item = pending.shift() as TranslateEvent | ApiError
    if (item instanceof ApiError) throw item
    return item
  }
  try {
    while (!isDone) {
      const { value, done } = await reader.read()
      if (done) break
      sse.push(decoder.decode(value, { stream: true }))
      while (pending.length) yield next()
    }
    sse.end()
    while (pending.length) yield next()
  } catch (err) {
    if (signal?.aborted) throw new ApiError('aborted')
    throw err
  } finally {
    reader.cancel().catch(() => undefined)
  }
}
