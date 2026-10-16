import { ApiError, toApiError } from '../core/errors'
import { LruCache } from '../core/lru'
import { ConcurrencyPool } from '../core/pool'
import { PROMPT_VERSION } from '../core/prompt'
import { isSuspectTranslation } from '../core/reply'
import { isLikelyInLanguage } from '../core/text-filter'
import { defaultTargetLang, getLanguage, type Language } from '../shared/languages'
import type { ErrorCode } from '../shared/messages'
import { MAX_CONCURRENCY, type Settings } from '../shared/settings'
import { cloudApiConfig, usableModel } from './account'
import { onRateLimited, streamTranslate, type ApiConfig } from './api'
import { PersistentCache } from './persistent-cache'

export { looksTruncated, plainReply } from '../core/reply'

const CACHE_SIZE = 3000
/** The backend refuses longer page titles. */
const MAX_TITLE_CHARS = 200

const pool = new ConcurrencyPool(MAX_CONCURRENCY)
/** Memory first, then IndexedDB, then the network. */
const cache = new LruCache<string, string>(CACHE_SIZE)
const stored = new PersistentCache()

/**
 * Concurrency adapts to rate limits: every 429 halves it, every successful request raises it by
 * one again, never above MAX_CONCURRENCY.
 */
onRateLimited(() => pool.setLimit(Math.max(1, Math.floor(pool.capacity / 2))))

function recoverConcurrency(): void {
  if (pool.capacity < MAX_CONCURRENCY) pool.setLimit(pool.capacity + 1)
}

/** Chat-completions endpoint: the Silk backend, with the chosen model if the plan allows it. */
async function chatConfig(settings: Settings): Promise<ApiConfig> {
  return cloudApiConfig(await usableModel(settings.model))
}

/**
 * Keyed by the model actually called (it differs from the choice while that is locked) and the
 * prompt version, so translations made under an older prompt are not shown after an update.
 */
function cacheKey(model: string, targetLang: string, text: string): string {
  return `${PROMPT_VERSION}\u0001${model}\u0001${targetLang}\u0001${text}`
}

/** Translates `group` (markup strings) and reports each finished item by its index in `group`. */
type GroupTranslator = (group: string[], deliver: (local: number, text: string) => void, signal: AbortSignal) => Promise<void>

function groupTranslator(cfg: ApiConfig, targetLang: string, context: string): GroupTranslator {
  const title = context.slice(0, MAX_TITLE_CHARS)
  return async (group, deliver, signal) => {
    for await (const event of streamTranslate(cfg, { target: targetLang, title, kind: 'page', texts: group }, signal)) {
      if ('index' in event) deliver(event.index, event.text)
    }
  }
}

/** Errors a second attempt cannot fix. */
const FINAL_ERRORS: ReadonlySet<ErrorCode> = new Set(['quota', 'install-limit', 'upgrade', 'model-locked', 'auth', 'bad-request', 'aborted', 'extension'])

export interface BatchOutcome {
  readonly failed: number[]
  readonly error?: ApiError
}

/**
 * Translates `texts` (markup strings) and calls `onItem` as each one completes.
 * Cache hits (memory, then IndexedDB) are delivered first; misses go out as one request. Items
 * still missing afterwards get one more try, unless the error is one a retry cannot fix: when the
 * whole request failed they go out again together, and when the model only skipped a few (or
 * sent ones that look cut off or lost their formatting markers) each goes out on its own.
 */
export async function translateBatch(
  settings: Settings,
  texts: readonly string[],
  context: string,
  onItem: (index: number, text: string) => void,
  signal: AbortSignal,
): Promise<BatchOutcome> {
  const cfg = await chatConfig(settings)
  const translate = groupTranslator(cfg, settings.targetLang, context)
  const keyOf = (text: string) => cacheKey(cfg.model, settings.targetLang, text)
  const results: Array<string | undefined> = texts.map((text) => cache.get(keyOf(text)))
  results.forEach((text, i) => text !== undefined && onItem(i, text))
  const missing = () => results.flatMap((text, i) => (text === undefined ? [i] : []))

  const notInMemory = missing()
  const fromDisk = await stored.getMany(notInMemory.map((i) => keyOf(texts[i])))
  fromDisk.forEach((text, n) => {
    if (text === undefined) return
    const index = notInMemory[n]
    results[index] = text
    cache.set(keyOf(texts[index]), text)
    onItem(index, text)
  })

  /** First-pass translations that looked broken: used only if the retry brings nothing. */
  const suspects = new Map<number, string>()

  const accept = (index: number, text: string, isTrusted = true) => {
    results[index] = text
    cache.set(keyOf(texts[index]), text)
    if (isTrusted) stored.put(keyOf(texts[index]), text)
    onItem(index, text)
  }

  const requestGroup = async (indices: number[], isRetry: boolean) => {
    const deliver = (index: number, text: string) => {
      if (results[index] !== undefined || !text.trim()) return
      if (!isRetry && isSuspectTranslation(texts[index], text)) suspects.set(index, text)
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

  let error: ApiError | undefined
  let requestFailed = false
  try {
    if (missing().length) await requestGroup(missing(), false)
  } catch (err) {
    requestFailed = true
    error = toApiError(err)
    if (FINAL_ERRORS.has(error.code) || signal.aborted) return { failed: missing(), error }
  }

  const retry = missing()
  if (retry.length) {
    // One retry for a failed request; splitting it would multiply the load on a struggling backend.
    const groups = requestFailed ? [retry] : retry.map((i) => [i])
    const outcomes = await Promise.allSettled(groups.map((group) => requestGroup(group, true)))
    const rejected = outcomes.find((o): o is PromiseRejectedResult => o.status === 'rejected')
    if (rejected) error = toApiError(rejected.reason)
  }
  suspects.forEach((text, i) => results[i] === undefined && accept(i, text, false))

  const failed = missing()
  if (!failed.length) return { failed }
  return { failed, error: error ?? new ApiError('bad-response', 'missedItems') }
}

/** Selection popover: if the text is already in the target language, translate the other way. */
export function pickSelectionLanguage(settings: Settings, text: string): Language {
  const target = getLanguage(settings.targetLang)
  if (!isLikelyInLanguage(text, target.code)) return target
  return getLanguage(target.code.startsWith('en') ? defaultTargetLang() : 'en')
}

export async function streamTextTranslation(
  settings: Settings,
  text: string,
  language: Language,
  onDelta: (piece: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const cfg = await chatConfig(settings)
  const job = async () => {
    for await (const event of streamTranslate(cfg, { target: language.code, kind: 'selection', texts: [text] }, signal)) {
      if ('delta' in event) onDelta(event.delta)
    }
  }
  await pool.run(job, { signal, priority: 'high' })
}
