// Request handling for the Silk Translate backend, kept free of Cloudflare imports so it can be
// unit-tested in Node. The extension sends an anonymous install id; every AI request is checked
// against daily quotas (per install, per client IP, and a global wallet guard) and forwarded to
// OpenRouter with the server-side key. The client picks one of MODELS that its plan allows;
// anything else is refused.
// The key never reaches the client.

import type { QuotaResult } from './quota'

export interface Env {
  readonly OPENROUTER_API_KEY: string
  readonly INSTALL_DAILY_CHARS: string
  readonly IP_DAILY_CHARS: string
  readonly GLOBAL_DAILY_CHARS: string
  readonly MAX_REQUEST_CHARS: string
  readonly MAX_OUTPUT_TOKENS: string
  readonly APP_URL: string
  readonly APP_TITLE: string
}

/** Counter storage, one counter per key; backed by a Durable Object in production. */
export interface QuotaStore {
  consume(key: string, amount: number, limit: number): Promise<QuotaResult>
  peek(key: string, limit: number): Promise<QuotaResult>
}

export interface Deps {
  readonly quota: QuotaStore
  readonly fetch: typeof fetch
}

/** Today every install is on the free beta; paid plans will be resolved here later. */
export type Plan = 'beta' | 'free' | 'pro'
const CURRENT_PLAN: Plan = 'beta'
const PLAN_FEATURES: Record<Plan, readonly string[]> = { beta: ['cloud-ai'], free: [], pro: ['cloud-ai'] }

/** OpenRouter ids the extension may ask for; same list and order as CLOUD_MODELS in src/shared/settings.ts. */
export const MODELS: readonly string[] = ['deepseek/deepseek-v4-flash', 'anthropic/claude-haiku-5.5', 'openai/gpt-6-sol', 'google/gemini-3.8-flash']

/**
 * Models each plan may use; the first is the plan's default. The free beta only gets the
 * cheapest model, the others open with paid plans.
 */
export const PLAN_MODELS: Record<Plan, readonly string[]> = { beta: ['deepseek/deepseek-v4-flash'], free: [], pro: MODELS }

/** Extra OpenRouter fields per model. DeepSeek V4 can reason, which translation never needs. */
const MODEL_OPTIONS: Readonly<Record<string, Record<string, unknown>>> = {
  'deepseek/deepseek-v4-flash': { reasoning: { effort: 'none' } },
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const INSTALL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ROLES = new Set(['system', 'user', 'assistant'])
const MAX_MESSAGES = 8
/**
 * Quota counts prompt characters only, so the answer length is bounded by the prompt: a
 * translation is never much longer than its source. Together with a minimum charge per request,
 * this caps what one install can spend on output tokens.
 */
const MIN_CHARGE_CHARS = 200
const OUTPUT_TOKENS_PER_CHAR = 2
const OUTPUT_TOKENS_BASE = 256
/** UTF-8 JSON can be ~4 bytes per character; anything far beyond that is refused unread. */
const BYTES_PER_CHAR_BUDGET = 8

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Silk-Install',
  'Access-Control-Expose-Headers': 'X-Silk-Error',
}

export type ErrorCode = 'bad_request' | 'unauthorized' | 'quota_exceeded' | 'upgrade_required' | 'model_locked' | 'not_found' | 'upstream_error' | 'server_error'

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

function limitOf(value: string, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

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
  if (body.model !== undefined && !MODELS.includes(body.model as string)) return null
  const temperature = Number(body.temperature)
  const maxTokens = Number(body.max_tokens)
  return {
    model: (body.model as string | undefined) ?? null,
    messages: messages.map((m) => ({ role: m.role as string, content: m.content as string })),
    stream: body.stream === true,
    temperature: Number.isFinite(temperature) ? Math.min(Math.max(temperature, 0), 1) : 0.2,
    maxTokens: Number.isInteger(maxTokens) && maxTokens > 0 ? Math.min(maxTokens, maxOutputTokens) : maxOutputTokens,
  }
}

export function promptChars(req: ChatRequest): number {
  return req.messages.reduce((sum, m) => sum + m.content.length, 0)
}

function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown'
}

function installId(request: Request): string | null {
  const id = request.headers.get('X-Silk-Install')
  return id && INSTALL_ID_RE.test(id) ? id.toLowerCase() : null
}

function quotaMeta(q: QuotaResult) {
  return { used: q.used, limit: q.limit, resetAt: q.resetAt }
}

async function handleEntitlement(request: Request, env: Env, deps: Deps): Promise<Response> {
  const id = installId(request)
  if (!id) return fail(401, 'unauthorized', 'Missing or invalid install id')
  const quota = await deps.quota.peek(`install:${id}`, limitOf(env.INSTALL_DAILY_CHARS, 2_000_000))
  return ok({ plan: CURRENT_PLAN, features: PLAN_FEATURES[CURRENT_PLAN], models: PLAN_MODELS[CURRENT_PLAN], quota: quotaMeta(quota) })
}

