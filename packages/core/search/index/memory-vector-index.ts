/**
 * `MemoryVectorIndex` —— `VectorIndex` 的纯 TS 实现,与 `MemoryIndex` 同一种身份:
 * 单测的替身,也是「换实现不改上层」的活证据。
 *
 * 设计:docs/design/search-index-2026-09.md §15.1
 *
 * 它做的事就是暴力 KNN:遍历全部段算 L2 距离,排序取前 k。真库那一份走
 * `sqlite-vec` 的 `vec0` 虚表(runtime),两边答同一份契约。**范围是查询的输入**
 * (§6.4b):过滤在算距离**之前**做,而不是先取 k 再筛 —— 这一条正是 S1 那个
 * `filter?: (doc) => boolean` 的形状办不到、S7 改掉它的理由。
 */

import type { FacetFilter } from '../candidate.js'
import type { IndexedDoc, VectorHit, VectorIndex, VectorSearchScope } from './types.js'
import { matchesFacetFilters } from './types.js'

export interface MemoryVectorIndexOptions {
  dims: number
  /** 文档表 —— 范围过滤要读 `capability` 与 `facets`。 */
  docs: { get(docId: number): IndexedDoc | undefined }
}

export class MemoryVectorIndex implements VectorIndex {
  readonly dims: number
  private readonly docs: MemoryVectorIndexOptions['docs']
  /** `docId → chunk → 向量`。整份文档一起删,所以按 docId 分层。 */
  private readonly rows = new Map<number, Map<number, Float32Array>>()

  constructor(options: MemoryVectorIndexOptions) {
    this.dims = options.dims
    this.docs = options.docs
  }

  upsert(docId: number, chunk: number, embedding: Float32Array): void {
    if (embedding.length !== this.dims) {
      throw new Error(`embedding has ${embedding.length} dims, index expects ${this.dims}`)
    }
    let byChunk = this.rows.get(docId)
    if (byChunk === undefined) {
      byChunk = new Map()
      this.rows.set(docId, byChunk)
    }
    byChunk.set(chunk, embedding)
  }

  remove(docId: number): void {
    this.rows.delete(docId)
  }

  clear(): void {
    this.rows.clear()
  }

  size(): number {
    let total = 0
    for (const byChunk of this.rows.values()) total += byChunk.size
    return total
  }

  search(embedding: Float32Array, k: number, scope?: VectorSearchScope): VectorHit[] {
    const hits: VectorHit[] = []
    for (const [docId, byChunk] of this.rows) {
      if (!this.inScope(docId, scope)) continue
      for (const [chunk, vector] of byChunk) {
        hits.push({ docId, chunk, distance: l2(embedding, vector) })
      }
    }
    return hits
      .sort((a, b) => (a.distance - b.distance) || (a.docId - b.docId) || (a.chunk - b.chunk))
      .slice(0, k)
  }

  private inScope(docId: number, scope: VectorSearchScope | undefined): boolean {
    if (scope === undefined) return true
    const doc = this.docs.get(docId)
    // 文档没了、向量还在 = 上一代索引的残留。当作不在范围里(而不是当作通过)。
    if (doc === undefined) return false
    if (scope.capability !== undefined && doc.capability !== scope.capability) return false
    const filters: Record<string, FacetFilter> = scope.filters ?? {}
    return matchesFacetFilters(doc.facets, filters)
  }
}

function l2(a: Float32Array, b: Float32Array): number {
  let sum = 0
  for (let i = 0; i < a.length; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    sum += d * d
  }
  return Math.sqrt(sum)
}
