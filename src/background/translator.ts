import { ApiError, toApiError } from '../core/errors'
import { LruCache } from '../core/lru'
import { fromGoogleHtml, stripMarkup, toGoogleHtml } from '../core/markup'
import { ConcurrencyPool } from '../core/pool'
import { buildBatchMessages, buildTextMessages } from '../core/prompt'
import { createObjectStreamParser } from '../core/stream-json'
import { isLikelyInLanguage } from '../core/text-filter'
import { getLanguage, type Language } from '../shared/languages'
import type { ErrorCode } from '../shared/messages'
import { engineId, isChromeAiProvider, type Settings } from '../shared/settings'
import { assertCanUse, cloudApiConfig } from './account'
import { onRateLimited, streamChat, type ApiConfig } from './api'
import { runChromeAi } from './chrome-ai'
import { googleTranslate } from './google'

const CACHE_SIZE = 3000

const pool = new ConcurrencyPool(4)
const cache = new LruCache<string, string>(CACHE_SIZE)

/**
 * Concurrency adapts to rate limits: every 429 halves it, every successful request raises it by
 * one again, never above the user's setting.
 */
let configuredConcurrency = 4

export function setConcurrency(limit: number): void {
  configuredConcurrency = limit
  pool.setLimit(limit)
}

onRateLimited(() => pool.setLimit(Math.max(1, Math.floor(pool.capacity / 2))))

function recoverConcurrency(): void {
  if (pool.capacity < configuredConcurrency) pool.setLimit(pool.capacity + 1)
}

/** Chat-completions endpoint for the LLM engines: the Silk backend (`cloud`) or the user's own. */
async function chatConfig(settings: Settings): Promise<ApiConfig> {
  if (settings.provider === 'cloud') {
    await assertCanUse('cloud')
    return cloudApiConfig()
  }
  if (!settings.apiKey) throw new ApiError('no-key')
  return { apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.model }
}

function googleKey(settings: Settings): string {
  if (!settings.googleApiKey) throw new ApiError('no-key')
  return settings.googleApiKey
}

function cacheKey(settings: Settings, text: string): string {
  return `${engineId(settings)}\u0001${settings.targetLang}\u0001${text}`
}

/**
 * A reply to a single-item request that is plain text instead of JSON (small models do that):
 * the text itself is the translation. Null when it looks like JSON the parser could not read.
 */
