// Request handling for the Silk Translate backend, kept free of Cloudflare imports so it can be
// unit-tested in Node. Each extension install gets a signed token from POST /v1/install; every AI
// request is checked against daily quotas (per install, per client IP, and a sharded global
// wallet guard) and forwarded to OpenRouter with the server-side key. The client only sends the
// texts to translate: prompts are built here, so the endpoint cannot be used as a general LLM.
// The key never reaches the client.

import { buildBatchMessages, buildTextMessages, PROMPT_VERSION, type ChatMessage } from '../../src/core/prompt'
import { isSuspectTranslation, plainReply } from '../../src/core/reply'
import { createSseParser } from '../../src/core/sse'
import { createObjectStreamParser } from '../../src/core/stream-json'
import { getLanguage, isKnownLanguage } from '../../src/shared/languages'
import type { QuotaResult } from './quota'

export interface Env {
  readonly OPENROUTER_API_KEY: string
  /** HMAC key that signs install tokens (wrangler secret). Without it no token is issued or accepted. */
  readonly INSTALL_SECRET?: string
  readonly INSTALL_DAILY_CHARS: string
  readonly IP_DAILY_CHARS: string
  readonly GLOBAL_DAILY_CHARS: string
  /** New install tokens one client IP may get per day. */
  readonly INSTALLS_PER_IP_DAILY?: string
  /**
   * Until this instant, unsigned install ids (extension ≤ 2.2) and /v1/chat/completions still
   * work, sharing LEGACY_DAILY_CHARS per day; afterwards the old endpoint answers 410.
   */
  readonly LEGACY_UNTIL?: string
  readonly LEGACY_DAILY_CHARS?: string
  /** Plan of an install without a stored one (see resolvePlan); "free" when unset. */
  readonly DEFAULT_PLAN?: string
  /**
   * Install ids (comma or whitespace separated) on the developer plan: every model, no quota.
   * A wrangler secret, so the list never lands in the repository.
   */
  readonly DEV_INSTALL_IDS?: string
  readonly MAX_REQUEST_CHARS: string
  readonly MAX_OUTPUT_TOKENS: string
  /** Tokens/s (median) a provider should reach to be tried first; slower ones become fallbacks. */
  readonly MIN_PROVIDER_THROUGHPUT?: string
  readonly APP_URL: string
  readonly APP_TITLE: string
}

/** Counter storage, one counter per key; backed by a Durable Object in production. */
export interface QuotaStore {
  consume(key: string, amount: number, limit: number): Promise<QuotaResult>
  peek(key: string, limit: number): Promise<QuotaResult>
}

/** Finished translations by cache key (see cacheKey); backed by the Workers Cache API. */
export interface TranslationCache {
  get(key: string): Promise<string | null>
  put(key: string, text: string): Promise<void>
}

/** Paid plans by account (`plan:<id>`), written by the payment callback; backed by KV. */
export interface PlanStore {
  get(key: string): Promise<string | null>
}

