/**
 * 会话(标题)检索能力 —— **索引型**(S3b)。
 *
 * 设计:docs/design/search-index-2026-09.md §4.2 / §5.2(会话标题一份文档,标题
 * 来自 `meta.json` 不是账本)/ §10 S3 行。
 *
 * **id 是 `chats` 不是 `sessions`**:S5 之前 id 就是今天的 `SearchCategory` 取值,
 * 壳与 CLI 都认它;改名是 S5 的事。文件名照落位表叫 `sessions.ts`。
 *
 * ## 换索引治好的与换来的
 *
 * 治好的:S2 那只 `searchChats` 有一条已知病 —— `.filter(s => !s.isArchived)`,
 * 归档会话**搜不到**(拍点丙要的是「搜得到、带个徽」)。索引照建归档会话的文档,
 * `archived` 是一格 facet,壳可以过滤也可以画徽;默认不再把它们从结果里抹掉。
 *
 * 换来的(可感知,报告里列了):`previewText` 不进索引 —— 拍点乙 a 定的会话字段
 * 只有标题。S2 里预览文以 0.8 权参与打分,这一期不参与;它仍然作为 `subtitle`
 * 显示(从会话列表里取)。
 *
 * ## 空词那一形不走索引(S3b 补)
 *
 * 命令面板一打开就是空词,旧 `searchChats('')` 答的是「最近几间会话」—— 它根本不是
 * 一次检索,是**按 `updatedAt` 取前 N 间**。索引对零词元查询零命中,所以这条路让
 * 空词绕开索引、**逐字调用旧函数**(`createOnethingSearchRuntimeAdapters().searchChats`)
 * 再按 S2 那套 `legacyScanCapability` 投影 —— 保旧行为的最稳写法就是「调它」,而不是
 * 「再实现一遍最近几间会话」。有词照旧走索引。
 *
 * 「零词元」的判据用旧路那只 `normalizeOnethingSearchQuery`:裸 `/` 与 `>` 归一化之后
 * 也是空串,旧路对它们同样答最近几间会话,这里跟着。
 *
 * 这一格是**过渡**:S5 前把「最近会话」抽成它自己的 static 能力(自述、次序、配额
 * 都归它),那时这个分支与旧函数一起删(设计 §13 留账)。
 */

import {
  indexedCapability,
  type Candidate,
  type CapabilityManifest,
  type PageRequest,
  type PreviewPayload,
  type SearchCapability,
  type SearchContext,
  type SearchQuery,
} from '@onething/core/search'
import { createSqliteLexicalRetriever } from '../index/service.js'
import { createOnethingSearchRuntimeAdapters } from '../providers.js'
import type { OnethingSearchProvidersAdapters, OnethingSearchSessionMeta } from '../providers.js'
import { normalizeOnethingSearchQuery } from '../search-runtime.js'
import {
  createSessionShellLookup,
  snippetOf,
  trackIndexGeneration,
  type SearchIndexQueryFace,
} from './indexed.js'
import { legacyScanCapability } from './legacy.js'
import { sessionScopeVisibility } from './visibility.js'
import type { LegacyBackedCandidate, SearchServiceResult } from './legacy.js'
import {
  PreviewUnavailableError,
  firstCandidate,
  requireStringField,
  targetPayloadOf,
  type SessionOverviewPreview,
} from './preview.js'

/** 这一类的目标形。壳按 `kind` 从目标渲染注册表取组件(§4.1)。 */
export interface ChatTarget {
  kind: 'chat'
  payload: { sessionId: string }
}

export const chatsSearchManifest: CapabilityManifest = {
  id: 'chats',
  labelKey: 'search.capability.chats',
  icon: 'MessageSquare',
  kind: 'indexed',
  // 只有标题一格 —— 与投影器产的会话文档逐字对应。权重 2 是「标题命中比正文
  // 命中值钱」,而这一类里没有正文,所以它实际只影响跨字段无从比较时的绝对分。
  schema: { title: { analyzer: 'composite', weight: 2 } },
  facets: [
    { key: 'sessionId', type: 'enum' },
    { key: 'spaceId', type: 'enum' },
    { key: 'archived', type: 'boolean' },
    { key: 'time', type: 'range' },
  ],
  budget: { default: 6, timeoutMs: 300 },
  order: 1,
  orderWhenIntent: { actions: 3 },
  // 与 messages 同一条规则(§6.4b / 拍点辛 a):会话标题也是会话内容,一间 agent
  // 看不见的房,它的**房名**同样不该出现在结果里(`collab/visibility.ts` 的原话:
  // 不可见不是「看不到内容」,是「这间房不存在」)。
  visibility: sessionScopeVisibility,
  // **inline**(§4.5 ①):概览的四格全部来自**已经在手的那张会话表**
  // (`getSessionsList()`,一次搜索本来就要读它去补 subtitle)—— 一次 map,不读账本、
  // 不发请求。这么便宜的东西选中再取一次是白跑一趟网络,所以随候选带。
  preview: { mode: 'inline' },
  // **空词时我有浏览态**(S4b):下面 `recent` 那条路就是它 —— 旧 `searchChats('')`
  // 按 `updatedAt` 取前 N 间。壳读这一格决定空输入框里问谁,于是它那一侧不必
  // 出现 `chats` 这个名字(09-01 裁定的「所有档空词 = 全部会话、能翻页」因此回来)。
  browse: true,
}

