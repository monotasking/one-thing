/**
 * `search` 工具的适配器(S6,§14.3)。
 *
 * 设计:docs/design/search-index-2026-09.md §14。
 *
 * 三件事,一件不多:把工具的词汇表翻成 `SearchService` 的词汇表,把服务的答案翻
 * 回工具的词汇表,以及**铸一次 `SearchContext`** —— 后者是这个文件存在的真正理由。
 *
 * ## 现场是这里铸的,不是工具铸的
 *
 * `SearchContext` 带着 `principal` / `surface` / `spaceId` 三格,而它们决定授权
 * (§6.4b:范围在 fanout 调 `search()` **之前**就进了 filters)。工具那一侧只从
 * `RunContext.invocation` 上**读**这三格再原样递下来,它不许自己编一个 —— 判例与
 * `rpc/registry.ts` 那句「宿主在自己的鉴权跑完之后铸 context,永远不从信封上读
 * 身份」同源。
 *
 * `surface: 'agent-tool'` 是 §14.1 那一格。它今天不改变任何能力的参与(没有能力
 * 声明 `surfaces`),但它是「AI 是一个消费面」这件事在代码里的落点:哪天某个能力
 * 要说「我不给 agent 用」,它写的是自己的 `surfaces`,不是这里多一条 if。
 *
 * ## ref 与 `expand`
 *
 * ref 是 `${capability}:${candidate.id}` —— 跨调用稳定(候选 id 是能力内稳定的,
 * 见 `core/search/candidate.ts`)。`expand` 时从**第一个**冒号切:能力 id 里没有
 * 冒号,候选 id 里可能有(messages 的候选 id 就是 `msg:<sid>:<mid>`)。
 *
 * 预览要的不止 id,还要 `target`(「去哪儿取内容」那一格;`SearchPreviewItem` 的
 * 注释写着缺席时画不出来)。而 target 不该印进模型的上下文 —— 那是白花 token,
 * 且它的形是开放的。所以这里在**搜索那一趟**把见过的 target 记在闭包里,`expand`
 * 时按 ref 取回:
 *
 *  - **闭包不是模块槽**。这份记录跟着 `createAppSearchToolAdapters` 的这一个实例
 *    走,服务落地它就跟着没了;进程里同时起两份服务(桌面 + 回环 server)也不串。
 *    「新的装配期状态住实例上、不住模块槽」那条纪律在这里的形态就是这个闭包。
 *  - **它不是权威表,只是一次转手**。`expand` 一个从没搜出来过的 ref 会拿不到
 *    target,由 `service.preview` 如实答「画不出预览」——这与工具描述里那句
 *    「A result id from a previous call」逐字一致,不是一个缺陷。
 *  - **上限是硬的**:检索结果无界,而这是一份常驻的 Map。到顶按插入序丢最旧的。
 *
 * ## 「不挑」那一档要补一发(09-08 用户裁定)
 *
 * 09-08 的 rg 失控修单让 `fanout` 在 all 档对**自述 `kind: 'scan'`** 的能力零 I/O
 * 答 `deferred: true`(`docs/design/search-index-2026-09.md` §13.x 第 4 行)——
 * 整发不再被一次外部枚举钉死,代价是那一类这一次**根本没问**。壳当时就按块补取;
 * 这只工具没有块、没有 effect,于是一直拿不到那一类的命中(§13.x 留账①)。用户
 * 09-08 裁定:**all 也要补**。
 *
 * 补法与壳同源、判据同源:**按 `groups[].deferred` 补,不按能力名**。谁被 defer
 * 是自述说了算,这个文件照旧一个能力名都不认识 —— 明天多一路 scan 型能力,这里
 * 一个字不改就跟着补。
 *
 * 三条边界,都是「这是工具这一个消费面自己的选择」的直接后果:
 *  - **只在这里补**。core / service / 壳一行不动:后端答的仍然是那份带 `deferred`
 *    的总览(壳还按它按块补取),补出来的那份**只活在这次工具调用的返回值里**。
 *  - **`deferred` 补完就没了**。成功 = 这一组与从没被 defer 过的组逐字同形(留一格
 *    `deferred:false` 只会请下游去分辨两种「答完了」);失败 = 这一格换成 `error`
 *    —— `deferred` 说的是「没问」,而我们问了,那是两件事。于是这只工具的响应里
 *    **永远不出现 `deferred`**,是个能被断言的不变量。
 *  - **一组塌了不拖累整发**。`Promise.all` 并发补,单发的失败只落在它自己那一组的
 *    `error` 上;末行按 §13.x 那条判词照实说「这一类没搜成」,而不是让它冒充「没有」。
 */

import type { FacetFilter, SearchContext, SearchPrincipal } from '@onething/core/search'
import type {
  OnethingSearchService,
  SearchServiceGroup,
  SearchServiceRequest,
  SearchServiceResponse,
} from '@onething/runtime/search'
import type {
  SearchToolAdapters,
  SearchToolHit,
  SearchToolIncomplete,
  SearchToolPage,
  SearchToolPrincipal,
  SearchToolQuery,
} from '@onething/runtime/toolkit'

