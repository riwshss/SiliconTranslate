import type { Entitlement } from './entitlement'
import type { DisplayMode } from './settings'

export const PORT_BATCH = 'silk:batch'
export const PORT_STREAM = 'silk:stream'

export type ErrorCode =
  | 'quota'
  | 'install-limit'
  | 'upgrade'
  | 'model-locked'
  | 'auth'
  | 'rate-limit'
  | 'bad-request'
  | 'network'
  | 'server'
  | 'bad-response'
  | 'aborted'
  | 'extension'

/** `message` is already in the interface language. */
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
  /** Translate the other way round (the card's switch-direction button). */
  readonly isReversed?: boolean
}

export type StreamEvent =
  | { readonly type: 'meta'; readonly targetLabel: string; readonly speech: string; readonly lang: string }
  | { readonly type: 'delta'; readonly text: string }
  | { readonly type: 'end'; readonly error?: WireError }

/** popup → background: entitlement and today's quota for the Silk AI engine, fetched live. */
export interface AccountRequest {
  readonly type: 'silk:account'
}

export type AccountResult =
  | { readonly ok: true; readonly latencyMs: number; readonly entitlement: Entitlement }
  | { readonly ok: false; readonly message: string }

/** popup / background (keyboard shortcut) → content via tabs.sendMessage */
export type TabMessage =
  | { readonly type: 'silk:get-state' }
  | { readonly type: 'silk:set-mode'; readonly mode: DisplayMode }
  /** The keyboard shortcut: original → default mode → the other mode → original. */
  | { readonly type: 'silk:toggle' }

export interface PageState {
  readonly mode: DisplayMode
  readonly started: boolean
  readonly done: number
  readonly total: number
  readonly failed: number
  readonly error: string | null
}
