/**
 * Generic least-recently-used cache.
 */
export class LRUCache<K, V> {
  private cache = new Map<K, { value: V; accessedAt: number }>()

  constructor(private readonly maxSize: number = 5) {}

  get(key: K): V | undefined {
    const entry = this.cache.get(key)
    if (!entry) return undefined

    entry.accessedAt = Date.now()
    return entry.value
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.set(key, { value, accessedAt: Date.now() })
      return
    }

    if (this.cache.size >= this.maxSize) {
      this.evictOldest()
    }

    this.cache.set(key, { value, accessedAt: Date.now() })
  }

  has(key: K): boolean {
    return this.cache.has(key)
  }

  delete(key: K): boolean {
    return this.cache.delete(key)
  }

  clear(): void {
    this.cache.clear()
  }

  get size(): number {
    return this.cache.size
  }

  keys(): K[] {
    return Array.from(this.cache.keys())
  }

  /**
   * 按条件挤掉若干条,交回挤掉的键。给内存调度器用:「空闲且不受保护的」
   * 由调用方说,这里只负责遍历与删除(`accessedAt` 是这一条最后一次被 get/set 的时刻)。
   */
  pruneWhere(predicate: (key: K, value: V, accessedAt: number) => boolean): K[] {
    const pruned: K[] = []
    for (const [key, entry] of [...this.cache]) {
      if (!predicate(key, entry.value, entry.accessedAt)) continue
      this.cache.delete(key)
      pruned.push(key)
    }
    return pruned
  }

  getStats(): { size: number; maxSize: number; keys: K[] } {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      keys: this.keys(),
    }
  }

  private evictOldest(): void {
    let oldestKey: K | null = null
    let oldestTime = Infinity

    for (const [key, entry] of this.cache) {
      if (entry.accessedAt < oldestTime) {
        oldestTime = entry.accessedAt
        oldestKey = key
      }
    }

    if (oldestKey !== null) {
      this.cache.delete(oldestKey)
    }
  }
}
