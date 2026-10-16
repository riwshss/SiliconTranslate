import { beforeAll, describe, expect, it } from 'vitest'
import { PORT_AI, type AiEvent, type AiRequest } from '../src/shared/messages'

// ───────────── fakes for chrome.runtime and Chrome's built-in AI ─────────────

type Listener = (...args: unknown[]) => void
let onConnect: Listener = () => undefined

/** How the fake Translator behaves; read at call time so cached instances follow it. */
const fake = {
  dropMarkers: false,
  unavailablePairs: new Set<string>(),
  downloadablePairs: new Set<string>(),
  nanoReply: [] as string[],
  signals: [] as AbortSignal[],
}

const g = globalThis as Record<string, unknown>
g.chrome = { runtime: { id: 'ext', onConnect: { addListener: (fn: Listener) => (onConnect = fn) } } }
g.LanguageDetector = { availability: async () => 'unavailable', create: async () => Promise.reject(new Error('no detector')) }
g.Translator = {
  availability: async ({ sourceLanguage, targetLanguage }: { sourceLanguage: string; targetLanguage: string }) => {
    const pair = `${sourceLanguage}>${targetLanguage}`
    if (fake.unavailablePairs.has(pair)) return 'unavailable'
    return fake.downloadablePairs.has(pair) ? 'downloadable' : 'available'
  },
  create: async ({ sourceLanguage, targetLanguage }: { sourceLanguage: string; targetLanguage: string }) => {
    if (fake.downloadablePairs.has(`${sourceLanguage}>${targetLanguage}`)) throw new DOMException('needs activation', 'NotAllowedError')
    return {
      translate: async (text: string, options?: { signal?: AbortSignal }) => {
        if (options?.signal) fake.signals.push(options.signal)
        const out = `[${sourceLanguage}→${targetLanguage}]${text}`
        return fake.dropMarkers ? out.replace(/<\/?g\d+>/g, '') : out
      },
      destroy: () => undefined,
    }
  },
}
const nanoCalls: Array<{ input: string; schema: unknown }> = []
let nanoCreateOptions: Record<string, unknown> | null = null
const nanoSession = {
  clone: async () => nanoSession,
  destroy: () => undefined,
  prompt: async () => '',
  promptStreaming: (input: string, options?: { responseConstraint?: unknown }) => {
    nanoCalls.push({ input, schema: options?.responseConstraint })
    const chunks = [...fake.nanoReply]
    return new ReadableStream<string>({
      pull(controller) {
        const next = chunks.shift()
        if (next === undefined) controller.close()
        else controller.enqueue(next)
      },
    })
  },
}
g.LanguageModel = {
  availability: async () => 'available',
  create: async (options: Record<string, unknown>) => {
    nanoCreateOptions = options
    return nanoSession
  },
}

interface Run {
  events: AiEvent[]
  done: Promise<AiEvent[]>
  disconnect: () => void
}

function run(request: AiRequest): Run {
  const events: AiEvent[] = []
  let onMessage: Listener = () => undefined
  let onDisconnect: Listener = () => undefined
  let finish: (events: AiEvent[]) => void = () => undefined
  const done = new Promise<AiEvent[]>((resolve) => (finish = resolve))
  onConnect({
    name: PORT_AI,
    sender: { id: 'ext' },
    onMessage: { addListener: (fn: Listener) => (onMessage = fn) },
    onDisconnect: { addListener: (fn: Listener) => (onDisconnect = fn) },
    postMessage: (event: AiEvent) => {
      events.push(event)
      if (event.type === 'end') finish(events)
    },
  })
  onMessage(request)
  return { events, done, disconnect: () => onDisconnect() }
}

const items = (events: AiEvent[]) =>
  Object.fromEntries(events.flatMap((e) => (e.type === 'item' ? [[e.index, e.text] as const] : [])))
const end = (events: AiEvent[]) => events.find((e) => e.type === 'end')

beforeAll(async () => {
  await import('../src/offscreen/index')
})

// ───────────── tests ─────────────

describe('offscreen · Chrome Translator', () => {
  it('guesses the source per item without a detector, keeps markers, and skips text already in the target', async () => {
    const events = await run({
      kind: 'batch',
      provider: 'chrome-translator',
      texts: ['Read <g0>the guide</g0> &amp; more', 'これは日本語です', '这是中文'],
      targetLang: 'zh-CN',
    }).done
    expect(items(events)).toEqual({
      0: '[en→zh]Read <g0>the guide</g0> &amp; more',
      1: '[ja→zh]これは日本語です',
      2: '这是中文',
    })
    expect(end(events)).toEqual({ type: 'end' })
  })

  it('falls back to plain text (re-escaped as markup) when the model drops formatting markers', async () => {
    fake.dropMarkers = true
    try {
      const events = await run({ kind: 'batch', provider: 'chrome-translator', texts: ['a < b <g0>link</g0>'], targetLang: 'zh-CN' }).done
      expect(items(events)).toEqual({ 0: '[en→zh]a &lt; b link' })
    } finally {
      fake.dropMarkers = false
    }
  })

  it('leaves Chinese untouched when the device cannot convert between scripts', async () => {
    fake.unavailablePairs.add('zh>zh-Hant')
    const events = await run({ kind: 'batch', provider: 'chrome-translator', texts: ['这是中文'], targetLang: 'zh-TW' }).done
    expect(items(events)).toEqual({ 0: '这是中文' })
    expect(end(events)).toEqual({ type: 'end' })
  })

  it('reports a model that still needs a user-gesture download as model-download', async () => {
    fake.downloadablePairs.add('en>de')
    const events = await run({ kind: 'batch', provider: 'chrome-translator', texts: ['Hello there'], targetLang: 'de' }).done
    expect(items(events)).toEqual({})
    expect(end(events)).toMatchObject({ type: 'end', error: { code: 'model-download' } })
  })

  it('translates a selection as one delta and aborts work when the port disconnects', async () => {
    const job = run({ kind: 'text', provider: 'chrome-translator', text: 'Hello world', targetLang: 'ja' })
    const events = await job.done
    expect(events).toEqual([{ type: 'delta', text: '[en→ja]Hello world' }, { type: 'end' }])
    job.disconnect()
    expect(fake.signals.at(-1)?.aborted).toBe(true)
  })
})

describe('offscreen · Gemini Nano', () => {
  it('streams a JSON-constrained batch and emits items as each value completes', async () => {
    fake.nanoReply = ['{"0":"你', '好","1', '":"世界"}']
    const events = await run({ kind: 'batch', provider: 'chrome-nano', texts: ['Hello', 'world'], targetLang: 'zh-CN' }).done
    expect(items(events)).toEqual({ 0: '你好', 1: '世界' })
    expect(JSON.parse(nanoCalls.at(-1)!.input)).toEqual({ 0: 'Hello', 1: 'world' })
    expect(nanoCalls.at(-1)!.schema).toMatchObject({ required: ['0', '1'], additionalProperties: false })
    // zh is not an officially supported Nano output language: no expectedOutputs then.
    expect(nanoCreateOptions).not.toHaveProperty('expectedOutputs')
  })

  it('declares the output language when Nano supports it', async () => {
    fake.nanoReply = ['Hallo']
    const events = await run({ kind: 'text', provider: 'chrome-nano', text: 'Hello', targetLang: 'de' }).done
    expect(events).toEqual([{ type: 'delta', text: 'Hallo' }, { type: 'end' }])
    expect(nanoCreateOptions).toMatchObject({ expectedOutputs: [{ type: 'text', languages: ['de'] }] })
  })
})
