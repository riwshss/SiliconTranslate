interface QueuedTask {
  start: () => void
  signal?: AbortSignal
}

export interface RunOptions {
  signal?: AbortSignal
  /** High-priority tasks (e.g. selection popover) jump the queue. */
  priority?: 'normal' | 'high'
}

/** Limits how many async tasks run at once; protects the API from 429 bursts. */
export class ConcurrencyPool {
  private active = 0
  private queue: QueuedTask[] = []

  constructor(private limit: number) {}

  get running(): number {
    return this.active
  }

  get pending(): number {
    return this.queue.length
  }

  get capacity(): number {
    return this.limit
  }

  setLimit(limit: number): void {
    this.limit = Math.max(1, limit)
    this.drain()
  }

  run<T>(task: () => Promise<T>, options: RunOptions = {}): Promise<T> {
    const { signal, priority = 'normal' } = options
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }
      const entry: QueuedTask = {
        signal,
        start: () => {
          this.active++
          task()
            .then(resolve, reject)
            .finally(() => {
              this.active--
              this.drain()
            })
        },
      }
      signal?.addEventListener(
        'abort',
        () => {
          const index = this.queue.indexOf(entry)
          if (index < 0) return
          this.queue = this.queue.filter((queued) => queued !== entry)
          reject(new DOMException('Aborted', 'AbortError'))
        },
        { once: true },
      )
      this.queue = priority === 'high' ? [entry, ...this.queue] : [...this.queue, entry]
      this.drain()
    })
  }

  private drain(): void {
    while (this.active < this.limit && this.queue.length > 0) {
      const [next, ...rest] = this.queue
      this.queue = rest
      if (!next.signal?.aborted) next.start()
    }
  }
}
