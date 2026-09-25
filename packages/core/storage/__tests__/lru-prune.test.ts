import { describe, expect, it } from 'vitest'
import { LRUCache } from '../lru-cache.js'

describe('LRUCache.pruneWhere', () => {
  it('drops exactly the entries the predicate names and reports their keys', () => {
    const cache = new LRUCache<string, number>(5)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)
    expect(cache.pruneWhere((_key, value) => value % 2 === 1).sort()).toEqual(['a', 'c'])
    expect(cache.keys()).toEqual(['b'])
  })

  it('hands the predicate the last-access time so callers can judge idleness', () => {
    const cache = new LRUCache<string, number>(5)
    cache.set('x', 1)
    const seen: number[] = []
    cache.pruneWhere((_key, _value, accessedAt) => { seen.push(accessedAt); return false })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBeGreaterThan(0)
    expect(cache.size).toBe(1)
  })
})
