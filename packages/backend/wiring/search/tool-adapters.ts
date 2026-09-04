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
 */

import type { FacetFilter, SearchContext, SearchPrincipal } from '@onething/core/search'
import type { OnethingSearchService, SearchServiceRequest } from '@onething/runtime/search'
import type {
  SearchToolAdapters,
  SearchToolHit,
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

function contextOf(principal: SearchToolPrincipal): Partial<SearchContext> {
  return {
    principal: searchPrincipalOf(principal),
    surface: AGENT_TOOL_SURFACE,
    spaceId: principal.spaceId,
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
      const response = await service.query(request, contextOf(principal))

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
      }
    },

    async preview(ref) {
      const at = ref.indexOf(':')
      if (at <= 0) throw new Error(`认不出这个结果号:${ref}`)
      const capability = ref.slice(0, at)
      const id = ref.slice(at + 1)
      const target = targets.get(ref)
      const payload = await service.preview([
        { capability, id, ...(target === undefined ? {} : { target }) },
      ])
      return {
        kind: payload.kind,
        payload: payload.payload,
        ...(payload.title === undefined ? {} : { title: payload.title }),
      }
    },
  }
}
