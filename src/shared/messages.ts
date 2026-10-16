import type { Entitlement } from './entitlement'
import type { DisplayMode, Provider } from './settings'

export const PORT_BATCH = 'silk:batch'
export const PORT_STREAM = 'silk:stream'
/** background → offscreen document (Chrome built-in AI). */
export const PORT_AI = 'silk:ai'

export type ErrorCode =
  | 'no-key'
  | 'quota'
  | 'upgrade'
  | 'unavailable'
  | 'model-download'
  | 'auth'
  | 'rate-limit'
  | 'bad-request'
  | 'network'
  | 'server'
  | 'bad-response'
  | 'aborted'
  | 'extension'

export interface WireError {
  readonly code: ErrorCode
  readonly message: string
}

/** content → background over PORT_BATCH. `texts` are serialized markup strings. */
export interface BatchRequest {
  readonly texts: string[]
  readonly context: string
}

export type BatchEvent =
  | { readonly type: 'item'; readonly index: number; readonly text: string }
  | { readonly type: 'end'; readonly failed: number[]; readonly error?: WireError }

/** content → background over PORT_STREAM (selection popover). */
export interface StreamRequest {
  readonly text: string
}

export type StreamEvent =
  | { readonly type: 'meta'; readonly targetLabel: string; readonly speech: string }
  | { readonly type: 'delta'; readonly text: string }
  | { readonly type: 'end'; readonly error?: WireError }

/**
 * background → offscreen over PORT_AI. `batch` texts are markup strings (results must be markup
 * too); `text` is a plain selection. `targetLang` is a LANGUAGES code.
 */
export type AiRequest =
  | { readonly kind: 'batch'; readonly provider: 'chrome-translator' | 'chrome-nano'; readonly texts: string[]; readonly targetLang: string }
  | { readonly kind: 'text'; readonly provider: 'chrome-translator' | 'chrome-nano'; readonly text: string; readonly targetLang: string }

export type AiEvent =
  | { readonly type: 'item'; readonly index: number; readonly text: string }
  | { readonly type: 'delta'; readonly text: string }
  | { readonly type: 'end'; readonly error?: { readonly code: ErrorCode; readonly detail: string } }

/** popup → background via runtime.sendMessage (OpenAI-compatible or Google; Chrome AI is checked in the popup). */
export interface TestConnectionRequest {
  readonly type: 'silk:test-connection'
  readonly provider: Extract<Provider, 'openai' | 'google'>
  readonly apiKey: string
  readonly baseUrl: string
  readonly model: string
}

export type TestConnectionResult =
  | { readonly ok: true; readonly latencyMs: number; readonly models: string[] }
  | { readonly ok: false; readonly message: string }

/** popup → background: entitlement and today's quota for the Silk AI engine, fetched live. */
export interface AccountRequest {
  readonly type: 'silk:account'
}

export type AccountResult =
  | { readonly ok: true; readonly latencyMs: number; readonly entitlement: Entitlement }
  | { readonly ok: false; readonly message: string }

/** popup → content via tabs.sendMessage */
export type TabMessage =
  | { readonly type: 'silk:get-state' }
  | { readonly type: 'silk:set-mode'; readonly mode: DisplayMode }

export interface PageState {
  readonly mode: DisplayMode
  readonly started: boolean
  readonly done: number
  readonly total: number
  readonly failed: number
  readonly error: string | null
}