export function plainReply(reply: string): string | null {
  const text = reply
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/^\s*```[a-z]*\s*|\s*```\s*$/gi, '')
    .trim()
  return text && !/^[{[]/.test(text) ? text : null
}

/** Translates `group` (markup strings) and reports each finished item by its index in `group`. */
type GroupTranslator = (group: string[], deliver: (local: number, text: string) => void, signal: AbortSignal) => Promise<void>

async function groupTranslator(settings: Settings, context: string): Promise<GroupTranslator> {
  const { provider } = settings
  if (provider === 'google') {
    const key = googleKey(settings)
    return async (group, deliver, signal) => {
      const out = await googleTranslate(key, group.map(toGoogleHtml), settings.targetLang, 'html', signal)
      out.forEach((text, i) => deliver(i, fromGoogleHtml(text)))
    }
  }
  if (isChromeAiProvider(provider)) {
    return (group, deliver, signal) =>
      runChromeAi({ kind: 'batch', provider, texts: group, targetLang: settings.targetLang }, (event) => event.type === 'item' && deliver(event.index, event.text), signal)
  }
  const cfg = await chatConfig(settings)
  const language = getLanguage(settings.targetLang).prompt
  return async (group, deliver, signal) => {
    const parser = createObjectStreamParser()
    let reply = ''
    let isParsed = false
    const take = (pairs: Array<[string, string]>) =>
      pairs.forEach(([key, value]) => {
        isParsed = true
        deliver(Number(key), value)
      })
    for await (const delta of streamChat(cfg, buildBatchMessages(group, language, context), { signal })) {
      reply += delta
      take(parser.push(delta))
    }
    take(parser.end())
    const plain = !isParsed && group.length === 1 ? plainReply(reply) : null
    if (plain) deliver(0, plain)
  }
}

/** Errors a second attempt cannot fix. */
const FINAL_ERRORS: ReadonlySet<ErrorCode> = new Set(['no-key', 'quota', 'upgrade', 'auth', 'bad-request', 'unavailable', 'model-download', 'aborted', 'extension'])

const SUSPECT_MIN_SOURCE = 40
const SUSPECT_RATIO = 0.1

/** A translation far shorter than its source was most likely cut off (e.g. at a stray quote). */
export function looksTruncated(source: string, translation: string): boolean {
  const src = stripMarkup(source).trim().length
  return src >= SUSPECT_MIN_SOURCE && stripMarkup(translation).trim().length < src * SUSPECT_RATIO
}

export interface BatchOutcome {
  readonly failed: number[]
  readonly error?: ApiError
}

/**
 * Translates `texts` (markup strings) and calls `onItem` as each one completes.
 * Cache hits are delivered first; misses go out as one request. Every item that is still
 * missing afterwards (skipped by the model, unreadable reply, or a failed request) gets one
 * more try on its own, unless the error is one a retry cannot fix.
 */
export async function translateBatch(
  settings: Settings,
  texts: readonly string[],
  context: string,
  onItem: (index: number, text: string) => void,
  signal: AbortSignal,
): Promise<BatchOutcome> {
  const translate = await groupTranslator(settings, context)
  const checkLength = !['google', 'chrome-translator'].includes(settings.provider)
  const results: Array<string | undefined> = texts.map((text) => cache.get(cacheKey(settings, text)))
  results.forEach((text, i) => text !== undefined && onItem(i, text))
  /** First-pass translations that looked truncated: used only if the retry brings nothing. */
  const suspects = new Map<number, string>()

  const accept = (index: number, text: string) => {
    results[index] = text
    cache.set(cacheKey(settings, texts[index]), text)
    onItem(index, text)
  }

  const requestGroup = async (indices: number[], isRetry: boolean) => {
    const deliver = (index: number, text: string) => {
      if (results[index] !== undefined || !text.trim()) return
      if (!isRetry && checkLength && looksTruncated(texts[index], text)) suspects.set(index, text)
      else accept(index, text)
    }
    await pool.run(
      () =>
        translate(
          indices.map((i) => texts[i]),
          (local, text) => Number.isInteger(local) && local >= 0 && local < indices.length && deliver(indices[local], text),
          signal,
        ),
      { signal },
    )
    recoverConcurrency()
  }

  const missing = () => results.flatMap((text, i) => (text === undefined ? [i] : []))
  let error: ApiError | undefined
  try {
    if (missing().length) await requestGroup(missing(), false)
  } catch (err) {
    error = toApiError(err)
    if (FINAL_ERRORS.has(error.code) || signal.aborted) return { failed: missing(), error }
  }

  const retry = missing()
  if (retry.length) {
    const outcomes = await Promise.allSettled(retry.map((i) => requestGroup([i], true)))
    const rejected = outcomes.find((o): o is PromiseRejectedResult => o.status === 'rejected')
    if (rejected) error = toApiError(rejected.reason)
  }
  suspects.forEach((text, i) => results[i] === undefined && accept(i, text))

  const failed = missing()
  if (!failed.length) return { failed }
  return { failed, error: error ?? new ApiError('bad-response', '模型漏译了部分段落') }
}

/** Selection popover: if the text is already in the target language, translate the other way. */
export function pickSelectionLanguage(settings: Settings, text: string): Language {
  const target = getLanguage(settings.targetLang)
  if (!isLikelyInLanguage(text, target.code)) return target
  return getLanguage(target.code.startsWith('en') ? 'zh-CN' : 'en')
}

export async function streamTextTranslation(
  settings: Settings,
  text: string,
  language: Language,
  onDelta: (piece: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const { provider } = settings
  let job: () => Promise<void>
  if (provider === 'google') {
    const key = googleKey(settings)
    job = async () => onDelta((await googleTranslate(key, [text], language.code, 'text', signal))[0])
  } else if (isChromeAiProvider(provider)) {
    job = () => runChromeAi({ kind: 'text', provider, text, targetLang: language.code }, (event) => event.type === 'delta' && onDelta(event.text), signal)
  } else {
    const cfg = await chatConfig(settings)
    job = async () => {
      for await (const delta of streamChat(cfg, buildTextMessages(text, language.prompt), { signal })) onDelta(delta)
    }
  }
  await pool.run(job, { signal, priority: 'high' })
}
