/**
 * 单测里的索引替身(检索重建 S3b)。
 *
 * 它**不实现检索**:命中与打分是 `SqliteIndex` 的事,那一层有自己的用例
 * (`search/index/__tests__`)。这里要证的是能力这一层 —— 「索引答了一批文档,能力
 * 把它们投影成什么样的候选与旧字段」—— 所以替身按能力 id 把手上的文档原样交回去,
 * 分数取严格递减的逆序名次(与 `legacy.ts` 里那条同一个手法:排序恒等)。
 */

import type { IndexedDoc } from '@onething/core/search'
import type { SearchIndexQueryFace } from '../capabilities/indexed.js'

export interface FakeIndexOptions {
  /** 命中了哪些词(`LexicalHit.matched`);摘要开窗读它。 */
  matched?: string[]
  generation?: number
  /**
   * 向量路答哪几份文档(按给的顺序 = 按距离由近及远)。**缺席 = 向量路没开**,
   * 于是它不参与融合 —— 「没开」与「零命中」在这一层是两件事。
   */
  vectorHits?: number[]
}

export function fakeIndexFace(
  docs: readonly IndexedDoc[],
  options: FakeIndexOptions = {},
): SearchIndexQueryFace {
  const generation = options.generation ?? 1
  return {
    async search(request) {
      const all = docs.filter(doc => doc.capability === request.capability)
      const page = all.slice(request.offset, request.offset + request.limit)
      return {
        hits: page.map((doc, index) => ({
          docId: doc.docId,
          score: page.length - index,
          matched: options.matched ?? [],
          fields: Object.keys(doc.fields),
        })),
        total: all.length,
        docs: [...page],
        generation,
      }
    },
    /**
     * 向量路的替身:按 `options.vectorHits` 给的 docId 顺序答,缺席就答「没开」
     * —— 「没开」与「零命中」在这一层是两件事(前者不参与融合)。
     */
    async vectorSearch(request) {
      const wanted = options.vectorHits
      if (wanted === undefined) {
        return { hits: [], docs: [], generation, unavailable: 'off' as const }
      }
      const picked = wanted
        .map(docId => docs.find(doc => doc.docId === docId && doc.capability === request.capability))
        .filter((doc): doc is IndexedDoc => doc !== undefined)
        .slice(0, request.k)
      return {
        hits: picked.map((doc, index) => ({ docId: doc.docId, chunk: 0, distance: index * 0.1 })),
        docs: picked,
        generation,
      }
    },
    async status() {
      return {
        mode: 'owner',
        docs: docs.length,
        pending: 0,
        refolds: 0,
        building: false,
        generation,
        errors: [],
        feeds: ['ledger'],
        vector: 'off',
        vectorPending: 0,
        vectorExtension: 'missing',
      }
    },
  }
}
