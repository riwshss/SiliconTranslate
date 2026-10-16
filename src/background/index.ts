import { toApiError } from '../core/errors'
import {
  PORT_BATCH,
  PORT_STREAM,
  type AccountRequest,
  type AccountResult,
  type BatchEvent,
  type BatchRequest,
  type StreamEvent,
  type StreamRequest,
  type TestConnectionRequest,
  type TestConnectionResult,
} from '../shared/messages'
import { isChromeAiProvider, loadSettings, onSettingsChanged, sanitizeSettings } from '../shared/settings'
import { refreshEntitlement } from './account'
import { listChatModels, pingModel } from './api'
import { googleTranslate } from './google'
import { pickSelectionLanguage, setConcurrency, streamTextTranslation, translateBatch } from './translator'

const MAX_BATCH_ITEMS = 50
const MAX_ITEM_CHARS = 8000
const MAX_SELECTION_CHARS = 5000

loadSettings()
  .then((s) => setConcurrency(s.maxConcurrency))
  .catch((err) => console.error('[silk] failed to load settings', err))
onSettingsChanged((next, prev) => {
  setConcurrency(next.maxConcurrency)
  // Release on-device models (memory, GPU) once a cloud engine is selected.
  if (isChromeAiProvider(prev.provider) && !isChromeAiProvider(next.provider)) chrome.offscreen?.closeDocument().catch(() => undefined)
})

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
      safePost(port, { type: 'end', failed: [], error: { code: 'bad-request', message: '无效的翻译请求' } })
      return
    }
    try {
      const settings = await loadSettings()
      const outcome = await translateBatch(
        settings,
        message.texts,
        message.context,
        (index, text) => safePost(port, { type: 'item', index, text }),
        signal,
      )
      safePost(port, { type: 'end', failed: outcome.failed, error: outcome.error?.toWire() })
    } catch (err) {
      const failed = message.texts.map((_, i) => i)
      safePost(port, { type: 'end', failed, error: toApiError(err).toWire() })
    }
  })
}

function handleStreamPort(port: chrome.runtime.Port): void {
  const signal = withAbortOnDisconnect(port)
  port.onMessage.addListener(async (message: unknown) => {
    if (!isStreamRequest(message)) {
      safePost(port, { type: 'end', error: { code: 'bad-request', message: '选中的文本为空或过长' } })
      return
    }
    try {
      const settings = await loadSettings()
      const language = pickSelectionLanguage(settings, message.text)
      safePost(port, { type: 'meta', targetLabel: language.label, speech: language.speech })
      await streamTextTranslation(settings, message.text, language, (text) => safePost(port, { type: 'delta', text }), signal)
      safePost(port, { type: 'end' })
    } catch (err) {
      safePost(port, { type: 'end', error: toApiError(err).toWire() })
    }
  })
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.sender?.id !== chrome.runtime.id) return
  if (port.name === PORT_BATCH) handleBatchPort(port)
  else if (port.name === PORT_STREAM) handleStreamPort(port)
})

const TIMEOUT_MESSAGE = '连接超时（20 秒），请检查网络或代理'

async function testConnection(req: TestConnectionRequest): Promise<TestConnectionResult> {
  // Validate with the same rules as stored settings (popup input is untrusted too).
  const settings = sanitizeSettings({ apiKey: req.apiKey, baseUrl: req.baseUrl, model: req.model, googleApiKey: req.apiKey })
  const isGoogle = req.provider === 'google'
  if (!(isGoogle ? settings.googleApiKey : settings.apiKey)) return { ok: false, message: '请先填写 API Key' }
  const cfg = { apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.model }
  const started = performance.now()
  try {
    if (isGoogle) await googleTranslate(settings.googleApiKey, ['Hello'], 'zh-CN', 'text', AbortSignal.timeout(20_000))
    else await pingModel(cfg, AbortSignal.timeout(20_000))
    const latencyMs = Math.round(performance.now() - started)
    const models = isGoogle ? [] : await listChatModels(cfg).catch(() => [])
    return { ok: true, latencyMs, models }
  } catch (err) {
    const error = toApiError(err)
    return { ok: false, message: error.code === 'aborted' ? TIMEOUT_MESSAGE : error.message }
  }
}

async function account(): Promise<AccountResult> {
  const started = performance.now()
  try {
    const entitlement = await refreshEntitlement(AbortSignal.timeout(20_000))
    return { ok: true, latencyMs: Math.round(performance.now() - started), entitlement }
  } catch (err) {
    const error = toApiError(err)
    return { ok: false, message: error.code === 'aborted' ? TIMEOUT_MESSAGE : error.message }
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false
  const req = message as TestConnectionRequest | AccountRequest
  if (req?.type === 'silk:test-connection') testConnection(req).then(sendResponse)
  else if (req?.type === 'silk:account') account().then(sendResponse)
  else return false
  return true
})
