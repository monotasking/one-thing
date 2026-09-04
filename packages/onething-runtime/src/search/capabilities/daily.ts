/**
 * 每日笔记检索能力 —— **索引型**(S3b)。
 *
 * 设计:docs/design/search-index-2026-09.md §4.2 / §5.2b(`DailyNotesFeed`,
 * `policy.build = 'lazy'`)/ §10 S3 行。
 *
 * ## 「首次查询才建」在哪儿
 *
 * **不在这里。** 这份 manifest 与另外两条索引型能力逐字同形,它不知道自己的来源
 * 是懒的。懒在 `DailyNotesFeed.policy.build = 'lazy'` 与索引服务的**纳入时机**上
 * (`IndexWorkerCore.ensureFeedsFor`):第一次有人查 `daily` 这个能力,那把 feed
 * 才被订阅、才跑校对。于是「首次查询才建」是索引侧的一条策略,不是能力的一格
 * 开关 —— 换成 eager 只改 feed 那一行,能力一个字不动。
 *
 * ## 与 S2 那条扫描路的可感知出入(报告里逐条列了,待用户裁)
 *
 *  - **正文可搜了**:旧路只拿 `iso + 相对路径` 做子串匹配,笔记正文一个字都不搜;
 *    这一期 `content` 进索引。
 *  - **「新建今天的日记」那条快捷项没了**:它是旧扫描器自己造的一行(不存在的
 *    文件哪来的文档),索引里没有它的位置。
 *  - **标题形状变了**:旧路是 `${iso} · ${basename}`,这一期是文件名(去扩展名)——
 *    投影器产的 `title` 字段就是它。按文件名日期查仍然中:分析器把 `2026-09-05`
 *    切成 `2026` `09` `05` 三个词元,查询走同一只分析器,所以 `2026-09-05` 与
 *    `09-05` 都命中(后者靠 AND 语义命中同一份文档)。
 *  - **只认笔记根目录**下那一层文件(`DailyNotesFeed.keys()` 不递归)。
 *
 * ## 「今天那一条」不在索引里,所以它是这一层加回去的(S3b 补)
 *
 * 「打开今天 / 新建今天的日记」说的是「今天那个文件在不在」——**不存在的文件没有
 * 文档**,索引在结构上答不出它。判定与那一行的形状**逐字沿用旧实现**:
 * `providers.ts` 的 `resolveDailyTodayShortcut` 就是从旧扫描器循环体里抽出来的
 * 同一份代码,新旧两条路调的是它。位置也照旧扫描器那只 `sort`:
 * **「新建」那条排最后、「打开今天」那条排最前**(它的 timestamp 是此刻,
 * 而笔记的 timestamp 是文件名那天)。今天的笔记已经存在时索引也会答出它,
 * 于是按 `filePath` 去重 —— 旧路那只 `seen` 的同一件事。
 */

import {
  indexedCapability,
  type CapabilityManifest,
  type PageRequest,
  type SearchCapability,
  type SearchContext,
  type SearchPage,
  type SearchQuery,
} from '@onething/core/search'
import { createSqliteLexicalRetriever } from '../index/service.js'
import { resolveDailyTodayShortcut } from '../providers.js'
import type { DailySearchResult, OnethingSearchProvidersAdapters } from '../providers.js'
import { normalizeOnethingSearchQuery } from '../search-runtime.js'
import { snippetOf, trackIndexGeneration, type SearchIndexQueryFace } from './indexed.js'
import type { LegacyBackedCandidate, SearchServiceResult } from './legacy.js'

/** 这一类的目标形:一篇笔记文件;`actionId` 在「今天还没建」那条上才有。 */
export interface DailyTarget {
  kind: 'daily'
  payload: { filePath: string; actionId?: string }
}

export const dailySearchManifest: CapabilityManifest = {
  id: 'daily',
  labelKey: 'search.capability.daily',
  icon: 'FileText',
  kind: 'indexed',
  schema: {
    title: { analyzer: 'composite', weight: 2 },
    content: { analyzer: 'composite', weight: 1 },
  },
  facets: [
    { key: 'path', type: 'enum' },
    { key: 'time', type: 'range' },
  ],
  budget: { default: 6, timeoutMs: 300 },
  order: 3,
  orderWhenIntent: { actions: 4 },
  ranking: { pinFieldHit: 'title' },
  visibility: () => ({}),
}

