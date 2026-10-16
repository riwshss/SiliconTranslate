/** Tiny LRU cache on top of Map's insertion order. */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>()

  constructor(private readonly maxSize: number) {}

  get size(): number {
    return this.map.size
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined
    const value = this.map.get(key) as V
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  set(key: K, value: V): void {
    this.map.delete(key)
    this.map.set(key, value)
    if (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value as K
      this.map.delete(oldest)
    }
  }

  clear(): void {
    this.map.clear()
  }
}
