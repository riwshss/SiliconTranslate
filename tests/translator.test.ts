import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiConfig, TranslateBody, TranslateEvent } from '../src/background/api'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings'

/**
 * Each call to the fake backend gets the batch ({"0": "…"}) and returns the translations it
 * streams back ({"0": "…"}, keys it leaves out are skipped), or throws. An Error value is thrown
 * at that point of the stream.
 */
let model: (batch: Record<string, string>, call: number) => Record<string, string | Error>
let calls: Array<Record<string, string>> = []
let configs: ApiConfig[] = []
let bodies: TranslateBody[] = []

vi.mock('../src/background/api', () => ({
  onRateLimited: () => undefined,
  streamTranslate: async function* (cfg: ApiConfig, body: TranslateBody): AsyncGenerator<TranslateEvent> {
    const batch = Object.fromEntries(body.texts.map((t, i) => [String(i), t]))
    calls.push(batch)
    configs.push(cfg)
    bodies.push(body)
    for (const [key, text] of Object.entries(model(batch, calls.length))) {
      if (text instanceof Error) throw text
      yield { index: Number(key), text }
    }
  },
}))

type Translator = typeof import('../src/background/translator')
/** Re-imported with the translator so `instanceof ApiError` matches the module under test. */
let ApiError: typeof import('../src/core/errors')['ApiError']
/** Re-imported before every test: a fresh module means an empty translation cache and install id. */
let translateBatch: Translator['translateBatch']
const { plainReply, looksTruncated } = await import('../src/core/reply')

async function translate(texts: string[], withSettings: Settings = DEFAULT_SETTINGS) {
  const items: Record<number, string> = {}
  const outcome = await translateBatch(withSettings, texts, '', (i, text) => (items[i] = text), new AbortController().signal)
  return { items, outcome }
}

const each = (batch: Record<string, string>, fn: (text: string) => string) => Object.fromEntries(Object.entries(batch).map(([k, v]) => [k, fn(v)]))

const TOKEN = '3f2a8c1e-1b2c-4d5e-8f90-1234567890ab.' + 'A'.repeat(43)

/** chrome.storage stand-in: the engine keeps the install token and cached plan there. */
let store: Record<string, unknown>

