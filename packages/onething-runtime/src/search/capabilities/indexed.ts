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
import { mapDisplayRangeToSource, toDisplayText } from '../text/plain.js'
import type { SearchResultSnippetWindow } from './scan-adapter.js'

/**
 * 能力要的索引面 —— 只有两句话。
 *
 * 它是 `SearchIndexService` 的一个 `Pick` 而不是一份新接口:形状要跟着服务走,
 * 而单测里塞一个字面量对象也照样过(两个方法各答一句)。
 */
export type SearchIndexQueryFace = Pick<SearchIndexService, 'search' | 'status' | 'vectorSearch'>

/** 与 `SqliteIndex` 索引时用的是同一条归一化链 —— 两边不许分家。 */
const normalize = composeNormalizers(DEFAULT_NORMALIZERS)

export interface FieldSnippet {
  text: string
  /** 相对 `text` 的高亮区间(旧字段 `matchRanges` 就是它)。 */
  ranges: TextRange[]
  /**
   * 这扇窗在**剥过记号的全文**里的起点,以及两端截没截(检索面终稿 §4)。
   *
   * 坐标系与 `text` / `ranges` 是同一个:那串**屏上看得见的字**。不是 markdown
   * 原文的坐标 —— 混两套坐标只会让壳画的省略号与高亮各说各的。
   */
  offset: number
  truncatedStart: boolean
  truncatedEnd: boolean
}

/**
 * 一个词元算不算命中了 `matched` 里那几个词(检索面终稿 §4)。
 *
 * 判据是「**等于查询词,或以它为前缀**」而不是逐字相等。相等那一版在前缀命中上
 * 一条高亮都画不出:用户打 `jir`,索引把它展开成 `jira` 去查(`expand.ts` 的前缀
 * 展开),回来的 `matched` 里是哪一个串取决于展开的方向,而正文里的词元是 `jira`。
 * 两边只要有一边是另一边的前缀,那就是用户眼里的「这里命中了」。
 */
function tokenMatches(token: string, wanted: readonly string[]): boolean {
  return wanted.some(term => token === term || token.startsWith(term) || term.startsWith(token))
}

/**
 * 从一段正文里开一扇 120 字的窗,窗里带上命中高亮。
 *
 * 三步:**先剥 markdown 记号**(`toDisplayText`,R8:行上的字是给人读的一句话,
 * 不是源码),再把剥过的串按**同一只分析器**切一遍、留下命中 `matched` 的那些
 * token,最后让 core 的 `buildSnippet` 挑「装得下最多命中」的那一扇窗。
 *
 * 剥记号在**开窗之前**是判据的一部分:先开窗再剥,窗里那 120 个字会被剥掉一截,
 * 屏上就短了一块、区间也全错位。
 *
 * 一个命中都对不上时退回开头那一段 —— 那不是错:向量路根本没有「命中词」这回事
 * (`matched` 是空表)。
 */
export function snippetOf(source: string, matched: readonly string[]): FieldSnippet {
  if (source.length === 0) {
    return { text: '', ranges: [], offset: 0, truncatedStart: false, truncatedEnd: false }
  }
  const display = toDisplayText(source).text
  const normalized = normalize(display)
  const tokens = matched.length === 0
    ? []
    : compositeAnalyzer.analyze(normalized.text).filter(token => tokenMatches(token.text, matched))
  const snippet = buildSnippet(display, hitRangesFromTokens(normalized, tokens))
  return {
    text: snippet.text,
    ranges: snippet.ranges,
    offset: snippet.offset,
    truncatedStart: snippet.truncatedStart,
    truncatedEnd: snippet.truncatedEnd,
  }
}

/**
 * **一段正文里,这次查询命中了哪几处**(检索面终稿 §4:预览与列表同一个高亮产地)。
 *
 * 与 `snippetOf` 的差别只有两处:它不开窗(预览要画整段),而且命中词是从**查询串**
 * 自己切出来的 —— 预览请求上没有索引答的 `LexicalHit.matched`,只有用户打的那个词。
 * 判据(剥记号 → 同一只分析器 → 词元等于或互为前缀)与 `snippetOf` **逐字同源**,
 * 所以两处标出来的是同一批字。
 *
 * 返回的区间相对**传进来的那段原文**(`source`),不是剥过记号的串 —— 预览体画的
 * 就是原文那一段(块渲染),两边坐标必须是同一套。
 */
export function queryRangesOf(source: string, query: string): TextRange[] {
  if (source.length === 0 || query.trim().length === 0) return []
  const display = toDisplayText(source)
  const wanted = compositeAnalyzer.analyze(normalize(query).text).map(token => token.text)
  if (wanted.length === 0) return []
  const normalized = normalize(display.text)
  const tokens = compositeAnalyzer.analyze(normalized.text)
    .filter(token => tokenMatches(token.text, wanted))
  // 两段映射串起来:归一化坐标 → 剥过记号的串 → 原文。
  return hitRangesFromTokens(normalized, tokens).map(range => mapDisplayRangeToSource(display, range))
}

/**
 * 一条结果上那三格 `snippet`(契约 `SearchResult.snippet`)。
 *
 * **窗口就是全文时不加这一格** —— 契约上「缺席 = 那串字就是全文」,而一个
 * `{offset:0,truncatedStart:false,truncatedEnd:false}` 与缺席在 JSON 上不可区分、
 * 在键比对上却是两件事(同 `scan-adapter.ts` 里 `preview` 那条判据)。
 */
export function snippetWindowOf(snippet: FieldSnippet): SearchResultSnippetWindow | undefined {
  if (!snippet.truncatedStart && !snippet.truncatedEnd) return undefined
  return {
    offset: snippet.offset,
    truncatedStart: snippet.truncatedStart,
    truncatedEnd: snippet.truncatedEnd,
  }
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
      // 向量路答回来的代次同样算数 —— 它读的是同一个库,索引变了它先知道也一样。
      vectorSearch: async request => {
        const result = await index.vectorSearch(request)
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