/** 「今天那一条」→ 一枚候选。`legacy` 一格原样驮着,投影出来的键序与旧路同。 */
function shortcutCandidate(shortcut: DailySearchResult, score: number): LegacyBackedCandidate {
  const filePath = shortcut.filePath ?? ''
  const target: DailyTarget = shortcut.actionId === undefined
    ? { kind: 'daily', payload: { filePath } }
    : { kind: 'daily', payload: { filePath, actionId: shortcut.actionId } }
  return {
    capability: dailySearchManifest.id,
    id: shortcut.id,
    title: shortcut.title,
    subtitle: shortcut.subtitle,
    score,
    time: shortcut.timestamp,
    target,
    legacy: shortcut,
  }
}

export function createDailySearchCapability(
  adapters: OnethingSearchProvidersAdapters,
  index: SearchIndexQueryFace,
): SearchCapability {
  const tracked = trackIndexGeneration(index)

  const indexed = indexedCapability({
    manifest: dailySearchManifest,
    generation: tracked.generation,
    retrievers: [createSqliteLexicalRetriever({
      manifest: dailySearchManifest,
      service: tracked.face,
      toCandidate({ doc, hit, score }) {
        // `path` facet 是**绝对路径**(壳按它打开文件);`key` 是相对名。
        const filePath = typeof doc.facets.path === 'string' ? doc.facets.path : doc.key
        const title = doc.fields.title ?? doc.key
        const titleSnippet = snippetOf(title, hit.matched)
        // 标题里没命中就把摘要开在正文上 —— 用户想看的是「命中的那句话」。
        const body = hit.fields.includes('content')
          ? snippetOf(doc.fields.content ?? '', hit.matched).text
          : undefined

        const legacy: SearchServiceResult = {
          id: `daily:${filePath}`,
          type: 'daily',
          title,
          subtitle: body ?? doc.key,
          detail: 'Daily note',
          filePath,
          timestamp: doc.time,
          matchRanges: titleSnippet.ranges,
        }
        const candidate: LegacyBackedCandidate = {
          capability: dailySearchManifest.id,
          id: legacy.id,
          title: legacy.title,
          subtitle: legacy.subtitle,
          ranges: titleSnippet.ranges,
          score,
          time: doc.time,
          target: { kind: 'daily', payload: { filePath } } satisfies DailyTarget,
          facets: doc.facets,
          legacy,
        }
        return candidate
      },
    })],
  })

  async function search(
    query: SearchQuery,
    page: PageRequest,
    ctx: SearchContext,
  ): Promise<SearchPage> {
    const indexedPage = await indexed.search(query, page, ctx)
    // 翻页时不再补一次 —— 旧路对 daily 根本没有分页,「今天那一条」是首页的事。
    if (page.cursor !== undefined) return indexedPage

    const shortcut = await resolveDailyTodayShortcut(query.raw, adapters)
      .catch(() => undefined)
    if (shortcut === undefined) return indexedPage

    // 今天的笔记已经存在时索引也答得出它 —— 去重(旧路那只 `seen`)。
    const filePath = shortcut.filePath ?? ''
    const rest = indexedPage.items.filter(item => item.id !== `daily:${filePath}`)
    const deduped = rest.length !== indexedPage.items.length
    // 分数只在**组内**排序时有意义(§6.5);排头就给一个比谁都大的、排尾就给最小的。
    const scores = rest.map(item => item.score)
    const candidate = shortcut.isCreateShortcut === true
      ? shortcutCandidate(shortcut, Math.min(0, ...scores) - 1)
      : shortcutCandidate(shortcut, Math.max(0, ...scores) + 1)
    const items = shortcut.isCreateShortcut === true
      ? [...rest, candidate].slice(0, page.limit)
      : [candidate, ...rest].slice(0, page.limit)

    return {
      ...indexedPage,
      items,
      ...(indexedPage.total === undefined
        ? {}
        : { total: deduped ? indexedPage.total : indexedPage.total + 1 }),
    }
  }

  return {
    manifest: dailySearchManifest,
    // 旧路 `all` 档的 `includeDaily = Boolean(normalizeOnethingSearchQuery(query))`:
    // 空词(以及裸 `/` `>`)时这一类整组不出现。单类档不问 `supports`,所以
    // 「空词的 daily 档先给今天那一条」照旧成立。
    supports: (query: SearchQuery) => normalizeOnethingSearchQuery(query.raw).length > 0,
    search,
  }
}
