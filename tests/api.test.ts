import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../src/core/errors'
import { streamChat, type ApiConfig } from '../src/background/api'

const cloud: ApiConfig = { baseUrl: 'https://api.example.com/v1', model: 'anthropic/claude-haiku-5.5', headers: { 'X-Silk-Install': 'id-1' } }

function sse(...pieces: string[]): Response {
  const body = pieces.map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

async function collect(cfg: ApiConfig): Promise<string> {
  let out = ''
  for await (const piece of streamChat(cfg, [{ role: 'user', content: 'hi' }])) out += piece
  return out
}

afterEach(() => vi.unstubAllGlobals())

describe('streamChat against the Silk backend', () => {
  it('sends the install id and chosen model, and never an Authorization header', async () => {
    const fetchMock = vi.fn(async () => sse('你', '好'))
    vi.stubGlobal('fetch', fetchMock)
    expect(await collect(cloud)).toBe('你好')
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', 'X-Silk-Install': 'id-1' })
    expect(JSON.parse(init.body as string)).toMatchObject({ model: 'anthropic/claude-haiku-5.5', stream: true })
  })

  it('maps a used-up quota to a final "quota" error without retrying', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 429, headers: { 'X-Silk-Error': 'quota_exceeded' } }))
    vi.stubGlobal('fetch', fetchMock)
    const error = await collect(cloud).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).code).toBe('quota')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('maps HTTP 402 to "upgrade"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 402 })))
    const error = (await collect(cloud).catch((err: unknown) => err)) as ApiError
    expect(error.code).toBe('upgrade')
  })
})
