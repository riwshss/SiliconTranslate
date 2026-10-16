import { toApiError } from '../core/errors'
import { resolveUiLang, translator, type UiLang } from '../shared/i18n'
import {
  PORT_BATCH,
  PORT_STREAM,
  type AccountRequest,
  type AccountResult,
  type BatchEvent,
  type BatchRequest,
  type StreamEvent,
  type StreamRequest,
} from '../shared/messages'
import { dropLegacySettings, loadSettings, onSettingsChanged } from '../shared/settings'
import { refreshEntitlement } from './account'
import { pickSelectionLanguage, setConcurrency, streamTextTranslation, translateBatch } from './translator'

const MAX_BATCH_ITEMS = 50
const MAX_ITEM_CHARS = 8000
const MAX_SELECTION_CHARS = 5000

loadSettings()
  .then((s) => setConcurrency(s.maxConcurrency))
  .catch((err) => console.error('[silk] failed to load settings', err))
onSettingsChanged((next) => setConcurrency(next.maxConcurrency))

chrome.runtime.onInstalled.addListener(() => {
  dropLegacySettings().catch((err) => console.error('[silk] failed to migrate settings', err))
})

async function uiLang(): Promise<UiLang> {
  const settings = await loadSettings().catch(() => null)
  return resolveUiLang(settings?.uiLang ?? 'auto')
}

/** The backend refused a model the cached plan allowed: the plan changed, so fetch it again. */
function refreshPlanAfter(code: string | undefined): void {
  if (code === 'model-locked') refreshEntitlement().catch((err) => console.error('[silk] failed to refresh plan', err))
}

function safePost(port: chrome.runtime.Port, message: BatchEvent | StreamEvent): void {
  try {
    port.postMessage(message)
  } catch {
    // Port closed (tab navigated away) — nothing left to deliver to.
  }
}

function isBatchRequest(value: unknown): value is BatchRequest {
  const req = value as BatchRequest
  return (
    !!req &&
    Array.isArray(req.texts) &&
    req.texts.length > 0 &&
    req.texts.length <= MAX_BATCH_ITEMS &&
    req.texts.every((t) => typeof t === 'string' && t.length > 0 && t.length <= MAX_ITEM_CHARS) &&
    typeof req.context === 'string'
  )
}

function isStreamRequest(value: unknown): value is StreamRequest {
  const req = value as StreamRequest
  return !!req && typeof req.text === 'string' && req.text.trim().length > 0 && req.text.length <= MAX_SELECTION_CHARS
}

/** One port per request: disconnecting (navigation, tab close) aborts the HTTP stream. */
function withAbortOnDisconnect(port: chrome.runtime.Port): AbortSignal {
  const controller = new AbortController()
  port.onDisconnect.addListener(() => controller.abort())
  return controller.signal
}

function handleBatchPort(port: chrome.runtime.Port): void {
  const signal = withAbortOnDisconnect(port)
  port.onMessage.addListener(async (message: unknown) => {
    if (!isBatchRequest(message)) {
      safePost(port, { type: 'end', failed: [], error: { code: 'bad-request', message: translator(await uiLang())('invalidBatch') } })
      return
    }
    const lang = await uiLang()
    try {
      const settings = await loadSettings()
      const outcome = await translateBatch(
        settings,
        message.texts,
        message.context,
        (index, text) => safePost(port, { type: 'item', index, text }),
        signal,
      )
      refreshPlanAfter(outcome.error?.code)
      safePost(port, { type: 'end', failed: outcome.failed, error: outcome.error?.toWire(lang) })
    } catch (err) {
      const failed = message.texts.map((_, i) => i)
      const error = toApiError(err)
      refreshPlanAfter(error.code)
      safePost(port, { type: 'end', failed, error: error.toWire(lang) })
    }
  })
}

function handleStreamPort(port: chrome.runtime.Port): void {
  const signal = withAbortOnDisconnect(port)
  port.onMessage.addListener(async (message: unknown) => {
    if (!isStreamRequest(message)) {
      safePost(port, { type: 'end', error: { code: 'bad-request', message: translator(await uiLang())('invalidSelection') } })
      return
    }
    const lang = await uiLang()
    try {
      const settings = await loadSettings()
      const language = pickSelectionLanguage(settings, message.text)
      safePost(port, { type: 'meta', targetLabel: language.label, speech: language.speech })
      await streamTextTranslation(settings, message.text, language, (text) => safePost(port, { type: 'delta', text }), signal)
      safePost(port, { type: 'end' })
    } catch (err) {
      const error = toApiError(err)
      refreshPlanAfter(error.code)
      safePost(port, { type: 'end', error: error.toWire(lang) })
    }
  })
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.sender?.id !== chrome.runtime.id) return
  if (port.name === PORT_BATCH) handleBatchPort(port)
  else if (port.name === PORT_STREAM) handleStreamPort(port)
})

async function account(): Promise<AccountResult> {
  const started = performance.now()
  try {
    const entitlement = await refreshEntitlement(AbortSignal.timeout(20_000))
    return { ok: true, latencyMs: Math.round(performance.now() - started), entitlement }
  } catch (err) {
    const error = toApiError(err)
    const lang = await uiLang()
    return { ok: false, message: error.code === 'aborted' ? translator(lang)('timeout') : error.text(lang) }
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false
  if ((message as AccountRequest)?.type !== 'silk:account') return false
  account().then(sendResponse)
  return true
})
