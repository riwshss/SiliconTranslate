import { describe, expect, it, vi } from 'vitest'
import { createObjectStreamParser } from '../src/core/stream-json'
import { createSseParser } from '../src/core/sse'
import { ConcurrencyPool } from '../src/core/pool'
import { FIRST_BATCH_CHARS, FIRST_BATCH_ITEMS, MAX_BATCH_CHARS, MAX_BATCH_ITEMS, MIN_BATCH_CHARS, splitBatches } from '../src/core/batching'
import { LruCache } from '../src/core/lru'
import { guessLanguageByScript, isLikelyInLanguage, shouldTranslateText } from '../src/core/text-filter'
import { BATCH_SYSTEM_PROMPT, buildBatchMessages } from '../src/core/prompt'
import { ApiError, toApiError } from '../src/core/errors'

describe('createObjectStreamParser', () => {
  it('emits pairs as soon as each value string completes, across arbitrary chunk splits', () => {
    const parser = createObjectStreamParser()
    const reply = '```json\n{"0": "你好，<g0>世界</g0>", "1":"第\\"二\\"段"}\n```'
    const emitted: Array<[string, string]> = []
    for (const ch of reply) emitted.push(...parser.push(ch))
    expect(emitted).toEqual([
      ['0', '你好，<g0>世界</g0>'],
      ['1', '第"二"段'],
    ])
  })

  it('ignores prose before the object and tolerates raw newlines in strings', () => {
    const parser = createObjectStreamParser()
    // After a ',' the parser looks one character further to be sure the value really ended.
    expect(parser.push('Sure! {"0":"a\nb",')).toEqual([])
    expect(parser.push(' "1": "c"}')).toEqual([
      ['0', 'a\nb'],
      ['1', 'c'],
    ])
  })

  const parseAll = (reply: string) => {
    const parser = createObjectStreamParser()
    const out: Array<[string, string]> = []
    for (const ch of reply) out.push(...parser.push(ch))
    return [...out, ...parser.end()]
  }

  it('keeps unescaped quotes inside a value instead of cutting the translation short', () => {
    expect(parseAll('{"0":"他说"你好"然后走了","1":"世界"}')).toEqual([
      ['0', '他说"你好"然后走了'],
      ['1', '世界'],
    ])
    expect(parseAll('{"0":"a "quoted" word"}')).toEqual([['0', 'a "quoted" word']])
  })

  it('accepts unquoted numeric keys and a bare array', () => {
    expect(parseAll('{0: "你好", 1:"世界"}')).toEqual([
      ['0', '你好'],
      ['1', '世界'],
    ])
    expect(parseAll('["你好", "世界"]')).toEqual([
      ['0', '你好'],
      ['1', '世界'],
    ])
  })

  it('skips a leading <think> block, even one containing braces', () => {
    expect(parseAll('<think>先想想 {"a":"b"}</think>\n{"0":"你好"}')).toEqual([['0', '你好']])
  })

  it('end() flushes a last value whose closing brace never arrived', () => {
    const parser = createObjectStreamParser()
    expect(parser.push('{"0":"甲","1":"乙"')).toEqual([['0', '甲']])
    expect(parser.end()).toEqual([['1', '乙']])
  })

  it('waits for the character after a string before deciding key vs value', () => {
    const parser = createObjectStreamParser()
    expect(parser.push('{"0"')).toEqual([])
    expect(parser.push(':"x"')).toEqual([])
    expect(parser.push('}')).toEqual([['0', 'x']])
  })

  it('skips non-string values without desynchronising', () => {
    const parser = createObjectStreamParser()
    expect(parser.push('{"0": 12, "1": "ok"}')).toEqual([['1', 'ok']])
  })
})

describe('createSseParser', () => {
  it('reassembles data lines split across chunks and handles CRLF', () => {
    const seen: string[] = []
    const parser = createSseParser((d) => seen.push(d))
    parser.push('data: {"a"')
    parser.push(':1}\r\n\r\n: comment\nda')
    parser.push('ta: [DONE]')
    parser.end()
    expect(seen).toEqual(['{"a":1}', '[DONE]'])
  })
})

