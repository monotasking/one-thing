/**
 * 会话(标题)检索能力 —— **索引型**(S3b)。
 *
 * 设计:docs/design/search-index-2026-09.md §4.2 / §5.2(会话标题一份文档,标题
 * 来自 `meta.json` 不是账本)/ §10 S3 行。
 *
 * **id 是 `chats` 不是 `sessions`**:壳与 CLI 认的就是这个 id,改名是一次可感知
 * 的行为改动,没人裁过。文件名照落位表叫 `sessions.ts` —— 路径说落位,id 说身份。
 *
 * ## 换索引治好的与换来的
 *
 * 治好的:旧扫描器有一条已知病 —— `.filter(s => !s.isArchived)`,归档会话**搜不到**
 * (拍点丙要的是「搜得到、带个徽」)。索引照建归档会话的文档,`archived` 是一格
 * facet,壳可以过滤也可以画徽;有词那一路默认不再把它们从结果里抹掉。
 *
 * 换来的(可感知,报告里列了):`previewText` 不进索引 —— 拍点乙 a 定的会话字段
 * 只有标题。旧路里预览文以 0.8 权参与打分,索引路不参与;它仍然作为 `subtitle`
 * 显示(从会话列表里取)。
 *
 * ## 空词那一形不走索引,答的是「最近几间会话」
 *
 * 命令面板一打开就是空词,而这时该出的不是一次检索,是**按 `updatedAt` 取前 N 间**
 * (索引对零词元查询零命中)。S5(2026-09-05)之前这一支借旧扫描器 `searchChats('')`
 * 答;旧路退役之后,「最近几间会话」由这一类**自己**的纯函数 `recentSessions` 答 ——
 * 它就是那只扫描器在空词下逐字走过的四步:去掉归档的、按 `updatedAt` 降序、切
 * 前 N 间、投影成结果。自述 `browse: true` 是它对外的那句话。
 *
 * 「一个字都没变」有证词:`__tests__/__fixtures__/chats-browse.json` 是**旧函数
 * 在夹具上的输出**(S5 删它之前录的),`__tests__/chats-browse.test.ts` 拿它逐条比。
 *
 * 「零词元」的判据是 `normalizeSearchQuery`:裸 `/` 与 `>` 归一化之后也是空串,
 * 旧路对它们同样答最近几间会话,这里跟着。
 */

import {
  createCursorCodec,
  hashQueryShape,
  indexedCapability,
  matchesFacetFilters,
  paginate,
  readOffsetCursor,
  type Candidate,
  type CapabilityManifest,
  type FacetFilter,
  type FacetValue,
  type PageRequest,
  type PreviewPayload,
  type SearchCapability,
  type SearchContext,
  type SearchPage,
  type SearchQuery,
} from '@onething/core/search'
import { canApplyGeneratedSessionTitle } from '@onething/core/engine'
import { createSqliteLexicalRetriever } from '../index/service.js'
import type { OnethingSearchProvidersAdapters, OnethingSearchSessionMeta } from '../providers.js'
import {
  createSessionShellLookup,
  snippetOf,
  snippetWindowOf,
  trackIndexGeneration,
  type SearchIndexQueryFace,
} from './indexed.js'
import { sessionScopeVisibility } from './visibility.js'
import type { ResultBackedCandidate, SearchServiceResult } from './scan-adapter.js'
import { normalizeSearchQuery } from './text-match.js'
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
  // S7 **不给 `embed`**:会话标题短(真库中位数十来个字),向量在这个长度上意义
  // 很小,而嵌它要付一整轮前向。这是 §15.4 那张表里 chats 走 `'explicit'` 的同一个
  // 理由 —— 两处都写着,不许只改一处。
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
  // **`'explicit'`**(§15.4):只在调用方明说要语义(壳的「语义」片 →
  // `filters.semantic`)或消费面是 agent 工具时才跑。消费面的名字由**能力**列,
  // core 里一个消费面的字面量都没有。
  retrievers: { vector: { when: 'explicit', surfaces: ['agent-tool'] } },
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