/** §14.1:AI 这一路的消费面名。core 不枚举消费面,所以这个串只出现在这里。 */
export const AGENT_TOOL_SURFACE = 'agent-tool'

/** 记得住多少条 target。见文件头「ref 与 expand」最后一行。 */
export const SEARCH_TARGET_MEMO_CAP = 512

type Target = { kind: string; payload: unknown }

/** 工具主体 → 检索主体。两边 `kind` 的取值域相同,这里只是搬。 */
function searchPrincipalOf(principal: SearchToolPrincipal): SearchPrincipal {
  return { kind: principal.kind, id: principal.id, sessionId: principal.sessionId }
}

function contextOf(principal: SearchToolPrincipal, signal?: AbortSignal): Partial<SearchContext> {
  return {
    principal: searchPrincipalOf(principal),
    surface: AGENT_TOOL_SURFACE,
    spaceId: principal.spaceId,
    executionContext: principal.executionContext,
    // 工具的 abort scope。缺席时 `createSearchContext` 兜一条永不 abort 的 ——
    // 与这一路从前的行为逐字相同。
    ...(signal === undefined ? {} : { signal }),
  }
}

/**
 * 工具的时间窗 / 会话收窄 → `filters`。
 *
 * 键名是**各能力自述里声明的那几个**(`sessionId` / `time`),不是这里发明的:
 * messages 与 chats 的 `facets` 里逐字有这两格。授权范围随后由 fanout 叠在它们
 * 之上,**且范围赢**(`applyVisibility`:模型手打的过滤片不许放宽授权)。
 */
function filtersOf(query: SearchToolQuery): Record<string, FacetFilter> | undefined {
  const filters: Record<string, FacetFilter> = {}
  if (query.sessionId !== undefined) filters.sessionId = query.sessionId
  if (query.since !== undefined || query.until !== undefined) {
    filters.time = {
      ...(query.since === undefined ? {} : { gte: query.since }),
      ...(query.until === undefined ? {} : { lte: query.until }),
    }
  }
  return Object.keys(filters).length === 0 ? undefined : filters
}

/**
 * 这条结果是哪个能力的。
 *
 * 全部档的响应带 `groups`,按结果反查它落在哪一组;单类档没有 groups,那时**服务
 * 收下的那个档**就是答案。两条都不从 `result.id` 的前缀猜 —— 那个前缀是各能力
 * 自己起的(`msg:` / `chat:` / …),猜它等于在这里复活一张能力名表。
 */
function capabilityOf(
  resultId: string,
  response: { groups?: Array<{ capability: string; results: Array<{ id: string }> }> },
  requested: string | undefined,
): string {
  if (response.groups === undefined) return requested ?? ''
  for (const group of response.groups) {
    if (group.results.some(item => item.id === resultId)) return group.capability
  }
  return ''
}

/** 一路没搜成时兜底的那句话(错误对象拿不出话来时用)。 */
const SEARCH_FAILED = '这一类没搜成。'

/** 补一发用的那一趟查询(把 `service.query` 收窄成这一个形,便于单测递一个假的)。 */
type ServiceQuery = (
  request: SearchServiceRequest,
  context: Partial<SearchContext>,
) => Promise<SearchServiceResponse>

/**
 * **一组的补发**:同词、同 filters、同 limit,只多一格 `category`。
 *
 * 服务对单类档走的是 `singleCapabilityBudgetPolicy(limit)` —— 那一路吃满这次的
 * `limit`(≤ 20),不超过它在 all 档的自述配额,所以「补一发」补回来的不会比
 * 「不 defer 时它本来会答的」多。
 *
 * 失败的三种形归一种:抛(网络 / 超时 / abort)、`success:false`、以及服务自己在
 * 单类档把组级 error 提成整发失败(`singleResponse` 的判词)—— 对这只工具都是同
 * 一件事:**这一类没搜成**。它落在这一组的 `error` 上,别的组照常。
 */
async function askOneCapability(
  query: ServiceQuery,
  request: SearchServiceRequest,
  context: Partial<SearchContext>,
  group: SearchServiceGroup,
): Promise<SearchServiceGroup> {
  // `deferred` 就地脱掉:下面两条出路,一条是「答完了」,一条是「没搜成」,
  // 都不再是「这一次没问它」。
  const { deferred: _asked, ...rest } = group
  try {
    const answer = await query({ ...request, category: group.capability }, context)
    if (answer.success !== true) {
      return { ...rest, results: [], total: 0, error: answer.error ?? SEARCH_FAILED }
    }
    return {
      ...rest,
      results: answer.results,
      total: answer.total ?? answer.results.length,
      ...(answer.partial === true ? { partial: true } : {}),
    }
  } catch (error) {
    return { ...rest, results: [], total: 0, error: messageOf(error) }
  }
}