/** Workers Analytics Engine dataset. */
export interface MetricsSink {
  writeDataPoint(point: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void
}

export interface Deps {
  readonly quota: QuotaStore
  readonly fetch: typeof fetch
  /** Keeps the worker alive for work that finishes after the response (ExecutionContext.waitUntil). */
  readonly waitUntil: (promise: Promise<unknown>) => void
  readonly cache?: TranslationCache
  readonly plans?: PlanStore
  readonly metrics?: MetricsSink
}

export type Plan = 'beta' | 'free' | 'pro' | 'dev'
const PLANS: readonly Plan[] = ['beta', 'free', 'pro', 'dev']
const PLAN_FEATURES: Record<Plan, readonly string[]> = { beta: ['cloud-ai'], free: [], pro: ['cloud-ai'], dev: ['cloud-ai'] }
/** Plans without daily limits: no per-install / per-IP quota, and the global guard does not stop them. */
const UNLIMITED_PLANS: ReadonlySet<Plan> = new Set(['dev'])

/** OpenRouter ids the extension may ask for; same list and order as CLOUD_MODELS in src/shared/settings.ts. */
export const MODELS: readonly string[] = ['deepseek/deepseek-v4-flash', 'anthropic/claude-haiku-5.5', 'openai/gpt-6-sol', 'google/gemini-3.8-flash']

/**
 * Models each plan may use; the first is the plan's default. The free beta only gets the
 * cheapest model, the others open with paid plans.
 */
export const PLAN_MODELS: Record<Plan, readonly string[]> = { beta: ['deepseek/deepseek-v4-flash'], free: [], pro: MODELS, dev: MODELS }

/** Model name extension v2.0 sent before models were selectable; it means "the plan default". */
const LEGACY_MODEL = 'silk-cloud'

/** Extra OpenRouter fields per model. DeepSeek V4 can reason, which translation never needs. */
const MODEL_OPTIONS: Readonly<Record<string, Record<string, unknown>>> = {
  'deepseek/deepseek-v4-flash': { reasoning: { effort: 'none' } },
}

/**
 * OpenRouter serves one model through many providers, at very different speeds (DeepSeek V4
 * Flash: roughly 5 to 80 tokens/s). By default it routes by price alone. This preference moves
 * providers below the throughput floor to the back, so the cheapest fast one is tried first and
 * slow ones only serve as fallbacks; it never makes a request fail.
 */
function providerRouting(env: Env): Record<string, unknown> {
  return { provider: { preferred_min_throughput: limitOf(env.MIN_PROVIDER_THROUGHPUT ?? '', 50) } }
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const INSTALL_ID_RE = new RegExp(`^${UUID}$`, 'i')
/** `<id>.<base64url HMAC-SHA256 of the id>` (32 bytes → 43 characters). */
const INSTALL_TOKEN_RE = new RegExp(`^(${UUID})\\.([A-Za-z0-9_-]{43})$`)
const ROLES = new Set(['system', 'user', 'assistant'])
const MAX_MESSAGES = 8
/** Legacy endpoint only: there the client writes the prompt, so every request costs at least this. */
const MIN_CHARGE_CHARS = 200
/**
 * Quota counts source characters only, so the answer length is bounded by the source: a
 * translation is never much longer than its original.
 */
const OUTPUT_TOKENS_PER_CHAR = 2
const OUTPUT_TOKENS_BASE = 256
/** UTF-8 JSON can be ~4 bytes per character; anything far beyond that is refused unread. */
const BYTES_PER_CHAR_BUDGET = 8

/** /v1/translate limits. A page paragraph may be as long as the extension sends one (MAX_MARKUP_CHARS in src/content/unit.ts). */
const MAX_PAGE_TEXTS = 12
const MAX_PAGE_TEXT_CHARS = 6000
const MAX_SELECTION_CHARS = 5000
const MAX_TITLE_CHARS = 200
const CACHE_ORIGIN = 'https://cache.silk/'

/** The global wallet guard is split so no single Durable Object sees every request. */
export const GLOBAL_SHARDS = 16

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Silk-Install',
  'Access-Control-Expose-Headers': 'X-Silk-Error',
}

export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'quota_exceeded'
  | 'install_limited'
  | 'upgrade_required'
  | 'model_locked'
  | 'not_found'
  | 'gone'
  | 'upstream_error'
  | 'server_error'

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS, ...extra },
  })
}

function ok(data: unknown, meta: unknown = null): Response {
  return json(200, { success: true, data, error: null, meta })
}

/** `X-Silk-Error` lets the client classify the failure without reading the body. */
function fail(status: number, code: ErrorCode, message: string, meta: unknown = null): Response {
  return json(status, { success: false, data: null, error: { code, message }, meta }, { 'X-Silk-Error': code })
}

function limitOf(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown'
}

function quotaMeta(q: QuotaResult) {
  return { used: q.used, limit: q.limit, resetAt: q.resetAt }
}

// ───────────────────────────── install tokens ─────────────────────────────

const encoder = new TextEncoder()
const hmacKeys = new Map<string, Promise<CryptoKey>>()

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = hmacKeys.get(secret)
  if (!key) {
    key = crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
    hmacKeys.set(secret, key)
  }
  return key
}

function base64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

export async function signInstallId(secret: string, id: string): Promise<string> {
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(id))
  return `${id}.${base64url(signature)}`
}

