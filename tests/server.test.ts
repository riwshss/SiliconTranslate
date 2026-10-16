import { describe, expect, it, vi } from 'vitest'
import { handleRequest, MODELS, parseChatRequest, PLAN_MODELS, type Deps, type Env, type QuotaStore } from '../server/src/app'
import { consume, usedToday, type QuotaState } from '../server/src/quota'

const INSTALL = '3f2a8c1e-1b2c-4d5e-8f90-1234567890ab'

const env: Env = {
  OPENROUTER_API_KEY: 'or-secret',
  INSTALL_DAILY_CHARS: '1000',
  IP_DAILY_CHARS: '10000',
  GLOBAL_DAILY_CHARS: '100000',
  MAX_REQUEST_CHARS: '800',
  MAX_OUTPUT_TOKENS: '512',
  APP_URL: 'https://example.com',
  APP_TITLE: 'Silk Translate',
}

function memoryQuota(): QuotaStore {
  const states = new Map<string, QuotaState>()
  return {
    async consume(key, amount, limit) {
      const { next, result } = consume(states.get(key), amount, limit, new Date())
      if (result.allowed) states.set(key, next)
      return result
    },
    async peek(key, limit) {
      const used = usedToday(states.get(key), new Date().toISOString().slice(0, 10))
      return { allowed: used < limit, used, limit, resetAt: 'x' }
    },
  }
}

function setup(upstream: () => Response = () => new Response('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })) {
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => upstream())
  const deps: Deps = { quota: memoryQuota(), fetch: fetchMock as unknown as typeof fetch }
  return { deps, fetchMock }
}

function chat(content: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = { 'X-Silk-Install': INSTALL }) {
  return new Request('https://api.test/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4', ...headers },
    body: JSON.stringify({ model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content }], stream: true, ...extra }),
  })
}

describe('quota math', () => {
  const now = new Date('2026-10-17T10:00:00Z')

  it('spends within the limit and refuses past it without changing the state', () => {
    const first = consume(undefined, 60, 100, now)
    expect(first.result).toMatchObject({ allowed: true, used: 60 })
    const second = consume(first.next, 50, 100, now)
    expect(second.result).toMatchObject({ allowed: false, used: 60, resetAt: '2026-10-18T00:00:00.000Z' })
    expect(second.next).toEqual(first.next)
  })

  it('refunds with a negative amount, never below zero', () => {
    const spent = consume(undefined, 30, 100, now).next
    expect(consume(spent, -10, 100, now).result).toMatchObject({ allowed: true, used: 20 })
    expect(consume(spent, -99, 100, now).result).toMatchObject({ allowed: true, used: 0 })
  })

  it('starts from zero on a new UTC day', () => {
    const yesterday: QuotaState = { day: '2026-10-16', used: 100 }
    expect(consume(yesterday, 10, 100, now).result).toMatchObject({ allowed: true, used: 10 })
  })
})

describe('parseChatRequest', () => {
  it('keeps only messages and sampling knobs, clamping max_tokens to the server ceiling', () => {
    const req = parseChatRequest({ model: 'openai/gpt-6-sol', messages: [{ role: 'user', content: 'hi' }], max_tokens: 99999, temperature: 7 }, 512)
    expect(req).toEqual({ model: 'openai/gpt-6-sol', messages: [{ role: 'user', content: 'hi' }], stream: false, temperature: 1, maxTokens: 512 })
  })

  it('only accepts known models and leaves the default to the plan', () => {
    const messages = [{ role: 'user', content: 'hi' }]
    expect(MODELS).toEqual(['deepseek/deepseek-v4-flash', 'anthropic/claude-haiku-5.5', 'openai/gpt-6-sol', 'google/gemini-3.8-flash'])
    expect(PLAN_MODELS.beta).toEqual(['deepseek/deepseek-v4-flash'])
    expect(parseChatRequest({ messages }, 512)?.model).toBeNull()
    // Extension v2.0 always sent "silk-cloud": it keeps working on the plan default.
    expect(parseChatRequest({ model: 'silk-cloud', messages }, 512)?.model).toBeNull()
    expect(parseChatRequest({ model: 'openai/gpt-6-astra', messages }, 512)).toBeNull()
    expect(parseChatRequest({ model: 42, messages }, 512)).toBeNull()
  })

  it('rejects malformed bodies', () => {
    expect(parseChatRequest(null, 512)).toBeNull()
    expect(parseChatRequest({ messages: [] }, 512)).toBeNull()
    expect(parseChatRequest({ messages: [{ role: 'tool', content: 'x' }] }, 512)).toBeNull()
    expect(parseChatRequest({ messages: [{ role: 'user', content: 42 }] }, 512)).toBeNull()
  })
})