beforeEach(async () => {
  vi.resetModules()
  ;({ translateBatch } = await import('../src/background/translator'))
  ;({ ApiError } = await import('../src/core/errors'))
  calls = []
  configs = []
  bodies = []
  store = { installToken: TOKEN }
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

describe('translateBatch retries', () => {
  it('retries each skipped item on its own when the request itself succeeded', async () => {
    model = (batch, call) => (call === 1 ? { 0: '译:one' } : each(batch, (t) => `译:${t}`))
    const { items, outcome } = await translate(['one', 'two', 'three'])
    expect(items).toEqual({ 0: '译:one', 1: '译:two', 2: '译:three' })
    expect(outcome).toEqual({ failed: [] })
    expect(calls).toEqual([{ 0: 'one', 1: 'two', 2: 'three' }, { 0: 'two' }, { 0: 'three' }])
  })

  it('retries a failed request once as a whole instead of one request per item', async () => {
    model = (batch, call) => {
      if (call === 1) throw new ApiError('server')
      return each(batch, (t) => `译:${t}`)
    }
    const { items, outcome } = await translate(['a', 'b', 'c'])
    expect(items).toEqual({ 0: '译:a', 1: '译:b', 2: '译:c' })
    expect(outcome.failed).toEqual([])
    expect(calls).toEqual([{ 0: 'a', 1: 'b', 2: 'c' }, { 0: 'a', 1: 'b', 2: 'c' }])
  })

  it('retries only what a failed request had not delivered yet', async () => {
    model = (batch, call) => (call === 1 ? { 0: '译:a', 1: new ApiError('server') } : each(batch, (t) => `译:${t}`))
    const { items } = await translate(['a', 'b', 'c'])
    expect(items).toEqual({ 0: '译:a', 1: '译:b', 2: '译:c' })
    expect(calls).toEqual([{ 0: 'a', 1: 'b', 2: 'c' }, { 0: 'b', 1: 'c' }])
  })

  it('does not retry errors a second try cannot fix', async () => {
    model = () => {
      throw new ApiError('auth')
    }
    const { outcome } = await translate(['a', 'b'])
    expect(calls).toHaveLength(1)
    expect(outcome.failed).toEqual([0, 1])
    expect(outcome.error?.code).toBe('auth')
  })

  it('reports the last error when the retry fails too', async () => {
    model = (_batch, call) => {
      throw new ApiError(call === 1 ? 'server' : 'rate-limit')
    }
    const { outcome } = await translate(['a'])
    expect(outcome.failed).toEqual([0])
    expect(outcome.error?.code).toBe('rate-limit')
    expect(calls).toHaveLength(2)
  })

  it('re-requests a translation that looks cut off, keeping it only if the retry brings nothing', async () => {
    const long = 'This sentence is long enough that a two-character translation cannot be right.'
    model = (batch, call) => (call === 1 ? each(batch, () => '他说') : each(batch, () => '这句话足够长，两个字的译文不可能是对的。'))
    const { items } = await translate([long])
    expect(items).toEqual({ 0: '这句话足够长，两个字的译文不可能是对的。' })

    model = (batch, call) => (call === 1 ? each(batch, () => '他说') : {})
    calls = []
    // A different sentence: the first one is cached now.
    expect((await translate([`${long} Again.`])).items).toEqual({ 0: '他说' })
  })

  it('re-requests a translation that lost its formatting markers, keeping it only as a last resort', async () => {
    model = (batch, call) => (call === 1 ? each(batch, () => '点击这里继续') : each(batch, () => '点击<g0>这里</g0>继续'))
    expect((await translate(['Click <g0>here</g0> to go on'])).items).toEqual({ 0: '点击<g0>这里</g0>继续' })
    expect(calls).toHaveLength(2)

    model = (batch) => each(batch, () => '点击那里继续')
    expect((await translate(['Click <g0>there</g0> to go on'])).items).toEqual({ 0: '点击那里继续' })
  })

  it('sends data only: target language code, page title (at most 200 characters) and the texts', async () => {
    model = (batch) => each(batch, (t) => t)
    await translateBatch(DEFAULT_SETTINGS, ['hello'], 'T'.repeat(300), () => undefined, new AbortController().signal)
    expect(bodies[0]).toEqual({ target: DEFAULT_SETTINGS.targetLang, title: 'T'.repeat(200), kind: 'page', texts: ['hello'] })
  })
})

describe('translator helpers', () => {
  it('picks the selection direction, and the switch button picks the other one', async () => {
    const { pickSelectionLanguage } = await import('../src/background/translator')
    const zhTw = { ...DEFAULT_SETTINGS, targetLang: 'zh-TW' }
    expect(pickSelectionLanguage(zhTw, 'Hello world, this is the plan').code).toBe('zh-TW')
    expect(pickSelectionLanguage(zhTw, 'Hello world, this is the plan', true).code).toBe('en')
    // Already in the target language: the other way round, and the switch brings it back.
    expect(pickSelectionLanguage(zhTw, '這是中文句子').code).toBe('en')
    expect(pickSelectionLanguage(zhTw, '這是中文句子', true).code).toBe('zh-TW')
  })

  it('plainReply unwraps fences and think blocks but rejects JSON-looking replies', () => {
    expect(plainReply('<think>hmm</think>\n```text\n你好\n```')).toBe('你好')
    expect(plainReply('{"0": broken')).toBeNull()
    expect(plainReply('   ')).toBeNull()
  })

  it('looksTruncated only flags long sources with tiny translations', () => {
    expect(looksTruncated('short text', '短')).toBe(false)
    expect(looksTruncated('x'.repeat(100), '这是一个正常长度的翻译结果')).toBe(false)
    expect(looksTruncated('x'.repeat(100), '他说')).toBe(true)
  })
})

describe('Silk AI cloud engine', () => {
  /** Fresh text per test: these tests share the default model's cache key prefix. */
  let textId = 0
  const cloudText = () => `cloud text ${++textId}`

  it('calls the Silk backend with the stored install token and the beta model', async () => {
    model = (batch) => each(batch, (t) => `译:${t}`)
    const text = cloudText()
    const { items } = await translate([text])
    expect(items).toEqual({ 0: `译:${text}` })
    expect(configs[0].model).toBe('deepseek/deepseek-v4-flash')
    expect(configs[0].baseUrl).toMatch(/\/v1$/)
    expect(configs[0].headers?.['X-Silk-Install']).toBe(TOKEN)
  })

  it('falls back to the plan default while the chosen model is locked (beta)', async () => {
    model = (batch) => each(batch, (t) => `译:${t}`)
    const text = cloudText()
    await translate([text], { ...DEFAULT_SETTINGS, model: 'openai/gpt-6-sol' })
    expect(configs[0].model).toBe('deepseek/deepseek-v4-flash')
  })

  it('uses the chosen model once the plan includes it, with its own cache', async () => {
    model = (batch) => each(batch, (t) => `译:${t}`)
    const text = cloudText()
    await translate([text])
    store.entitlement = { plan: 'pro', features: ['cloud-ai'], models: ['deepseek/deepseek-v4-flash', 'openai/gpt-6-sol'], quota: null }
    await translate([text], { ...DEFAULT_SETTINGS, model: 'openai/gpt-6-sol' })
    expect(configs.map((c) => c.model)).toEqual(['deepseek/deepseek-v4-flash', 'openai/gpt-6-sol'])
  })

  it('treats a used-up daily quota as final: no per-item retries', async () => {
    model = () => {
      throw new ApiError('quota')
    }
    const { outcome } = await translate([cloudText(), cloudText()], DEFAULT_SETTINGS)
    expect(outcome.failed).toEqual([0, 1])
    expect(outcome.error?.code).toBe('quota')
    expect(calls).toHaveLength(1)
  })

  it('stops before any request when the cached plan does not include cloud AI', async () => {
    store.entitlement = { plan: 'free', features: [], models: [], quota: null }
    model = (batch) => each(batch, (t) => t)
    // Like a missing key, a missing plan is a setup error: it rejects and the port reports every item failed.
    await expect(translate([cloudText()], DEFAULT_SETTINGS)).rejects.toMatchObject({ code: 'upgrade' })
    expect(calls).toHaveLength(0)
  })
})