/** The install id inside a token this server signed, or null. Pure computation, no storage. */
export async function verifyInstallToken(secret: string, token: string): Promise<string | null> {
  const match = INSTALL_TOKEN_RE.exec(token)
  if (!match) return null
  const [, id, signature] = match
  const isValid = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromBase64url(signature), encoder.encode(id))
  return isValid ? id : null
}

function isLegacyPeriod(env: Env, now = Date.now()): boolean {
  const until = Date.parse(env.LEGACY_UNTIL ?? '')
  return Number.isFinite(until) && now < until
}

interface Identity {
  readonly id: string
  /** An unsigned UUID from extension ≤ 2.2, accepted only during the transition. */
  readonly isLegacy: boolean
}

async function identify(request: Request, env: Env): Promise<Identity | null> {
  const value = request.headers.get('X-Silk-Install') ?? ''
  if (env.INSTALL_SECRET) {
    const id = await verifyInstallToken(env.INSTALL_SECRET, value)
    if (id) return { id: id.toLowerCase(), isLegacy: false }
  }
  if (INSTALL_ID_RE.test(value) && isLegacyPeriod(env)) return { id: value.toLowerCase(), isLegacy: true }
  return null
}

async function handleInstall(request: Request, env: Env, deps: Deps): Promise<Response> {
  if (!env.INSTALL_SECRET) {
    console.error('INSTALL_SECRET is not set')
    return fail(500, 'server_error', 'Install signing is not configured')
  }
  const issued = await deps.quota.consume(`issue:${clientIp(request)}`, 1, limitOf(env.INSTALLS_PER_IP_DAILY, 3))
  if (!issued.allowed) return fail(429, 'install_limited', 'Too many new installs from this network today', quotaMeta(issued))
  return ok({ token: await signInstallId(env.INSTALL_SECRET, crypto.randomUUID()) })
}

// ───────────────────────────── plans and quota ─────────────────────────────

function isPlan(value: unknown): value is Plan {
  return PLANS.includes(value as Plan)
}

function isDevInstall(id: string, env: Env): boolean {
  return (env.DEV_INSTALL_IDS ?? '')
    .split(/[\s,]+/)
    .some((devId) => devId.toLowerCase() === id)
}

/**
 * The plan of an install: the developer's own installs (DEV_INSTALL_IDS) first, then a stored
 * plan (written by the payment callback), otherwise DEFAULT_PLAN ("beta" during the beta),
 * otherwise free.
 */
export async function resolvePlan(id: string, env: Env, deps: Deps): Promise<Plan> {
  if (isDevInstall(id, env)) return 'dev'
  const stored = deps.plans ? await deps.plans.get(`plan:${id}`).catch(() => null) : null
  if (isPlan(stored)) return stored
  return isPlan(env.DEFAULT_PLAN) ? env.DEFAULT_PLAN : 'free'
}

/** Counters spent synchronously on every request; separate Durable Objects, called in parallel. */
function requestCounters(who: Identity, request: Request, env: Env): Array<[string, number]> {
  const counters: Array<[string, number]> = [
    [`install:${who.id}`, limitOf(env.INSTALL_DAILY_CHARS, 100_000)],
    [`ip:${clientIp(request)}`, limitOf(env.IP_DAILY_CHARS, 300_000)],
  ]
  if (who.isLegacy) counters.push(legacyCounter(env))
  return counters
}

function legacyCounter(env: Env): [string, number] {
  return ['legacy', limitOf(env.LEGACY_DAILY_CHARS, 200_000)]
}

/**
 * Spends `amount` on every counter at once (one round trip instead of one per counter, since
 * this sits in front of every translation). If any counter is exhausted, gives back what the
 * others took and returns the first exhausted counter's state; null when everything was spent.
 */
async function spend(deps: Deps, amount: number, counters: ReadonlyArray<[string, number]>): Promise<QuotaResult | null> {
  const results = await Promise.all(counters.map(([key, limit]) => deps.quota.consume(key, amount, limit)))
  const exhausted = results.find((result) => !result.allowed)
  if (!exhausted) return null
  await refund(deps, amount, counters.filter((_, i) => results[i].allowed))
  return exhausted
}