/** 空词 = 「最近几间会话」那一形(旧路的 `normalizeQuery(query) === ''`)。 */
function asksForRecentSessions(query: SearchQuery): boolean {
  return normalizeOnethingSearchQuery(query.raw).length === 0
}

/**
 * 一间会话 → `session-overview` 载荷。
 *
 * `messageCount` 这一格从**会话列表元数据**上读(`SessionMeta.messageCount`,会话
 * 列表投影本来就维护它)。会话表上没有这一格时给 `0` 而不是去数账本:数一遍要把
 * 那间会话的 `events.jsonl` 折一遍,而这是 inline 路 —— 一次 `all` 档六条候选就是
 * 六次折账本,预览再便宜也不能便宜到这个价钱上。
 */
function sessionOverviewOf(session: OnethingSearchSessionMeta, title: string): SessionOverviewPreview {
  return {
    sessionId: session.id,
    title,
    messageCount: session.messageCount ?? 0,
    updatedAt: session.updatedAt,
    preview: session.previewText ?? '',
  }
}

function sessionOverviewPreview(session: OnethingSearchSessionMeta, title: string): PreviewPayload {
  return { kind: 'session-overview', payload: sessionOverviewOf(session, title), title }
}

export function createChatsSearchCapability(
  adapters: OnethingSearchProvidersAdapters,
  index: SearchIndexQueryFace,
): SearchCapability {
  const sessionOf = createSessionShellLookup(() => adapters.getSessionsList(), session => session.id)
  const tracked = trackIndexGeneration(index)

  // 空词那一路:旧函数逐字调用 + S2 那套投影。基座按每次 `search()` 现造,因为
  // 「最近几间」的 N **就是本次的 limit**(`legacy.ts` 里那条同样的理由)。
  const recent = legacyScanCapability({
    manifest: chatsSearchManifest,
    run: (raw, limit) => createOnethingSearchRuntimeAdapters(adapters).searchChats(raw, limit),
    supports: asksForRecentSessions,
    target: result => ({ kind: 'chat', payload: { sessionId: result.sessionId ?? '' } } satisfies ChatTarget),
    // 空词那一路也带内联预览:自述说的是「这个能力的候选带 inline 预览」,
    // 不是「有词的时候才带」—— 两条路一句话,否则壳会看见半张表。
    preview: result => {
      const session = sessionOf(result.sessionId ?? '')
      return session === undefined ? undefined : sessionOverviewPreview(session, result.title)
    },
  })

  const indexed = indexedCapability({
    manifest: chatsSearchManifest,
    generation: tracked.generation,
    retrievers: [createSqliteLexicalRetriever({
      manifest: chatsSearchManifest,
      service: tracked.face,
      toCandidate({ doc, hit, score }) {
        // 会话文档的 key 就是会话号(投影器定的)。
        const sessionId = doc.key
        const title = doc.fields.title ?? ''
        const snippet = snippetOf(title, hit.matched)
        const session = sessionOf(sessionId)

        const legacy: SearchServiceResult = {
          id: `chat:${sessionId}`,
          type: 'chat',
          title: title || 'New Chat',
          subtitle: session?.previewText,
          sessionId,
          timestamp: doc.time,
          matchRanges: snippet.ranges,
        }
        const candidate: LegacyBackedCandidate = {
          capability: chatsSearchManifest.id,
          id: legacy.id,
          title: legacy.title,
          subtitle: legacy.subtitle,
          ranges: snippet.ranges,
          score,
          time: doc.time,
          target: { kind: 'chat', payload: { sessionId } } satisfies ChatTarget,
          facets: doc.facets,
          legacy,
        }
        // 索引里没有这间会话的元数据(刚删掉、或索引比会话表新一步)时**不带**
        // 预览这一格 —— 候选照出,只是没有概览可画;吞掉整条结果才是错的。
        return session === undefined
          ? candidate
          : { ...candidate, preview: sessionOverviewPreview(session, legacy.title) }
      },
    })],
  })

  /**
   * `search.preview` 路由问到这一类时的答复。
   *
   * inline 的能力照理不会被 lazy 地问一次(壳读自述就知道预览已经在候选身上),
   * 但**基数**这件事只有请求知道:`compare` / `batch` 会把两条、N 条候选交上来,
   * 服务层要能对同一个能力各要一份。所以这一格照实现,判据与 inline 那两处
   * 逐字同源(同一个 `sessionOverviewPreview`),不是第二套投影。
   */
  const preview = async (candidates: Candidate[]): Promise<PreviewPayload> => {
    const candidate = firstCandidate(candidates)
    const payload = targetPayloadOf(candidate, 'chat')
    const sessionId = requireStringField(payload, 'sessionId', '这条会话命中')
    const session = sessionOf(sessionId)
    if (session === undefined) {
      throw new PreviewUnavailableError(`会话表里已经没有 ${sessionId} 了`)
    }
    return sessionOverviewPreview(session, candidate.title)
  }

  return {
    manifest: chatsSearchManifest,
    // **空词也答**:全部档的分组里要有「最近几间会话」那一格(旧壳的空态)。
    supports: (query: SearchQuery) => asksForRecentSessions(query) || indexed.supports(query),
    search: (query: SearchQuery, page: PageRequest, ctx: SearchContext) =>
      (asksForRecentSessions(query) ? recent : indexed).search(query, page, ctx),
    preview,
  }
}
