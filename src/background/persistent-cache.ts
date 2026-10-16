// Translations kept across service-worker restarts and browser sessions, in IndexedDB. A thin
// layer behind the in-memory LRU: every failure (no IndexedDB, quota, private mode) just means a
// miss, never an error for the user.

const DB_NAME = 'silk-translations'
const STORE = 'translations'
const BY_TIME = 'ts'
/** Beyond this many entries the oldest are dropped, down to PRUNE_TO. */
export const MAX_ENTRIES = 50_000
const PRUNE_TO = 45_000
/** Writes between two size checks. */
const PRUNE_EVERY = 500
const FLUSH_DELAY_MS = 200

interface Entry {
  readonly key: string
  readonly text: string
  /** Written at (ms); the oldest entries go first. */
  readonly ts: number
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB unavailable'))
  const req = indexedDB.open(DB_NAME, 1)
  req.onupgradeneeded = () => {
    const store = req.result.createObjectStore(STORE, { keyPath: 'key' })
    store.createIndex(BY_TIME, 'ts')
  }
  return request(req)
}

export class PersistentCache {
  private db: Promise<IDBDatabase | null> | null = null
  private pending = new Map<string, string>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private writesSincePrune = PRUNE_EVERY

  private open(): Promise<IDBDatabase | null> {
    this.db ??= openDb().catch((err) => {
      console.warn('[silk] translation store unavailable', err)
      return null
    })
    return this.db
  }

  /** Stored translations for `keys`, in the same order (undefined for a miss). */
  async getMany(keys: readonly string[]): Promise<Array<string | undefined>> {
    const db = keys.length ? await this.open() : null
    if (!db) return keys.map(() => undefined)
    try {
      const store = db.transaction(STORE, 'readonly').objectStore(STORE)
      const entries = await Promise.all(keys.map((key) => request(store.get(key) as IDBRequest<Entry | undefined>)))
      return entries.map((entry, i) => this.pending.get(keys[i]) ?? entry?.text)
    } catch {
      return keys.map((key) => this.pending.get(key))
    }
  }

  /** Queued and written in one transaction shortly after. */
  put(key: string, text: string): void {
    this.pending.set(key, text)
    this.flushTimer ??= setTimeout(() => void this.flush(), FLUSH_DELAY_MS)
  }

  async flush(): Promise<void> {
    this.flushTimer = null
    const batch = [...this.pending]
    this.pending = new Map()
    const db = batch.length ? await this.open() : null
    if (!db) return
    try {
      const tx = db.transaction(STORE, 'readwrite')
      const store = tx.objectStore(STORE)
      const ts = Date.now()
      batch.forEach(([key, text]) => store.put({ key, text, ts } satisfies Entry))
      await done(tx)
      this.writesSincePrune += batch.length
      if (this.writesSincePrune >= PRUNE_EVERY) await this.prune(db)
    } catch (err) {
      console.warn('[silk] failed to store translations', err)
    }
  }

  /** Drops the oldest entries once there are more than MAX_ENTRIES. */
  private async prune(db: IDBDatabase): Promise<void> {
    this.writesSincePrune = 0
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    let excess = (await request(store.count())) - PRUNE_TO
    if (excess <= MAX_ENTRIES - PRUNE_TO) return
    const cursorReq = store.index(BY_TIME).openCursor()
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result
      if (!cursor || excess-- <= 0) return
      cursor.delete()
      cursor.continue()
    }
    await done(tx)
  }
}
