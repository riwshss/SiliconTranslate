import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../src/core/errors'
import type { ChatMessage } from '../src/core/prompt'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings'

/** Each call to the fake model gets the parsed batch ({"0": "…"}) and returns its reply chunks or throws. */
let model: (batch: Record<string, string>, call: number) => string[]
let calls: Array<Record<string, string>> = []

vi.mock('../src/background/api', () => ({
  onRateLimited: () => undefined,
  streamChat: async function* (_cfg: unknown, messages: ChatMessage[]) {
    const batch = JSON.parse(messages[1].content) as Record<string, string>
    calls.push(batch)
    yield* model(batch, calls.length)
  },
}))

const { translateBatch, plainReply, looksTruncated } = await import('../src/background/translator')

let settingsId = 0
/** A fresh model name per test keeps the module-level translation cache from leaking between tests. */
const settings = (): Settings => ({ ...DEFAULT_SETTINGS, apiKey: 'sk-test', model: `test/model-${++settingsId}` })

async function translate(texts: string[]) {
  const items: Record<number, string> = {}
  const outcome = await translateBatch(settings(), texts, '', (i, text) => (items[i] = text), new AbortController().signal)
  return { items, outcome }
}

const json = (batch: Record<string, string>, fn: (text: string) => string) =>
  JSON.stringify(Object.fromEntries(Object.entries(batch).map(([k, v]) => [k, fn(v)])))

beforeEach(() => {
  calls = []
})

describe('translateBatch retries', () => {
  it('retries every item alone when the whole batch reply is unreadable', async () => {
    model = (batch, call) => (call === 1 ? ['抱歉，我无法按要求输出。'] : [json(batch, (t) => `译:${t}`)])
    const { items, outcome } = await translate(['one', 'two', 'three'])
    expect(items).toEqual({ 0: '译:one', 1: '译:two', 2: '译:three' })
    expect(outcome).toEqual({ failed: [] })
    expect(calls).toHaveLength(4)
  })

  it('retries a single-item batch, and accepts a plain-text reply to a one-item request', async () => {
    model = (_batch, call) => (call === 1 ? ['{"0": ""}'] : ['```\n译文\n```'])
    const { items, outcome } = await translate(['only one'])
    expect(items).toEqual({ 0: '译文' })
    expect(outcome.failed).toEqual([])
  })

  it('retries items alone after a retryable request error such as a rate limit', async () => {
    model = (batch, call) => {
      if (call === 1) throw new ApiError('rate-limit')
      return [json(batch, (t) => `译:${t}`)]
    }
    const { items, outcome } = await translate(['a', 'b'])
    expect(items).toEqual({ 0: '译:a', 1: '译:b' })
    expect(outcome.failed).toEqual([])
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

  it('reports the last error when the retries fail too', async () => {
    model = (_batch, call) => {
      throw new ApiError(call === 1 ? 'server' : 'rate-limit')
    }
    const { outcome } = await translate(['a'])
    expect(outcome.failed).toEqual([0])
    expect(outcome.error?.code).toBe('rate-limit')
  })

  it('re-requests a translation that looks cut off, keeping it only if the retry brings nothing', async () => {
    const long = 'This sentence is long enough that a two-character translation cannot be right.'
    model = (batch, call) => (call === 1 ? [json(batch, () => '他说')] : [json(batch, () => '这句话足够长，两个字的译文不可能是对的。')])
    const { items } = await translate([long])
    expect(items).toEqual({ 0: '这句话足够长，两个字的译文不可能是对的。' })

    model = (batch, call) => (call === 1 ? [json(batch, () => '他说')] : ['{"0": ""}'])
    calls = []
    expect((await translate([long])).items).toEqual({ 0: '他说' })
  })
})

describe('translator helpers', () => {
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