/** Gives `amount` back to every counter: a failed AI call must not cost the user quota. */
async function refund(deps: Deps, amount: number, counters: ReadonlyArray<[string, number]>): Promise<void> {
  if (amount > 0) await Promise.all(counters.map(([key, limit]) => deps.quota.consume(key, -amount, limit)))
}

/**
 * Global wallet guard, counted after the response so it never delays a translation. Each request
 * lands on a random shard holding 1/GLOBAL_SHARDS of the limit; once any shard is full, this
 * isolate refuses new AI work for the rest of the UTC day.
 */
let globalExhaustedUntil = 0

/** For tests: forget that the global limit was reached. */
export function resetGlobalGuard(): void {
  globalExhaustedUntil = 0
}

function isGloballyExhausted(): boolean {
  return Date.now() < globalExhaustedUntil
}

function chargeGlobal(env: Env, deps: Deps, chars: number): void {
  if (chars <= 0) return
  const shard = Math.floor(Math.random() * GLOBAL_SHARDS)
  const limit = Math.ceil(limitOf(env.GLOBAL_DAILY_CHARS, 200_000_000) / GLOBAL_SHARDS)
  deps.waitUntil(
    deps.quota
      .consume(`global:${shard}`, chars, limit)
      .then((result) => {
        if (!result.allowed) globalExhaustedUntil = Date.parse(result.resetAt)
      })
      .catch((err) => console.error('global quota', err)),
  )
}

const GLOBAL_EXHAUSTED_MESSAGE = 'The service has reached its daily limit'

async function handleEntitlement(request: Request, env: Env, deps: Deps): Promise<Response> {
  const who = await identify(request, env)
  if (!who) return fail(401, 'unauthorized', 'Missing or invalid install token')
  const plan = await resolvePlan(who.id, env, deps)
  const quota = UNLIMITED_PLANS.has(plan) ? null : quotaMeta(await deps.quota.peek(`install:${who.id}`, limitOf(env.INSTALL_DAILY_CHARS, 100_000)))
  return ok({ plan, features: PLAN_FEATURES[plan], models: PLAN_MODELS[plan], quota })
}

// ───────────────────────────── OpenRouter ─────────────────────────────

function callOpenRouter(env: Env, deps: Deps, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response | null> {
  return deps
    .fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': env.APP_URL,
        'X-Title': env.APP_TITLE,
      },
      body: JSON.stringify({ ...body, ...providerRouting(env), ...MODEL_OPTIONS[body.model as string] }),
      signal,
    })
    .catch(() => null)
}

/** Upstream failure as answered to the client; the details only go to the log. */
async function upstreamFailure(upstream: Response | null): Promise<Response> {
  if (!upstream) return fail(502, 'upstream_error', 'AI provider unreachable')
  const detail = await upstream.text().catch(() => '')
  console.error('openrouter error', upstream.status, detail.slice(0, 500))
  // Upstream 429 is a provider rate limit, not the user's quota: let the client back off and retry.
  if (upstream.status === 429) return json(429, { success: false, data: null, error: { code: 'upstream_error', message: 'AI provider busy' }, meta: null }, { 'Retry-After': '2' })
  return fail(502, 'upstream_error', `AI provider error (HTTP ${upstream.status})`)
}

function maxTokensFor(chars: number, env: Env): number {
  return Math.min(limitOf(env.MAX_OUTPUT_TOKENS, 8192), chars * OUTPUT_TOKENS_PER_CHAR + OUTPUT_TOKENS_BASE)
}

interface StreamChunk {
  provider?: unknown
  error?: { message?: string } | string
  usage?: { prompt_tokens_details?: { cached_tokens?: unknown } }
  choices?: Array<{ delta?: { content?: string | null } }>
}

class UpstreamStreamError extends Error {}

interface UpstreamStats {
  provider: string
  cachedTokens: number
  firstContentAt: number | null
}

/**
 * Reads an OpenRouter SSE body and hands every content piece to `onContent`. Records the serving
 * provider and, from the final chunk, the prompt tokens served from the provider's cache.
 * Throws on a mid-stream error; resolves true once the stream ended with [DONE].
 */