/**
 * 把总览里 `deferred` 的那几组各补一发,合回**同一个位置**。
 *
 * 组序不动(`groups.map`),扁平列表按合完之后的组序重拼再切到本次 `limit` ——
 * 与 `service.allResponse` 里那一刀逐字同一条规则,不是这里另发明的口径。没有
 * `groups`(单类档)或没有 defer 的组时**原样返回**:那时一发就是一发,连一次
 * 多余的 `query` 都不发。
 */
async function backfillDeferredGroups(
  query: ServiceQuery,
  response: SearchServiceResponse,
  request: SearchServiceRequest,
  context: Partial<SearchContext>,
  limit: number,
): Promise<SearchServiceResponse> {
  const groups = response.groups
  if (groups === undefined) return response
  const deferred = groups.filter(group => group.deferred === true)
  if (deferred.length === 0) return response

  const filled = new Map<string, SearchServiceGroup>()
  await Promise.all(deferred.map(async group => {
    filled.set(group.capability, await askOneCapability(query, request, context, group))
  }))

  const merged = groups.map(group => filled.get(group.capability) ?? group)
  return {
    ...response,
    groups: merged,
    results: merged.flatMap(group => group.results).slice(0, Math.max(0, limit)),
  }
}

/**
 * 末行那几格:**哪几类没答完**。
 *
 * 全部档问各组(合完之后的),单类档问整发那两格 —— 单类档没有 `groups`,而
 * 「这一类只扫到一半」在那时住 `response.partial`。`success:false` 在单类档就是
 * 「这一类没搜成」,照 §13.x 的判词说出来,不让它冒充「没有匹配」。
 */
function incompleteOf(
  response: SearchServiceResponse,
  requested: string | undefined,
): SearchToolIncomplete[] {
  const groups = response.groups
  if (groups === undefined) {
    if (requested === undefined) return []
    if (response.success !== true) return [{ capability: requested, reason: 'error' }]
    return response.partial === true ? [{ capability: requested, reason: 'partial' }] : []
  }
  return groups.flatMap((group): SearchToolIncomplete[] => {
    if (group.error !== undefined) return [{ capability: group.capability, reason: 'error' }]
    return group.partial === true ? [{ capability: group.capability, reason: 'partial' }] : []
  })
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : SEARCH_FAILED
}

export function createAppSearchToolAdapters(service: OnethingSearchService): SearchToolAdapters {
  const targets = new Map<string, Target>()

  const remember = (ref: string, target: Target | undefined): void => {
    if (target === undefined) return
    if (targets.size >= SEARCH_TARGET_MEMO_CAP) {
      const oldest = targets.keys().next()
      if (oldest.done !== true) targets.delete(oldest.value)
    }
    targets.set(ref, target)
  }

  return {
    /** 描述里那份清单 —— **问注册表**,不是一张写死的表(§14.4 的演练靠这一行成立)。 */
    listKinds: () => service.capabilities(AGENT_TOOL_SURFACE).map(manifest => manifest.id),

    async search(query: SearchToolQuery, principal: SearchToolPrincipal): Promise<SearchToolPage> {
      const filters = filtersOf(query)
      const request: SearchServiceRequest = {
        query: query.query,
        limit: query.limit,
        ...(query.capability === undefined ? {} : { category: query.capability }),
        ...(filters === undefined ? {} : { filters }),
      }
      const context = contextOf(principal, query.signal)
      const ask: ServiceQuery = (next, ctx) => service.query(next, ctx)
      const response = await backfillDeferredGroups(
        ask,
        await ask(request, context),
        request,
        context,
        query.limit,
      )
      const incomplete = incompleteOf(response, query.capability)

      const hits: SearchToolHit[] = response.results.map(result => {
        const capability = capabilityOf(result.id, response, query.capability)
        const ref = `${capability}:${result.id}`
        remember(ref, result.target)
        return {
          ref,
          capability,
          id: result.id,
          title: result.title,
          ...(result.subtitle === undefined ? {} : { subtitle: result.subtitle }),
          ...(result.timestamp === undefined ? {} : { time: result.timestamp }),
        }
      })

      return {
        hits,
        ...(response.total === undefined ? {} : { total: response.total }),
        ...(response.relaxed === undefined ? {} : { relaxed: response.relaxed }),
        ...(response.index === undefined ? {} : { pending: response.index.pending }),
        ...(incomplete.length === 0 ? {} : { incomplete }),
      }
    },

    async preview(ref, principal) {
      const at = ref.indexOf(':')
      if (at <= 0) throw new Error(`认不出这个结果号:${ref}`)
      const capability = ref.slice(0, at)
      const id = ref.slice(at + 1)
      const target = targets.get(ref)
      const payload = await service.preview([
        { capability, id, ...(target === undefined ? {} : { target }) },
      ], 'single', {}, contextOf(principal))
      return {
        kind: payload.kind,
        payload: payload.payload,
        ...(payload.title === undefined ? {} : { title: payload.title }),
      }
    },
  }
}
