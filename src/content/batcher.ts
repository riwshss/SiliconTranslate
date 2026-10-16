import { splitBatches } from '../core/batching'
import type { Translate } from '../shared/i18n'
import { PORT_BATCH, type BatchEvent, type BatchRequest, type ErrorCode } from '../shared/messages'
import { MAX_CONCURRENCY } from '../shared/settings'
import { LocalTranslator, pickPageEngine } from './local-translator'

const FLUSH_DELAY_MS = 60
/** The on-device model runs one translation at a time anyway. */
const LOCAL_CONCURRENCY = 2

export interface BatcherHooks {
  onResult(key: string, translation: string): void
  onFail(keys: string[], code: ErrorCode, message: string): void
}

/**
 * Collects markup keys for a short window and ships them in size-bounded batches,
 * one runtime Port per batch (closing the port aborts the request in the worker).
 * Visible keys go out first, spread over every connection and led by a tiny batch, so the screen
 * the user is looking at fills in before the prefetched area below it.
 */
export class Batcher {
  private urgent: string[] = []
  private queue: string[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly ports = new Set<chrome.runtime.Port>()
  /** Aborts on-device translations in flight. */
  private localAbort = new AbortController()
  private local: LocalTranslator | null = null

  constructor(
    private readonly hooks: BatcherHooks,
    private readonly getContext: () => string,
    private readonly getT: () => Translate,
    private readonly getTargetLang: () => string,
  ) {}

  /** `isVisible`: on screen now (sent first), as opposed to prefetched ahead of scrolling. */
  enqueue(key: string, isVisible = false): void {
    if (isVisible) this.urgent = [...this.urgent, key]
    else this.queue = [...this.queue, key]
    this.timer ??= setTimeout(() => this.flush(), FLUSH_DELAY_MS)
  }

  /** Drops queued work and aborts in-flight requests (e.g. target language changed). */
  cancelAll(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.urgent = []
    this.queue = []
    this.ports.forEach((port) => port.disconnect())
    this.ports.clear()
    this.localAbort.abort()
    this.localAbort = new AbortController()
    this.local = null
  }

  private flush(): void {
    this.timer = null
    if (!this.urgent.length && !this.queue.length) return
    // Visible keys lead with a tiny batch, so the first translation shows up as soon as possible.
    const batches = [...splitBatches(this.urgent, MAX_CONCURRENCY, true), ...splitBatches(this.queue, MAX_CONCURRENCY)]
    this.urgent = []
    this.queue = []
    const signal = this.localAbort.signal
    pickPageEngine()
      .catch(() => 'cloud' as const)
      .then((engine) => {
        if (signal.aborted) return
        if (engine === 'local') this.translateLocally(batches.flat(), signal)
        else batches.forEach((batch) => this.send(batch))
      })
  }

  /**
   * On-device translation (plans without cloud AI). A key the browser cannot translate on device
   * (unsupported language pair, model failure) goes to the cloud engine instead.
   */
  private translateLocally(keys: string[], signal: AbortSignal): void {
    this.local ??= new LocalTranslator(this.getTargetLang())
    const local = this.local
    const queue = [...keys]
    const toCloud: string[] = []
    const worker = async () => {
      for (let key = queue.shift(); key !== undefined && !signal.aborted; key = queue.shift()) {
        const translation = await local.translate(key, signal).catch(() => null)
        if (signal.aborted) return
        if (translation?.trim()) this.hooks.onResult(key, translation)
        else toCloud.push(key)
      }
    }
    Promise.all(Array.from({ length: LOCAL_CONCURRENCY }, worker)).then(() => {
      if (!signal.aborted && toCloud.length) splitBatches(toCloud, MAX_CONCURRENCY).forEach((batch) => this.send(batch))
    })
  }

  private send(keys: string[]): void {
    let port: chrome.runtime.Port
    try {
      port = chrome.runtime.connect({ name: PORT_BATCH })
    } catch {
      this.hooks.onFail(keys, 'extension', this.getT()('extensionGone'))
      return
    }
    this.ports.add(port)
    const pending = new Set(keys.map((_, i) => i))
    let isEnded = false
    const failRemaining = (code: ErrorCode, message: string) => {
      const failed = [...pending].map((i) => keys[i])
      pending.clear()
      if (failed.length) this.hooks.onFail(failed, code, message)
    }

    port.onMessage.addListener((event: BatchEvent) => {
      if (event.type === 'item') {
        if (!pending.delete(event.index)) return
        this.hooks.onResult(keys[event.index], event.text)
        return
      }
      isEnded = true
      failRemaining(event.error?.code ?? 'bad-response', event.error?.message ?? this.getT()('partialFail'))
      this.ports.delete(port)
      port.disconnect()
    })
    port.onDisconnect.addListener(() => {
      this.ports.delete(port)
      if (!isEnded) failRemaining('network', this.getT()('portLost'))
    })
    const request: BatchRequest = { texts: keys, context: this.getContext() }
    port.postMessage(request)
  }
}