/** 空词 = 「最近几间会话」那一形(裸 `/` `>` 归一化之后也是空串)。 */
function asksForRecentSessions(query: SearchQuery): boolean {
  return normalizeSearchQuery(query.raw).length === 0
}

/**
 * **占位名归空**(检索面终稿 §6「无标题会话」那一行)。
 *
 * 「New Chat」不是标题,是「这间还没起名」的另一种写法 —— 它上了检索面就成了一堆
 * 长得一模一样的行。判据不新写:`canApplyGeneratedSessionTitle(name, '')` 恰好就是
 * 「这个名字是空的或是那句占位」,而它正是**起标题**那条路判「能不能覆盖」用的
 * 同一句话(`core/engine/title.ts`)。两处一个判据,占位名的写法将来变了也只改一处。
 *
 * 归空之后画什么(首条用户消息 / 「未命名会话」)是**壳**的事 —— 后端交事实,
 * 不替壳编一个标题。
 *
 * **步⑧已接线**:壳这一侧 `resultRows` 把兜底补上了 —— 标题空了就把首条用户消息
 * (候选的 `subtitle`)顶上来,两样都没有时行上画一句斜体的「未命名会话」。
 * 所以这里可以如实归空,不再替壳编一个标题。
 */
export function sessionTitleOf(name: string | undefined): string {
  return canApplyGeneratedSessionTitle(name, '') ? '' : (name ?? '')
}

/** 一间会话在浏览态里的 facets —— 键与 manifest 声明的四格逐字对应。 */
function sessionFacets(session: OnethingSearchSessionMeta, workspaceId: string): Record<string, FacetValue> {
  return {
    sessionId: session.id,
    // 会话自己说得出空间就听它的;说不出就是这一次搜索的空间语境(`ctx.spaceId`)——
    // 与索引那一路写进 `doc_facets` 的 `spaceId` 同一个键、同一个意思。
    spaceId: session.workspaceId ?? workspaceId,
    archived: session.isArchived === true,
    time: session.updatedAt,
  }
}

/**
 * 浏览态那一页:**未归档的会话**,按 `updatedAt` 降序,**可翻页**。
 *
 * 排序与投影逐字沿用 S5 之前那只 `searchChats` 在空词下走过的路(空查询下每条的分
 * 都是 1,排序整段退化成 `updatedAt` 降序,`matchRanges` 恒缺席)。
 *
 * **改的是切页那一刀**(检索面终稿 §4):从前它交 `slice(0, limit)` 给扫描型基座,
 * 而扫描型要「多扫出一条」才发游标 —— 交的正好是 limit 条,于是**游标恒缺席**,
 * 浏览态永远只有第一页、也说不出一共有几间。现在整张表交给 `paginate`:`total` 是
 * 真数(未归档且过滤片放行的条数),游标是偏移形。
 *
 * 归档会话不出现在这一页:与有词那一路(索引照建归档文档、`archived` 是一格
 * facet)是**两件事** —— 「最近几间」说的是「接着干哪一间」,归档的按定义不是。
 * 用户显式递 `archived: true` 那一格过滤片时照它说的办。
 */