async function readUpstream(body: ReadableStream<Uint8Array>, stats: UpstreamStats, onContent: (piece: string) => Promise<void>): Promise<boolean> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const pieces: string[] = []
  let isDone = false
  /** Raised only after the content that arrived before it was handed on. */
  let streamError: string | null = null
  const sse = createSseParser((data) => {
    if (streamError !== null) return
    if (data === '[DONE]') {
      isDone = true
      return
    }
    let chunk: StreamChunk
    try {
      chunk = JSON.parse(data) as StreamChunk
    } catch {
      return
    }
    if (chunk.error) {
      streamError = typeof chunk.error === 'string' ? chunk.error : (chunk.error.message ?? 'stream error')
      return
    }
    if (typeof chunk.provider === 'string') stats.provider = chunk.provider
    const cached = Number(chunk.usage?.prompt_tokens_details?.cached_tokens)
    if (Number.isFinite(cached)) stats.cachedTokens = cached
    const piece = chunk.choices?.[0]?.delta?.content
    if (piece) pieces.push(piece)
  })
  const drain = async () => {
    while (pieces.length) {
      stats.firstContentAt ??= Date.now()
      await onContent(pieces.shift() as string)
    }
    if (streamError !== null) throw new UpstreamStreamError(streamError)
  }
  try {
    while (!isDone) {
      const { value, done } = await reader.read()
      if (done) break
      sse.push(decoder.decode(value, { stream: true }))
      await drain()
    }
    sse.end()
    await drain()
    return isDone
  } finally {
    reader.cancel().catch(() => undefined)
  }
}

// ───────────────────────────── /v1/translate ─────────────────────────────

export type TranslateKind = 'page' | 'selection'

export interface TranslateRequest {
  /** A known model, or null when the client did not ask for one (the plan default applies). */
  readonly model: string | null
  /** A code from src/shared/languages.ts. */
  readonly target: string
  readonly title: string
  readonly kind: TranslateKind
  readonly texts: readonly string[]
}

/** Everything a /v1/translate body may contain; anything else (e.g. `messages`, `system`) is refused. */
const TRANSLATE_FIELDS = new Set(['model', 'target', 'title', 'kind', 'texts'])

/** Validates the client body: data only, never prompts. */
export function parseTranslateRequest(raw: unknown): TranslateRequest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const body = raw as Record<string, unknown>
  if (Object.keys(body).some((key) => !TRANSLATE_FIELDS.has(key))) return null
  if (body.model !== undefined && !MODELS.includes(body.model as string)) return null
  if (!isKnownLanguage(body.target)) return null
  const title = body.title ?? ''
  if (typeof title !== 'string' || title.length > MAX_TITLE_CHARS) return null
  const { kind, texts } = body
  if (kind !== 'page' && kind !== 'selection') return null
  const [minCount, maxCount, maxChars] = kind === 'page' ? [1, MAX_PAGE_TEXTS, MAX_PAGE_TEXT_CHARS] : [1, 1, MAX_SELECTION_CHARS]
  if (!Array.isArray(texts) || texts.length < minCount || texts.length > maxCount) return null
  if (!texts.every((t) => typeof t === 'string' && t.trim().length > 0 && t.length <= maxChars)) return null
  return { model: (body.model as string | undefined) ?? null, target: body.target, title, kind, texts: texts as string[] }
}

/**
 * Shared translation cache key: who asked does not matter, only what was translated and how
 * (including the prompt version, so a prompt change is not hidden behind old translations).
 */
export async function cacheKey(model: string, target: string, kind: TranslateKind, text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`v${PROMPT_VERSION}|${model}|${target}|${kind}|${text}`))
  return CACHE_ORIGIN + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** One line of the /v1/translate event stream. */
export type TranslateEvent =
  | { readonly index: number; readonly text: string }
  | { readonly delta: string }
  | { readonly error: { readonly code: ErrorCode; readonly message: string } }

function messagesFor(req: TranslateRequest, texts: readonly string[]): ChatMessage[] {
  const language = getLanguage(req.target)
  return req.kind === 'page' ? buildBatchMessages(texts, language, req.title) : buildTextMessages(texts[0], language)
}

