/**
 * 三条索引型能力共用的那几件小东西(S3b)。
 *
 * 设计:docs/design/search-index-2026-09.md §4.2(索引基座)/ §6.5(摘要从文档表
 * 的 `fields` 开 120 字窗)/ §8(`SearchResult` 的旧字段照旧填)。
 *
 * 这里**没有**「三条能力的公共基类」。三条能力各自完整地说出自己是什么(manifest、
 * 目标形、旧字段怎么填),这个文件只放**真正逐字相同**的两件事:
 *
 *  ① 索引问答面的类型(`SearchIndexQueryFace`)—— 能力只需要「能查、能报状态」,
 *     不需要认识 Worker、不需要认识 sqlite;
 *  ② 摘要开窗(`snippetOf`)—— 从 `hit.matched` 那几个词在正文里的落点开一扇窗,
 *     命中区间经偏移映射转回**原文**坐标。壳高亮的是用户看得见的那串字。
 *
 * 加第四条索引型能力时,这个文件一个字都不用改。
 */

import {
  DEFAULT_NORMALIZERS,
  buildSnippet,
  compositeAnalyzer,
  composeNormalizers,
  hitRangesFromTokens,
  type TextRange,
} from '@onething/core/search'

import type { SearchIndexService } from '../index/service.js'

/**
 * 能力要的索引面 —— 只有两句话。
 *
 * 它是 `SearchIndexService` 的一个 `Pick` 而不是一份新接口:形状要跟着服务走,
 * 而单测里塞一个字面量对象也照样过(两个方法各答一句)。
 */
export type SearchIndexQueryFace = Pick<SearchIndexService, 'search' | 'status'>

/** 与 `SqliteIndex` 索引时用的是同一条归一化链 —— 两边不许分家。 */
const normalize = composeNormalizers(DEFAULT_NORMALIZERS)

export interface FieldSnippet {
  text: string
  /** 相对 `text` 的高亮区间(旧字段 `matchRanges` 就是它)。 */
  ranges: TextRange[]
}

/**
 * 从一段正文里开一扇 120 字的窗,窗里带上命中高亮。
 *
 * `matched` 是索引答的那几个词元(`LexicalHit.matched`)。这里把正文按**同一只
 * 分析器**切一遍、留下在 `matched` 里的那些 token,再让 core 的 `buildSnippet`
 * 挑「装得下最多命中」的那一扇窗。一个命中都对不上时退回开头那一段 —— 那不是
 * 错:前缀展开命中的词元与原文里的词元可以不是同一个串。
 */
export function snippetOf(source: string, matched: readonly string[]): FieldSnippet {
  if (source.length === 0) return { text: '', ranges: [] }
  const wanted = new Set(matched)
  const normalized = normalize(source)
  const tokens = wanted.size === 0
    ? []
    : compositeAnalyzer.analyze(normalized.text).filter(token => wanted.has(token.text))
  const snippet = buildSnippet(source, hitRangesFromTokens(normalized, tokens))
  return { text: snippet.text, ranges: snippet.ranges }
}

/**
 * 索引代次的**回声**:包一层问答面,把每次查询答回来的 `generation` 记下来。
 *
 * 索引基座要一格 `generation()` 来算游标哈希(§4.2「索引变了 hash 变,cursor 自然
 * 失效」),而它是**同步**的;真代次住在另一条线程上,只能跟着查询的回答捎回来。
 * 于是这里记的是「上一次查询时索引的代次」—— 索引在两次查询之间变了,第二次查询
 * 就会拿到新代次,第三页的游标当场失效。差的是一拍,而不是永远不失效。
 */
export function trackIndexGeneration(index: SearchIndexQueryFace): {
  face: SearchIndexQueryFace
  generation(): number
} {
  let generation = 0
  return {
    face: {
      status: () => index.status(),
      search: async request => {
        const result = await index.search(request)
        generation = result.generation
        return result
      },
    },
    generation: () => generation,
  }
}

/**
 * 一张会话号 → 会话外壳的小表,**带 1 秒有效期**。
 *
 * 为什么要它:消息与会话两条结果上的 `subtitle`(会话标题 / 预览文)住在会话列表
 * 里,不在文档表里 —— 拍点乙 a 定的索引字段是正文 / 标题 / 附件名,不含「另一条
 * 文档的字段」。而 `toCandidate` 是**逐条**调用的,每条都 `getSessionsList()` 就
 * 是一次搜索里几十遍全量列表。
 *
 * 1 秒是「一次搜索的量级」:同一次搜索里的几十条命中共用一份快照,下一次搜索重
 * 建。改了名的会话在最坏情况下有 1 秒的旧副标题,而标题本身是从索引来的(改名
 * 经 `session:renamed` 立刻重折),所以这一秒只影响副标题那一格。
 */
export function createSessionShellLookup<T>(list: () => readonly T[], idOf: (item: T) => string): (id: string) => T | undefined {
  const TTL_MS = 1000
  let cache: { at: number; byId: Map<string, T> } | undefined
  return id => {
    const now = Date.now()
    if (cache === undefined || now - cache.at > TTL_MS) {
      cache = { at: now, byId: new Map(list().map(item => [idOf(item), item])) }
    }
    return cache.byId.get(id)
  }
}
