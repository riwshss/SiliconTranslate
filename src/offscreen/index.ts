/**
 * Offscreen document: hosts Chrome's built-in AI for the service worker, which cannot reach
 * Translator / LanguageDetector / LanguageModel itself. One PORT_AI connection per request;
 * the worker disconnecting it aborts the work.
 */
import { escapeText, keepsFormattingMarkers, stripMarkup } from '../core/markup'
import { batchPayload, batchSystemPrompt, textSystemPrompt } from '../core/prompt'
import { createObjectStreamParser } from '../core/stream-json'
import { guessLanguageByScript } from '../core/text-filter'
import {
  ChromeAiError,
  createDetector,
  createLanguageModel,
  createTranslator,
  type ChromeLanguageDetector,
  type ChromeLanguageModel,
  type ChromeTranslator,
} from '../shared/chrome-ai'
import { chromeAiLanguage, getLanguage, normalizeDetected } from '../shared/languages'
import { PORT_AI, type AiEvent, type AiRequest, type ErrorCode } from '../shared/messages'

type Emit = (event: Exclude<AiEvent, { type: 'end' }>) => void

const MIN_DETECT_CONFIDENCE = 0.5

// ───────────── shared model instances ─────────────

/** Caches a model promise and forgets it on failure so the next request can retry. */
function memo<T>(cache: Map<string, Promise<T>>, key: string, create: () => Promise<T>): Promise<T> {
  let entry = cache.get(key)
  if (!entry) {
    entry = create()
    cache.set(key, entry)
    entry.catch(() => cache.delete(key))
  }
  return entry
}

const detectors = new Map<string, Promise<ChromeLanguageDetector>>()
const translators = new Map<string, Promise<ChromeTranslator>>()
const nanoSessions = new Map<string, Promise<ChromeLanguageModel>>()

let hasDetector = true

/** Without a detector, Latin-script text is assumed to be English. */
const guessSource = (text: string) => guessLanguageByScript(text) ?? 'en'

/** LanguageDetector when its model is on disk, otherwise a script-based guess (null: unknown). */
async function detect(text: string, signal: AbortSignal): Promise<string | null> {
  if (!hasDetector) return guessSource(text)
  let detector: ChromeLanguageDetector
  try {
    detector = await memo(detectors, '', () => createDetector())
  } catch (err) {
    if (!(err instanceof ChromeAiError)) throw err
    // Unavailable stays unavailable; a pending download is retried on the next request.
    if (err.code === 'unavailable') hasDetector = false
    return guessSource(text)
  }
  const [top] = await detector.detect(text.slice(0, 1000), { signal })
  return top && top.confidence >= MIN_DETECT_CONFIDENCE ? normalizeDetected(top.detectedLanguage) : null
}

function mostCommon(values: Array<string | null>): string | null {
  const counts = new Map<string, number>()
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

const isChinese = (code: string) => code === 'zh' || code === 'zh-Hant'

/** null: nothing to translate (same language, or a Chinese script pair the device cannot convert). */
async function translatorFor(source: string, target: string): Promise<ChromeTranslator | null> {
  if (source === target || (!isChinese(source) && source.split('-')[0] === target.split('-')[0])) return null
  try {
    return await memo(translators, `${source}>${target}`, () => createTranslator({ sourceLanguage: source, targetLanguage: target }))
  } catch (err) {
    if (err instanceof ChromeAiError && err.code === 'unavailable' && isChinese(source) && isChinese(target)) return null
    throw err
  }
}

// ───────────── Translator API ─────────────

/** Tries to keep `<gN>` formatting markers; falls back to plain text (rendered without inline formatting). */
async function translateMarkup(translator: ChromeTranslator, markup: string, plain: string, signal: AbortSignal): Promise<string> {
  if (/<g\d+>/i.test(markup)) {
    const out = await translator.translate(markup, { signal })
    if (keepsFormattingMarkers(markup, out)) return out
  }
  return escapeText(await translator.translate(plain, { signal }))
}

async function translatorBatch(texts: string[], targetLang: string, emit: Emit, signal: AbortSignal): Promise<void> {
  const target = chromeAiLanguage(targetLang)
  const plains = texts.map(stripMarkup)
  const detected: Array<string | null> = []
  for (const plain of plains) detected.push(await detect(plain, signal))
  const fallback = mostCommon(detected) ?? 'en'
  let firstError: unknown = null
  for (const [index, markup] of texts.entries()) {
    try {
      const translator = await translatorFor(detected[index] ?? fallback, target)
      emit({ type: 'item', index, text: translator ? await translateMarkup(translator, markup, plains[index], signal) : markup })
    } catch (err) {
      if (signal.aborted) throw err
      firstError ??= err
    }
  }
  if (firstError) throw firstError
}

async function translatorText(text: string, targetLang: string, emit: Emit, signal: AbortSignal): Promise<void> {
  const target = chromeAiLanguage(targetLang)
  const source = (await detect(text, signal)) ?? (target === 'en' ? 'zh' : 'en')
  const translator = await translatorFor(source, target)
  emit({ type: 'delta', text: translator ? await translator.translate(text, { signal }) : text })
}

// ───────────── Gemini Nano (Prompt API) ─────────────

async function* readStream(stream: ReadableStream<string>): AsyncGenerator<string> {
  const reader = stream.getReader()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      if (value) yield value
    }
  } finally {
    reader.releaseLock()
  }
}