function browseSessions(
  sessions: readonly OnethingSearchSessionMeta[],
  workspaceId: string,
  filters: Readonly<Record<string, FacetFilter>>,
): Array<{ result: SearchServiceResult; facets: Record<string, FacetValue> }> {
  const asksArchived = filters.archived !== undefined
  return sessions
    .filter(session => asksArchived || !session.isArchived)
    .map(session => ({ session, facets: sessionFacets(session, workspaceId) }))
    .filter(entry => matchesFacetFilters(entry.facets, filters))
    .sort((a, b) => b.session.updatedAt - a.session.updatedAt)
    .map(({ session, facets }) => ({
      result: {
        id: `chat:${session.id}`,
        type: 'chat' as const,
        // 壳已经接上兜底(首条用户消息 / 「未命名会话」),所以这里如实归空。
        title: sessionTitleOf(session.name),
        subtitle: session.previewText,
        sessionId: session.id,
        timestamp: session.updatedAt,
      },
      facets,
    }))
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
  const overview: SessionOverviewPreview = {
    sessionId: session.id,
    title,
    messageCount: session.messageCount ?? 0,
    updatedAt: session.updatedAt,
    preview: session.previewText ?? '',
  }
  // **交 id 不交名字**(R12):空间叫什么是给人看的一句话,壳手上就有那张表。
  // 会话表上没有这一格的宿主(单测的假件)就缺席 —— 缺席 = 不知道,不是「没有空间」。
  return session.workspaceId === undefined ? overview : { ...overview, spaceId: session.workspaceId }
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

  const codec = createCursorCodec()

  /**
   * 空词那一路。**不再借扫描型基座**(那条路交多少就是多少,游标永远发不出来),
   * 直接把整张表交给 `paginate`:真 `total` + 偏移游标(检索面终稿 §4)。
   *
   * 指纹里没有「索引代次」——这一路根本不问索引,它读的是会话表。表变了而游标还在
   * 的那一次会漏行或重行,壳按 id 去重(§5.4 闸③),与静态型同一条判例。
   */
  const browse = async (
    query: SearchQuery,
    page: PageRequest,
    ctx: SearchContext,
  ): Promise<SearchPage> => {
    const rows = browseSessions(adapters.getSessionsList(), ctx.spaceId, query.filters)

    const queryHash = hashQueryShape({ raw: query.raw, intent: query.intent, filters: query.filters })
    const offset = readOffsetCursor(codec, page.cursor, { capability: chatsSearchManifest.id, queryHash })
    const window = rows.slice(offset, offset + Math.max(0, page.limit))

    const items: ResultBackedCandidate[] = window.map((entry, index) => {
      const session = sessionOf(entry.result.sessionId ?? '')
      const candidate: ResultBackedCandidate = {
        capability: chatsSearchManifest.id,
        id: entry.result.id,
        title: entry.result.title,
        subtitle: entry.result.subtitle,
        // 逆序名次:严格递减且唯一 → 组内排序恒等,`updatedAt` 降序原样保留
        // (`scan-adapter.ts` 里那条同一个手法)。
        score: window.length - index,
        time: entry.result.timestamp,
        target: { kind: 'chat', payload: { sessionId: entry.result.sessionId ?? '' } } satisfies ChatTarget,
        facets: entry.facets,
        result: { ...entry.result, facets: entry.facets },
      }
      // 空词那一路也带内联预览:自述说的是「这个能力的候选带 inline 预览」,
      // 不是「有词的时候才带」—— 两条路一句话,否则壳会看见半张表。
      return session === undefined
        ? candidate
        : { ...candidate, preview: sessionOverviewPreview(session, entry.result.title) }
    })

    return paginate(items, page, {
      capability: chatsSearchManifest.id,
      codec,
      queryHash,
      total: rows.length,
      offset,
    })
  }

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
        const snippetWindow = snippetWindowOf(snippet)
        const session = sessionOf(sessionId)

        const result: SearchServiceResult = {
          id: `chat:${sessionId}`,
          type: 'chat',
          // §6「无标题会话」:占位名归空,画什么归壳(它有首条用户消息可顶)。
          title: sessionTitleOf(title),
          subtitle: session?.previewText,
          sessionId,
          timestamp: doc.time,
          matchRanges: snippet.ranges,
          ...(snippetWindow === undefined ? {} : { snippet: snippetWindow }),
          source: 'lexical',
        }
        const candidate: ResultBackedCandidate = {
          capability: chatsSearchManifest.id,
          id: result.id,
          title: result.title,
          subtitle: result.subtitle,
          ranges: snippet.ranges,
          score,
          time: doc.time,
          target: { kind: 'chat', payload: { sessionId } } satisfies ChatTarget,
          facets: doc.facets,
          result,
        }
        // 索引里没有这间会话的元数据(刚删掉、或索引比会话表新一步)时**不带**
        // 预览这一格 —— 候选照出,只是没有概览可画;吞掉整条结果才是错的。
        return session === undefined
          ? candidate
          : { ...candidate, preview: sessionOverviewPreview(session, result.title) }
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
      asksForRecentSessions(query) ? browse(query, page, ctx) : indexed.search(query, page, ctx),
    preview,
  }
}
