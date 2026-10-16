import { ApiError } from '../core/errors'
import { PORT_AI, type AiEvent, type AiRequest } from '../shared/messages'

const OFFSCREEN_URL = 'offscreen.html'

let creating: Promise<void> | null = null

/** Chrome's built-in AI APIs only exist in window contexts, so they live in an offscreen document. */
async function ensureOffscreen(): Promise<void> {
  if (!chrome.offscreen) throw new ApiError('unavailable', '当前浏览器不支持 offscreen 文档')
  const url = chrome.runtime.getURL(OFFSCREEN_URL)
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType], documentUrls: [url] })
  if (contexts.length) return
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: ['DOM_PARSER' as chrome.offscreen.Reason],
      justification: "Hosts Chrome's built-in on-device Translator / LanguageDetector / LanguageModel APIs, which are only exposed to window contexts.",
    })
    .finally(() => {
      creating = null
    })
  await creating
}

/** Runs one request in the offscreen document; aborting `signal` disconnects the port, which cancels it there. */
export async function runChromeAi(request: AiRequest, onEvent: (event: Exclude<AiEvent, { type: 'end' }>) => void, signal: AbortSignal): Promise<void> {
  await ensureOffscreen()
  if (signal.aborted) throw new ApiError('aborted')
  await new Promise<void>((resolve, reject) => {
    const port = chrome.runtime.connect({ name: PORT_AI })
    let isEnded = false
    const finish = (error?: ApiError) => {
      if (isEnded) return
      isEnded = true
      signal.removeEventListener('abort', onAbort)
      port.disconnect()
      if (error) reject(error)
      else resolve()
    }
    const onAbort = () => finish(new ApiError('aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    port.onMessage.addListener((event: AiEvent) => {
      if (event.type !== 'end') onEvent(event)
      else finish(event.error ? new ApiError(event.error.code, event.error.detail) : undefined)
    })
    port.onDisconnect.addListener(() => finish(new ApiError('unavailable', '本地模型进程已断开')))
    port.postMessage(request)
  })
}