/** A base session per (kind, language) holds the system prompt; each request runs on a clone. */
async function nanoSession(kind: 'batch' | 'text', targetLang: string, signal: AbortSignal): Promise<ChromeLanguageModel> {
  const language = getLanguage(targetLang)
  const system = kind === 'batch' ? batchSystemPrompt(language.prompt, '') : textSystemPrompt(language.prompt)
  const base = await memo(nanoSessions, `${kind}:${language.code}`, () => createLanguageModel(system, chromeAiLanguage(language.code)))
  return base.clone({ signal })
}

function batchSchema(count: number): object {
  const keys = Array.from({ length: count }, (_, i) => String(i))
  return {
    type: 'object',
    properties: Object.fromEntries(keys.map((k) => [k, { type: 'string' }])),
    required: keys,
    additionalProperties: false,
  }
}

async function nanoBatch(texts: string[], targetLang: string, emit: Emit, signal: AbortSignal): Promise<void> {
  const session = await nanoSession('batch', targetLang, signal)
  try {
    const parser = createObjectStreamParser()
    const stream = session.promptStreaming(batchPayload(texts), { signal, responseConstraint: batchSchema(texts.length) })
    const deliver = (pairs: Array<[string, string]>) => pairs.forEach(([key, value]) => emit({ type: 'item', index: Number(key), text: value }))
    for await (const chunk of readStream(stream)) deliver(parser.push(chunk))
    deliver(parser.end())
  } finally {
    session.destroy()
  }
}

async function nanoText(text: string, targetLang: string, emit: Emit, signal: AbortSignal): Promise<void> {
  const session = await nanoSession('text', targetLang, signal)
  try {
    for await (const chunk of readStream(session.promptStreaming(text, { signal }))) emit({ type: 'delta', text: chunk })
  } finally {
    session.destroy()
  }
}

// ───────────── wiring ─────────────

function handle(req: AiRequest, emit: Emit, signal: AbortSignal): Promise<void> {
  if (req.provider === 'chrome-translator') {
    return req.kind === 'batch' ? translatorBatch(req.texts, req.targetLang, emit, signal) : translatorText(req.text, req.targetLang, emit, signal)
  }
  return req.kind === 'batch' ? nanoBatch(req.texts, req.targetLang, emit, signal) : nanoText(req.text, req.targetLang, emit, signal)
}

function toWireError(err: unknown): { code: ErrorCode; detail: string } {
  if (err instanceof ChromeAiError) return { code: err.code, detail: err.message }
  const message = err instanceof Error ? err.message : String(err)
  if (err instanceof DOMException) {
    if (err.name === 'AbortError') return { code: 'aborted', detail: '' }
    if (err.name === 'NotSupportedError') return { code: 'unavailable', detail: message }
    if (err.name === 'NotAllowedError') return { code: 'model-download', detail: message }
    if (err.name === 'QuotaExceededError') return { code: 'bad-request', detail: '文本超出本地模型的上下文长度' }
  }
  return { code: 'bad-response', detail: message.slice(0, 200) }
}

chrome.runtime.onConnect.addListener((port) => {
  // Content-script ports reach every extension frame. Leave them alone: disconnecting one here
  // can close it for good when it arrives before the service worker has woken up.
  if (port.sender?.id !== chrome.runtime.id || port.name !== PORT_AI) return
  const controller = new AbortController()
  port.onDisconnect.addListener(() => controller.abort())
  const post = (event: AiEvent) => {
    try {
      port.postMessage(event)
    } catch {
      // Worker side already gone.
    }
  }
  port.onMessage.addListener((req: AiRequest) => {
    handle(req, post, controller.signal).then(
      () => post({ type: 'end' }),
      (err: unknown) => post({ type: 'end', error: toWireError(err) }),
    )
  })
})