/**
 * Spends `amount` on every counter in order. At the first exhausted one, gives back what the
 * earlier counters took and returns that counter's state; null when everything was spent.
 */
async function spend(deps: Deps, amount: number, counters: ReadonlyArray<[string, number]>): Promise<QuotaResult | null> {
  for (const [index, [key, limit]] of counters.entries()) {
    const result = await deps.quota.consume(key, amount, limit)
    if (!result.allowed) {
      await refund(deps, amount, counters.slice(0, index))
      return result
    }
  }
  return null
}

/** Gives `amount` back to every counter: a failed AI call must not cost the user quota. */
async function refund(deps: Deps, amount: number, counters: ReadonlyArray<[string, number]>): Promise<void> {
  await Promise.all(counters.map(([key, limit]) => deps.quota.consume(key, -amount, limit)))
}

async function handleChat(request: Request, env: Env, deps: Deps): Promise<Response> {
  const id = installId(request)
  if (!id) return fail(401, 'unauthorized', 'Missing or invalid install id')
  if (!PLAN_FEATURES[CURRENT_PLAN].includes('cloud-ai')) return fail(402, 'upgrade_required', 'Cloud AI requires an upgrade')

  const maxRequestChars = limitOf(env.MAX_REQUEST_CHARS, 24_000)
  if (Number(request.headers.get('Content-Length')) > maxRequestChars * BYTES_PER_CHAR_BUDGET) return fail(413, 'bad_request', 'Request too large')
  const raw = await request.json().catch(() => null)
  const chat = parseChatRequest(raw, limitOf(env.MAX_OUTPUT_TOKENS, 8192))
  if (!chat) return fail(400, 'bad_request', 'Invalid chat request')
  const model = chat.model ?? PLAN_MODELS[CURRENT_PLAN][0]
  if (!PLAN_MODELS[CURRENT_PLAN].includes(model)) return fail(403, 'model_locked', 'This model is not available on your plan')
  const textChars = promptChars(chat)
  if (textChars > maxRequestChars) return fail(413, 'bad_request', 'Request too large')
  const chars = Math.max(textChars, MIN_CHARGE_CHARS)
  const maxTokens = Math.min(chat.maxTokens, textChars * OUTPUT_TOKENS_PER_CHAR + OUTPUT_TOKENS_BASE)

  const counters: Array<[string, number]> = [
    [`install:${id}`, limitOf(env.INSTALL_DAILY_CHARS, 2_000_000)],
    [`ip:${clientIp(request)}`, limitOf(env.IP_DAILY_CHARS, 6_000_000)],
    ['global', limitOf(env.GLOBAL_DAILY_CHARS, 200_000_000)],
  ]
  const exhausted = await spend(deps, chars, counters)
  if (exhausted) return fail(429, 'quota_exceeded', 'Daily free quota used up', quotaMeta(exhausted))

  const upstream = await deps
    .fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': env.APP_URL,
        'X-Title': env.APP_TITLE,
      },
      body: JSON.stringify({
        model,
        messages: chat.messages,
        stream: chat.stream,
        temperature: chat.temperature,
        max_tokens: maxTokens,
        ...MODEL_OPTIONS[model],
      }),
    })
    .catch(() => null)
  if (!upstream?.ok) await refund(deps, chars, counters)
  if (!upstream) return fail(502, 'upstream_error', 'AI provider unreachable')
  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '')
    console.error('openrouter error', upstream.status, detail.slice(0, 500))
    // Upstream 429 is a provider rate limit, not the user's quota: let the client back off and retry.
    if (upstream.status === 429) return json(429, { success: false, data: null, error: { code: 'upstream_error', message: 'AI provider busy' }, meta: null }, { 'Retry-After': '2' })
    return fail(502, 'upstream_error', `AI provider error (HTTP ${upstream.status})`)
  }
  return new Response(upstream.body, {
    status: 200,
    headers: { 'Content-Type': upstream.headers.get('Content-Type') ?? 'text/event-stream', 'Cache-Control': 'no-store', ...CORS_HEADERS },
  })
}

export async function handleRequest(request: Request, env: Env, deps: Deps): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS })
  const { pathname } = new URL(request.url)
  try {
    if (pathname === '/v1/entitlement' && request.method === 'GET') return await handleEntitlement(request, env, deps)
    if (pathname === '/v1/chat/completions' && request.method === 'POST') return await handleChat(request, env, deps)
    if (pathname === '/' && request.method === 'GET') return ok({ service: 'silk-translate-api' })
    return fail(404, 'not_found', 'Not found')
  } catch (err) {
    console.error('unhandled', err instanceof Error ? err.stack : String(err))
    return fail(500, 'server_error', 'Internal error')
  }
}