describe('handleRequest', () => {
  it('requires a valid install id', async () => {
    const { deps } = setup()
    const res = await handleRequest(chat('hello', {}, { 'X-Silk-Install': 'nope' }), env, deps)
    expect(res.status).toBe(401)
    expect(res.headers.get('X-Silk-Error')).toBe('unauthorized')
  })

  it('reports the beta plan and today quota in the standard envelope', async () => {
    const { deps } = setup()
    await handleRequest(chat('hello'), env, deps)
    const res = await handleRequest(new Request('https://api.test/v1/entitlement', { headers: { 'X-Silk-Install': INSTALL } }), env, deps)
    expect(await res.json()).toMatchObject({
      success: true,
      error: null,
      // "hello" is 5 characters, but every request costs at least the 200-character minimum.
      data: { plan: 'beta', features: ['cloud-ai'], models: ['deepseek/deepseek-v4-flash'], quota: { used: 200, limit: 1000 } },
    })
  })

  it('forwards to OpenRouter with the server key and the chosen model, reasoning off', async () => {
    const { deps, fetchMock } = setup()
    const res = await handleRequest(chat('hello'), env, deps)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/event-stream')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer or-secret')
    // Output is capped by input size (5 chars * 2 + 256), so a tiny prompt cannot buy a long answer.
    expect(JSON.parse(init?.body as string)).toMatchObject({ model: 'deepseek/deepseek-v4-flash', stream: true, max_tokens: 266, reasoning: { effort: 'none' } })
  })

  it('uses the plan default when the client names no model', async () => {
    const { deps, fetchMock } = setup()
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'hello' }], stream: true })
    const req = new Request('https://api.test/v1/chat/completions', { method: 'POST', headers: { 'X-Silk-Install': INSTALL }, body })
    expect((await handleRequest(req, env, deps)).status).toBe(200)
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string).model).toBe('deepseek/deepseek-v4-flash')
  })

  it('refuses models the beta plan does not include, without spending quota', async () => {
    const { deps, fetchMock } = setup()
    for (const model of ['anthropic/claude-haiku-5.5', 'openai/gpt-6-sol', 'google/gemini-3.8-flash']) {
      const res = await handleRequest(chat('hello', { model }), env, deps)
      expect(res.status).toBe(403)
      expect(res.headers.get('X-Silk-Error')).toBe('model_locked')
    }
    expect(fetchMock).not.toHaveBeenCalled()
    const res = await handleRequest(new Request('https://api.test/v1/entitlement', { headers: { 'X-Silk-Install': INSTALL } }), env, deps)
    expect(await res.json()).toMatchObject({ data: { quota: { used: 0 } } })
  })

  it('answers 429 quota_exceeded once the daily quota is spent, without calling the AI', async () => {
    const { deps, fetchMock } = setup()
    for (let i = 0; i < 2; i++) expect((await handleRequest(chat('x'.repeat(500)), env, deps)).status).toBe(200)
    const res = await handleRequest(chat('more'), env, deps)
    expect(res.status).toBe(429)
    expect(res.headers.get('X-Silk-Error')).toBe('quota_exceeded')
    expect(await res.json()).toMatchObject({ success: false, error: { code: 'quota_exceeded' }, meta: { used: 1000, limit: 1000 } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('gives back the install quota when a later counter (client IP) is exhausted', async () => {
    const { deps } = setup()
    const tightIp = { ...env, IP_DAILY_CHARS: '400' }
    const other = '00000000-0000-4000-8000-000000000000'
    expect((await handleRequest(chat('x'.repeat(300), {}, { 'X-Silk-Install': other }), tightIp, deps)).status).toBe(200)
    expect((await handleRequest(chat('y'.repeat(300)), tightIp, deps)).status).toBe(429)
    const res = await handleRequest(new Request('https://api.test/v1/entitlement', { headers: { 'X-Silk-Install': INSTALL } }), tightIp, deps)
    expect(await res.json()).toMatchObject({ data: { quota: { used: 0 } } })
  })

  it('refuses models outside the allowlist without spending quota', async () => {
    const { deps, fetchMock } = setup()
    const res = await handleRequest(chat('hello', { model: 'openai/gpt-6-astra-pro' }), env, deps)
    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects oversized requests before spending quota', async () => {
    const { deps, fetchMock } = setup()
    const res = await handleRequest(chat('x'.repeat(801)), env, deps)
    expect(res.status).toBe(413)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a body whose declared length is far beyond the request ceiling without parsing it', async () => {
    const { deps, fetchMock } = setup()
    const res = await handleRequest(chat('small', {}, { 'X-Silk-Install': INSTALL, 'Content-Length': '999999' }), env, deps)
    expect(res.status).toBe(413)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('passes an upstream rate limit through as a retryable 429 (no X-Silk-Error)', async () => {
    const { deps } = setup(() => new Response('busy', { status: 429 }))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const res = await handleRequest(chat('hello'), env, deps)
    expect(res.status).toBe(429)
    expect(res.headers.get('X-Silk-Error')).toBeNull()
    expect(res.headers.get('Retry-After')).toBe('2')
  })

  it('refunds the quota when the AI provider fails, so client retries cost nothing', async () => {
    const { deps } = setup(() => new Response('down', { status: 500 }))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect((await handleRequest(chat('x'.repeat(500)), env, deps)).status).toBe(502)
    const res = await handleRequest(new Request('https://api.test/v1/entitlement', { headers: { 'X-Silk-Install': INSTALL } }), env, deps)
    expect(await res.json()).toMatchObject({ data: { quota: { used: 0 } } })
  })

  it('hides upstream failures behind a generic 502', async () => {
    const { deps } = setup(() => new Response('secret details', { status: 500 }))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const res = await handleRequest(chat('hello'), env, deps)
    expect(res.status).toBe(502)
    expect(await res.text()).not.toContain('secret details')
  })

  it('answers CORS preflight and 404 for unknown routes', async () => {
    const { deps } = setup()
    expect((await handleRequest(new Request('https://api.test/v1/chat/completions', { method: 'OPTIONS' }), env, deps)).status).toBe(204)
    expect((await handleRequest(new Request('https://api.test/nope'), env, deps)).status).toBe(404)
  })
})