/**
 * Answers with a `text/event-stream` of TranslateEvent lines, then `[DONE]`. Paragraphs found in
 * the shared cache go out first and cost no quota; only the rest is sent to the model. When
 * nothing is cached, upstream failures are reported as HTTP errors (so the client's transport
 * retries apply); once cached paragraphs have been sent, they arrive as an `error` event.
 */
async function handleTranslate(request: Request, env: Env, deps: Deps): Promise<Response> {
  const started = Date.now()
  const who = await identify(request, env)
  if (!who) return fail(401, 'unauthorized', 'Missing or invalid install token')
  const plan = await resolvePlan(who.id, env, deps)
  if (!PLAN_FEATURES[plan].includes('cloud-ai')) return fail(402, 'upgrade_required', 'Cloud AI requires an upgrade')

  const maxRequestChars = limitOf(env.MAX_REQUEST_CHARS, 24_000)
  if (Number(request.headers.get('Content-Length')) > maxRequestChars * BYTES_PER_CHAR_BUDGET) return fail(413, 'bad_request', 'Request too large')
  const req = parseTranslateRequest(await request.json().catch(() => null))
  if (!req) return fail(400, 'bad_request', 'Invalid translate request')
  const model = req.model ?? PLAN_MODELS[plan][0]
  if (!PLAN_MODELS[plan].includes(model)) return fail(403, 'model_locked', 'This model is not available on your plan')
  if (req.texts.reduce((n, t) => n + t.length, 0) > maxRequestChars) return fail(413, 'bad_request', 'Request too large')

  const cache = deps.cache
  const keys = cache ? await Promise.all(req.texts.map((text) => cacheKey(model, req.target, req.kind, text))) : []
  const cached = cache ? await Promise.all(keys.map((key) => cache.get(key).catch(() => null))) : req.texts.map(() => null)
  const hits = cached.flatMap((text, i) => (text ? [i] : []))
  const misses = cached.flatMap((text, i) => (text ? [] : [i]))
  const chars = misses.reduce((n, i) => n + req.texts[i].length, 0)

  const stats: UpstreamStats = { provider: '', cachedTokens: 0, firstContentAt: null }
  const record = (errorCode: string) =>
    deps.metrics?.writeDataPoint({
      indexes: [model],
      blobs: [model, stats.provider, errorCode, req.kind, plan],
      doubles: [chars, stats.firstContentAt ? stats.firstContentAt - started : 0, Date.now() - started, stats.cachedTokens, hits.length],
    })

  // Quota covers only what goes to the model; unlimited plans skip it (the global count still sees them).
  const isUnlimited = UNLIMITED_PLANS.has(plan)
  const counters = misses.length && !isUnlimited ? requestCounters(who, request, env) : []
  let quotaError: { message: string; meta: unknown } | null = null
  if (counters.length && isGloballyExhausted()) quotaError = { message: GLOBAL_EXHAUSTED_MESSAGE, meta: null }
  else if (counters.length) {
    const exhausted = await spend(deps, chars, counters)
    if (exhausted) quotaError = { message: 'Daily free quota used up', meta: quotaMeta(exhausted) }
  }
  if (quotaError && !hits.length) {
    record('quota_exceeded')
    return fail(429, 'quota_exceeded', quotaError.message, quotaError.meta)
  }

  const controller = new AbortController()
  const upstreamBody = () => ({
    model,
    messages: messagesFor(
      req,
      misses.map((i) => req.texts[i]),
    ),
    stream: true,
    temperature: 0.2,
    max_tokens: maxTokensFor(chars, env),
  })
  let upstream: Response | null = null
  if (misses.length && !quotaError && !hits.length) {
    upstream = await callOpenRouter(env, deps, upstreamBody(), controller.signal)
    if (!upstream?.ok) {
      await refund(deps, chars, counters)
      record('upstream_error')
      return upstreamFailure(upstream)
    }
    chargeGlobal(env, deps, chars)
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()
  const send = async (event: TranslateEvent | '[DONE]') => {
    await writer.write(encoder.encode(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`))
  }
  const remember = (index: number, text: string) => {
    if (cache) deps.waitUntil(cache.put(keys[index], text).catch(() => undefined))
  }

  const pump = async () => {
    const delivered = new Set<number>()
    let errorCode = ''
    try {
      for (const i of hits) await send(req.kind === 'page' ? { index: i, text: cached[i] as string } : { delta: cached[i] as string })
      if (quotaError) {
        errorCode = 'quota_exceeded'
        await send({ error: { code: 'quota_exceeded', message: quotaError.message } })
        return
      }
      if (!misses.length) {
        await send('[DONE]')
        return
      }
      if (!upstream) {
        upstream = await callOpenRouter(env, deps, upstreamBody(), controller.signal)
        if (!upstream?.ok) {
          await refund(deps, chars, counters)
          errorCode = 'upstream_error'
          const failure = await upstreamFailure(upstream)
          await send({ error: { code: 'upstream_error', message: `AI provider error (HTTP ${failure.status})` } })
          return
        }
        chargeGlobal(env, deps, chars)
      }

      const deliver = async (local: number, text: string) => {
        const index = misses[local]
        if (index === undefined || delivered.has(index) || !text.trim()) return
        delivered.add(index)
        await send({ index, text })
        if (!isSuspectTranslation(req.texts[index], text)) remember(index, text)
      }
      const parser = createObjectStreamParser()
      let reply = ''
      const take = async (pairs: Array<[string, string]>) => {
        for (const [key, value] of pairs) if (/^\d+$/.test(key)) await deliver(Number(key), value)
      }
      const isComplete = await readUpstream(upstream.body as ReadableStream<Uint8Array>, stats, async (piece) => {
        reply += piece
        if (req.kind === 'selection') await send({ delta: piece })
        else await take(parser.push(piece))
      })
      if (req.kind === 'selection') {
        if (isComplete && reply.trim()) remember(misses[0], reply)
      } else {
        await take(parser.end())
        const plain = !delivered.size && misses.length === 1 ? plainReply(reply) : null
        if (plain) await deliver(0, plain)
      }
      await send('[DONE]')
    } catch (err) {
      controller.abort()
      errorCode ||= err instanceof UpstreamStreamError ? 'upstream_error' : 'stream_aborted'
      if (err instanceof UpstreamStreamError) {
        console.error('openrouter stream error', err.message)
        // Paragraphs the client never got are not charged; it will ask for them again.
        if (req.kind === 'page') await refund(deps, misses.filter((i) => !delivered.has(i)).reduce((n, i) => n + req.texts[i].length, 0), counters)
        await send({ error: { code: 'upstream_error', message: 'AI provider error' } }).catch(() => undefined)
      }
    } finally {
      record(errorCode)
      await writer.close().catch(() => undefined)
    }
  }
  deps.waitUntil(pump())
  return new Response(readable, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', ...CORS_HEADERS },
  })
}

// ───────────────────────────── legacy /v1/chat/completions ─────────────────────────────

export interface ChatRequest {
  /** A known model, or null when the client did not ask for one (the plan default applies). */
  readonly model: string | null
  readonly messages: ReadonlyArray<{ role: string; content: string }>
  readonly stream: boolean
  readonly temperature: number
  readonly maxTokens: number
}

/** Validates the client body; keeps the model (must be a known one), messages and a few sampling knobs. */
export function parseChatRequest(raw: unknown, maxOutputTokens: number): ChatRequest | null {
  if (!raw || typeof raw !== 'object') return null
  const body = raw as Record<string, unknown>
  const { messages } = body
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) return null
  const isValid = messages.every(
    (m) => !!m && typeof m === 'object' && ROLES.has((m as { role: unknown }).role as string) && typeof (m as { content: unknown }).content === 'string',
  )
  if (!isValid) return null
  const model = body.model === LEGACY_MODEL ? undefined : body.model
  if (model !== undefined && !MODELS.includes(model as string)) return null
  const temperature = Number(body.temperature)
  const maxTokens = Number(body.max_tokens)
  return {
    model: (model as string | undefined) ?? null,
    messages: messages.map((m) => ({ role: m.role as string, content: m.content as string })),
    stream: body.stream === true,
    temperature: Number.isFinite(temperature) ? Math.min(Math.max(temperature, 0), 1) : 0.2,
    maxTokens: Number.isInteger(maxTokens) && maxTokens > 0 ? Math.min(maxTokens, maxOutputTokens) : maxOutputTokens,
  }
}

export function promptChars(req: ChatRequest): number {
  return req.messages.reduce((sum, m) => sum + m.content.length, 0)
}

/**
 * Raw chat proxy used by extension ≤ 2.2, kept only so store auto-updates can catch up. The
 * client writes the prompt here, so all of it shares one small daily pool (LEGACY_DAILY_CHARS)
 * on top of the usual counters, and it answers 410 once LEGACY_UNTIL has passed.
 */
async function handleChat(request: Request, env: Env, deps: Deps): Promise<Response> {
  if (!isLegacyPeriod(env)) return fail(410, 'gone', 'This extension version is no longer supported. Please update Silk Translate.')
  const who = await identify(request, env)
  if (!who) return fail(401, 'unauthorized', 'Missing or invalid install id')
  const plan = await resolvePlan(who.id, env, deps)
  if (!PLAN_FEATURES[plan].includes('cloud-ai')) return fail(402, 'upgrade_required', 'Cloud AI requires an upgrade')

  const maxRequestChars = limitOf(env.MAX_REQUEST_CHARS, 24_000)
  if (Number(request.headers.get('Content-Length')) > maxRequestChars * BYTES_PER_CHAR_BUDGET) return fail(413, 'bad_request', 'Request too large')
  const raw = await request.json().catch(() => null)
  const chat = parseChatRequest(raw, limitOf(env.MAX_OUTPUT_TOKENS, 8192))
  if (!chat) return fail(400, 'bad_request', 'Invalid chat request')
  const model = chat.model ?? PLAN_MODELS[plan][0]
  if (!PLAN_MODELS[plan].includes(model)) return fail(403, 'model_locked', 'This model is not available on your plan')
  const textChars = promptChars(chat)
  if (textChars > maxRequestChars) return fail(413, 'bad_request', 'Request too large')
  const chars = Math.max(textChars, MIN_CHARGE_CHARS)
  const maxTokens = Math.min(chat.maxTokens, textChars * OUTPUT_TOKENS_PER_CHAR + OUTPUT_TOKENS_BASE)

  if (isGloballyExhausted()) return fail(429, 'quota_exceeded', GLOBAL_EXHAUSTED_MESSAGE)
  const counters = requestCounters(who, request, env)
  if (!who.isLegacy) counters.push(legacyCounter(env))
  const exhausted = await spend(deps, chars, counters)
  if (exhausted) return fail(429, 'quota_exceeded', 'Daily free quota used up', quotaMeta(exhausted))

  const upstream = await callOpenRouter(env, deps, { model, messages: chat.messages, stream: chat.stream, temperature: chat.temperature, max_tokens: maxTokens })
  if (!upstream?.ok) {
    await refund(deps, chars, counters)
    return upstreamFailure(upstream)
  }
  chargeGlobal(env, deps, chars)
  return new Response(upstream.body, {
    status: 200,
    headers: { 'Content-Type': upstream.headers.get('Content-Type') ?? 'text/event-stream', 'Cache-Control': 'no-store', ...CORS_HEADERS },
  })
}

export async function handleRequest(request: Request, env: Env, deps: Deps): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS })
  const { pathname } = new URL(request.url)
  try {
    if (pathname === '/v1/translate' && request.method === 'POST') return await handleTranslate(request, env, deps)
    if (pathname === '/v1/entitlement' && request.method === 'GET') return await handleEntitlement(request, env, deps)
    if (pathname === '/v1/install' && request.method === 'POST') return await handleInstall(request, env, deps)
    if (pathname === '/v1/chat/completions' && request.method === 'POST') return await handleChat(request, env, deps)
    if (pathname === '/' && request.method === 'GET') return ok({ service: 'silk-translate-api' })
    return fail(404, 'not_found', 'Not found')
  } catch (err) {
    console.error('unhandled', err instanceof Error ? err.stack : String(err))
    return fail(500, 'server_error', 'Internal error')
  }
}
