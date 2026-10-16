import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../src/core/errors'
import { streamTranslate, type ApiConfig, type TranslateEvent } from '../src/background/api'

const cloud: ApiConfig = { baseUrl: 'https://api.example.com/v1', model: 'anthropic/claude-haiku-5.5', headers: { 'X-Silk-Install': 'token-1' } }
const page = { target: 'zh-CN', title: 'T', kind: 'page' as const, texts: ['a', 'b'] }

function events(...lines: unknown[]): Response {
  const body = lines.map((line) => `data: ${typeof line === 'string' ? line : JSON.stringify(line)}\n\n`).join('')
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

async function collect(): Promise<TranslateEvent[]> {
  const out: TranslateEvent[] = []
  for await (const event of streamTranslate(cloud, page)) out.push(event)
  return out
}

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1000 }))
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('streamTranslate against the Silk backend', () => {
  it('posts data only (no prompt) with the install token, and never an Authorization header', async () => {
    const fetchMock = vi.fn(async () => events({ index: 1, text: '乙' }, { index: 0, text: '甲' }, '[DONE]'))
    vi.stubGlobal('fetch', fetchMock)
    expect(await collect()).toEqual([
      { index: 1, text: '乙' },
      { index: 0, text: '甲' },
    ])
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.example.com/v1/translate')
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', 'X-Silk-Install': 'token-1' })
    expect(JSON.parse(init.body as string)).toEqual({ model: 'anthropic/claude-haiku-5.5', ...page })
  })

  it('throws an error event as the matching error, after the events before it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => events({ index: 0, text: '甲' }, { error: { code: 'quota_exceeded', message: 'x' } })))
    const seen: TranslateEvent[] = []
    const error = await (async () => {
      for await (const event of streamTranslate(cloud, page)) seen.push(event)
    })().catch((err: unknown) => err)
    expect(seen).toEqual([{ index: 0, text: '甲' }])
    expect((error as ApiError).code).toBe('quota')
  })

  it('maps a used-up quota to a final "quota" error without retrying', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 429, headers: { 'X-Silk-Error': 'quota_exceeded' } }))
    vi.stubGlobal('fetch', fetchMock)
    const error = await collect().catch((err: unknown) => err)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).code).toBe('quota')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('maps HTTP 402 to "upgrade"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 402 })))
    const error = (await collect().catch((err: unknown) => err)) as ApiError
    expect(error.code).toBe('upgrade')
  })

  it('retries a transient backend error (502 upstream_error) even though it carries X-Silk-Error', async () => {
    let call = 0
    const fetchMock = vi.fn(async () =>
      ++call === 1 ? new Response('{}', { status: 502, headers: { 'X-Silk-Error': 'upstream_error' } }) : events({ index: 0, text: '甲' }, '[DONE]'),
    )
    vi.stubGlobal('fetch', fetchMock)
    expect(await collect()).toEqual([{ index: 0, text: '甲' }])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry a refused install token', async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":{"message":"bad token"}}', { status: 401, headers: { 'X-Silk-Error': 'unauthorized' } }))
    vi.stubGlobal('fetch', fetchMock)
    const error = (await collect().catch((err: unknown) => err)) as ApiError
    expect(error.code).toBe('auth')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('install token', () => {
  const TOKEN = '3f2a8c1e-1b2c-4d5e-8f90-1234567890ab.' + 'b'.repeat(43)
  let store: Record<string, unknown>

  beforeEach(() => {
    vi.resetModules()
    store = { installId: '3f2a8c1e-1b2c-4d5e-8f90-1234567890ab' }
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: async (key: string) => (key in store ? { [key]: store[key] } : {}),
          set: async (items: Record<string, unknown>) => Object.assign(store, items),
          remove: async (key: string) => delete store[key],
        },
      },
    })
  })

  it('is asked from the backend once, then kept; the old unsigned id is dropped', async () => {
    const fetchMock = vi.fn(async () => Response.json({ success: true, data: { token: TOKEN } }))
    vi.stubGlobal('fetch', fetchMock)
    const { getInstallToken } = await import('../src/background/account')
    expect(await Promise.all([getInstallToken(), getInstallToken()])).toEqual([TOKEN, TOKEN])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].method).toBe('POST')
    expect(store).toEqual({ installToken: TOKEN })
  })

  it('is asked again after the backend refused it', async () => {
    const fetchMock = vi.fn(async () => Response.json({ success: true, data: { token: TOKEN } }))
    vi.stubGlobal('fetch', fetchMock)
    const { forgetInstallToken, getInstallToken } = await import('../src/background/account')
    await getInstallToken()
    await forgetInstallToken()
    expect(store.installToken).toBeUndefined()
    await getInstallToken()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('rejects a malformed answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: true, data: { token: 'nope' } })))
    const { getInstallToken } = await import('../src/background/account')
    await expect(getInstallToken()).rejects.toMatchObject({ code: 'bad-response' })
  })
})