describe('splitBatches', () => {
  const texts = (count: number, length: number) => Array.from({ length: count }, (_, i) => String(i).padEnd(length, 'x'))
  const sizes = (batches: string[][]) => batches.map((b) => b.reduce((sum, t) => sum + t.length, 0))

  it('spreads a screenful over every slot instead of one or two big requests', () => {
    const batches = splitBatches(texts(24, 150), 8)
    expect(batches).toHaveLength(8)
    expect(batches.flat()).toEqual(texts(24, 150))
  })

  it('does not split below the minimum batch size', () => {
    const batches = splitBatches(texts(10, 40), 8)
    expect(batches).toHaveLength(3)
    sizes(batches.slice(0, -1)).forEach((size) => expect(size).toBeGreaterThanOrEqual(MIN_BATCH_CHARS))
  })

  it('can lead with a tiny batch so the first translation shows up early', () => {
    const input = texts(24, 150)
    const batches = splitBatches(input, 8, true)
    expect(batches[0]).toEqual(input.slice(0, 2))
    expect(sizes([batches[0]])[0]).toBeLessThanOrEqual(FIRST_BATCH_CHARS)
    expect(batches.flat()).toEqual(input)
    expect(batches.length).toBeLessThanOrEqual(8)
    expect(splitBatches(texts(10, 20), 8, true)[0]).toHaveLength(FIRST_BATCH_ITEMS)
    // An oversized first key still goes out alone.
    expect(splitBatches(['a'.repeat(900), 'b'], 8, true)).toEqual([['a'.repeat(900)], ['b']])
    expect(splitBatches([], 8, true)).toEqual([])
  })

  it('respects the per-request ceilings and keeps order', () => {
    const input = texts(200, 100)
    const batches = splitBatches(input, 8)
    expect(batches.flat()).toEqual(input)
    batches.forEach((batch) => expect(batch.length).toBeLessThanOrEqual(MAX_BATCH_ITEMS))
    sizes(batches).forEach((size) => expect(size).toBeLessThanOrEqual(MAX_BATCH_CHARS))
  })

  it('sends an oversized item on its own and handles an empty queue', () => {
    expect(splitBatches(['a'.repeat(3000), 'b'], 8)).toEqual([['a'.repeat(3000)], ['b']])
    expect(splitBatches([], 8)).toEqual([])
  })
})

describe('ConcurrencyPool', () => {
  it('never runs more than the limit at once', async () => {
    const pool = new ConcurrencyPool(2)
    let active = 0
    let peak = 0
    const task = () =>
      pool.run(async () => {
        active++
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 5))
        active--
      })
    await Promise.all(Array.from({ length: 7 }, task))
    expect(peak).toBe(2)
  })

  it('runs high-priority tasks before queued normal ones', async () => {
    const pool = new ConcurrencyPool(1)
    const order: string[] = []
    const blocker = pool.run(() => new Promise<void>((r) => setTimeout(r, 5)))
    const normal = pool.run(async () => void order.push('normal'))
    const high = pool.run(async () => void order.push('high'), { priority: 'high' })
    await Promise.all([blocker, normal, high])
    expect(order).toEqual(['high', 'normal'])
  })

  it('rejects queued tasks whose signal aborts and does not run them', async () => {
    const pool = new ConcurrencyPool(1)
    const controller = new AbortController()
    const spy = vi.fn(async () => {})
    const blocker = pool.run(() => new Promise<void>((r) => setTimeout(r, 5)))
    const queued = pool.run(spy, { signal: controller.signal })
    controller.abort()
    await expect(queued).rejects.toThrow('Aborted')
    await blocker
    expect(spy).not.toHaveBeenCalled()
    expect(pool.pending).toBe(0)
  })

  it('rejects immediately for an already aborted signal and honours setLimit', async () => {
    const pool = new ConcurrencyPool(1)
    await expect(pool.run(async () => 1, { signal: AbortSignal.abort() })).rejects.toThrow()
    pool.setLimit(3)
    const results = await Promise.all([1, 2, 3].map((n) => pool.run(async () => n)))
    expect(results).toEqual([1, 2, 3])
    expect(pool.running).toBe(0)
  })
})

