// Roadmap 0.5 acceptance: the real transport (api.ts) and batch translator together must not
// amplify a backend outage.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../src/shared/settings'

const TOKEN = '3f2a8c1e-1b2c-4d5e-8f90-1234567890ab.' + 'A'.repeat(43)

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  const store: Record<string, unknown> = { installToken: TOKEN }
  vi.stubGlobal('chrome', {
    storage: { local: { get: async (key: string) => (key in store ? { [key]: store[key] } : {}), set: async () => undefined, remove: async () => undefined } },
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('backend outage', () => {
  it('sends at most 8 requests for a 12-paragraph batch while the backend keeps answering 502', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 502, headers: { 'X-Silk-Error': 'upstream_error' } }))
    vi.stubGlobal('fetch', fetchMock)
    const { translateBatch } = await import('../src/background/translator')
    const texts = Array.from({ length: 12 }, (_, i) => `Paragraph number ${i} of the page.`)
    let isDone = false
    const pending = translateBatch(DEFAULT_SETTINGS, texts, '', () => undefined, new AbortController().signal).finally(() => (isDone = true))
    // Skip through the backoff delays.
    while (!isDone) await vi.advanceTimersByTimeAsync(1000)
    const outcome = await pending
    expect(outcome.failed).toHaveLength(12)
    expect(outcome.error?.code).toBe('server')
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(8)
  })
})
