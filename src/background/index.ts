import { MAX_BATCH_ITEMS } from '../core/batching'
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
import { CLOUD_API_URL } from '../shared/service'
import { dropLegacySettings, loadSettings } from '../shared/settings'
import { contentScriptMatches } from '../shared/site-access'
import { handleCommand } from '../shared/tab-messaging'
import { forgetInstallToken, refreshEntitlement } from './account'
import { pickSelectionLanguage, streamTextTranslation, translateBatch } from './translator'

/** Same ceilings as the backend's /v1/translate (and MAX_MARKUP_CHARS in content/unit.ts). */
const MAX_ITEM_CHARS = 6000
const MAX_SELECTION_CHARS = 5000

const CONTENT_SCRIPT_ID = 'silk-content'

/** Re-registers the content script for the origins granted right now (none → not registered). */
async function registerContentScript(): Promise<void> {
  const { origins = [] } = await chrome.permissions.getAll()
  const matches = contentScriptMatches(origins, CLOUD_API_URL)
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] })
  if (registered.length) await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] })
  if (!matches.length) return
  await chrome.scripting.registerContentScripts([
    { id: CONTENT_SCRIPT_ID, matches, js: ['content.js'], runAt: 'document_idle', persistAcrossSessions: true },
  ])
}

/** Serialized: install and permission events can fire together and would race on the same id. */
let syncing: Promise<void> = Promise.resolve()
function syncContentScript(): void {
  syncing = syncing
    .then(registerContentScript)
    .catch((err) => console.error('[silk] failed to register content script', err))
}

chrome.runtime.onInstalled.addListener((details) => {
  // First install only (not updates): how to use the shortcut and where to turn on site access.
  if (details.reason === 'install') void chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') })
  dropLegacySettings().catch((err) => console.error('[silk] failed to migrate settings', err))
  syncContentScript()
})
chrome.permissions.onAdded.addListener(syncContentScript)
chrome.permissions.onRemoved.addListener(syncContentScript)

// The shortcut works on any tab, granted or not: the command itself grants activeTab, so the
// content script can be injected on the spot. Pages no extension may touch just ignore it.
chrome.commands.onCommand.addListener((command, tab) => void handleCommand(command, tab).catch(() => undefined))

async function uiLang(): Promise<UiLang> {
  const settings = await loadSettings().catch(() => null)
  return resolveUiLang(settings?.uiLang ?? 'auto')
}

/**
 * Reacts to backend refusals: a model the cached plan allowed was refused (the plan changed, so
 * fetch it again), or the install token was refused (get a new one with the next request).
 */
function refreshPlanAfter(code: string | undefined): void {
  if (code === 'model-locked') refreshEntitlement().catch((err) => console.error('[silk] failed to refresh plan', err))
  if (code === 'auth') forgetInstallToken().catch((err) => console.error('[silk] failed to reset install token', err))
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
      const language = pickSelectionLanguage(settings, message.text, message.isReversed === true)
      safePost(port, { type: 'meta', targetLabel: language.label, speech: language.speech, lang: language.code })
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
    refreshPlanAfter(error.code)
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