describe('LruCache', () => {
  it('evicts the least recently used entry', () => {
    const cache = new LruCache<string, number>(2)
    cache.set('a', 1)
    cache.set('b', 2)
    expect(cache.get('a')).toBe(1)
    cache.set('c', 3)
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toBe(1)
    expect(cache.size).toBe(2)
    cache.clear()
    expect(cache.size).toBe(0)
  })
})

describe('text filter', () => {
  it.each([
    ['12,345.00', false],
    ['→ ×', false],
    ['a', false],
    ['https://example.com/path', false],
    ['me@example.com', false],
    ['Hello world', true],
    ['v2 API', true],
  ])('shouldTranslateText(%j) → %s', (text, expected) => {
    expect(shouldTranslateText(text)).toBe(expected)
  })

  it('detects text already in the target language', () => {
    expect(isLikelyInLanguage('这是一个中文句子 with API', 'zh-CN')).toBe(true)
    expect(isLikelyInLanguage('これは日本語です', 'zh-CN')).toBe(false)
    expect(isLikelyInLanguage('これは日本語です', 'ja')).toBe(true)
    expect(isLikelyInLanguage('안녕하세요 여러분', 'ko')).toBe(true)
    expect(isLikelyInLanguage('This is the plan', 'en')).toBe(true)
    expect(isLikelyInLanguage('Ceci est le plan', 'en')).toBe(false)
    expect(isLikelyInLanguage('Hola mundo', 'es')).toBe(false)
    expect(isLikelyInLanguage('123', 'fr')).toBe(true)
  })
})

describe('prompt', () => {
  it('keeps the system prompt fixed and puts language, page title and a keyed JSON object in the user message', () => {
    const [system, user] = buildBatchMessages(['a', 'b'], 'Simplified Chinese', 'My Page')
    expect(system.content).toBe(BATCH_SYSTEM_PROMPT)
    expect(buildBatchMessages(['c'], 'Japanese', '')[0].content).toBe(BATCH_SYSTEM_PROMPT)
    const [head, payload] = user.content.split('\n\n')
    expect(head).toBe('Target language: Simplified Chinese\nPage title: My Page')
    expect(JSON.parse(payload)).toEqual({ 0: 'a', 1: 'b' })
  })
})

describe('errors', () => {
  it('maps unknown errors to friendly ApiErrors', () => {
    expect(toApiError(new DOMException('x', 'AbortError')).code).toBe('aborted')
    expect(toApiError(new Error('boom')).message).toContain('boom')
    const err = new ApiError('quota')
    expect(toApiError(err)).toBe(err)
    expect(err.toWire('zh-CN')).toEqual({ code: 'quota', message: '今日免费额度已用完，北京时间早上 8 点（UTC 0 点）恢复' })
    expect(err.toWire('en').message).toBe("Today's free quota is used up. It resets at 00:00 UTC")
  })

  it('translates details that are message keys and keeps raw server text as is', () => {
    expect(new ApiError('bad-response', 'missedItems').text('en')).toBe("Couldn't read the model's reply: The model skipped some paragraphs")
    expect(new ApiError('bad-response', 'missedItems').text('zh-CN')).toBe('模型返回内容无法解析：模型漏译了部分段落')
    expect(new ApiError('bad-request', 'Invalid chat request').text('zh-CN')).toBe('请求被拒绝：Invalid chat request')
  })
})

describe('guessLanguageByScript', () => {
  it('recognises scripts that identify a language and leaves Latin text unknown', () => {
    expect(guessLanguageByScript('これは日本語です')).toBe('ja')
    expect(guessLanguageByScript('한국어 문장입니다')).toBe('ko')
    expect(guessLanguageByScript('这是中文句子 with code')).toBe('zh')
    expect(guessLanguageByScript('Привет, мир')).toBe('ru')
    expect(guessLanguageByScript('Hello world')).toBeNull()
    expect(guessLanguageByScript('123')).toBeNull()
  })
})
