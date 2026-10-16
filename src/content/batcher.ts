import { PORT_BATCH, type BatchEvent, type BatchRequest, type ErrorCode } from '../shared/messages'

const FLUSH_DELAY_MS = 60
const MAX_ITEMS = 12
const MAX_CHARS = 1800

export interface BatcherHooks {
  onResult(key: string, translation: string): void
  onFail(keys: string[], code: ErrorCode, message: string): void
}

/**
 * Collects markup keys for a short window and ships them in size-bounded batches,
 * one runtime Port per batch (closing the port aborts the request in the worker).
 */
export class Batcher {
  private queue: string[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly ports = new Set<chrome.runtime.Port>()

  constructor(
    private readonly hooks: BatcherHooks,
    private readonly getContext: () => string,
  ) {}

  enqueue(key: string): void {
    this.queue = [...this.queue, key]
    this.timer ??= setTimeout(() => this.flush(), FLUSH_DELAY_MS)
  }

  /** Drops queued work and aborts in-flight requests (e.g. target language changed). */
  cancelAll(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.queue = []
    this.ports.forEach((port) => port.disconnect())
    this.ports.clear()
  }

  private flush(): void {
    this.timer = null
    let batch: string[] = []
    let chars = 0
    for (const key of this.queue) {
      if (batch.length && (batch.length >= MAX_ITEMS || chars + key.length > MAX_CHARS)) {
        this.send(batch)
        batch = []
        chars = 0
      }
      batch.push(key)
      chars += key.length
    }
    if (batch.length) this.send(batch)
    this.queue = []
  }

  private send(keys: string[]): void {
    let port: chrome.runtime.Port
    try {
      port = chrome.runtime.connect({ name: PORT_BATCH })
    } catch {
      this.hooks.onFail(keys, 'extension', '扩展已更新或被禁用，请刷新页面')
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
      failRemaining(event.error?.code ?? 'bad-response', event.error?.message ?? '部分段落翻译失败')
      this.ports.delete(port)
      port.disconnect()
    })
    port.onDisconnect.addListener(() => {
      this.ports.delete(port)
      if (!isEnded) failRemaining('network', '与扩展后台的连接中断，请重试')
    })
    const request: BatchRequest = { texts: keys, context: this.getContext() }
    port.postMessage(request)
  }
}
