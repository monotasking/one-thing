/**
 * 授权是查询的**输入**,不是结果的过滤。
 *
 * 设计:docs/design/search-index-2026-09.md §6.4b
 *
 * v3 把授权写成 fanout 之后对每条候选跑一遍 `(principal, candidate) => boolean`。
 * 那是结果过滤:能力按 limit=20 查回 20 条、滤掉 15 条,壳拿到 5 条却带着「还有下一页」
 * 的 cursor,`total` 也是滤前的数 —— 三格全在说谎。
 *
 * 改法:manifest 的 `visibility` 是 `principal → 范围`,**fanout 在调 `search()` 之前**
 * 把范围塞进 `SearchQuery.filters`,能力在自己的查询里用(SqliteIndex 就是 WHERE 子句),
 * 于是 total / cursor / relaxed 都是授权之后的真数。
 *
 * 这里还留一段 `assertAuthorized` 兜底:对回来的候选再跑一次范围判断,漏网的丢掉并
 * 经注入的 `warn` 报出来。它**不承担正确性** —— 它是「能力实现有 bug」的证据。
 */

import type { Candidate, FacetFilter, SearchPage, SearchPrincipal, SearchQuery } from '../candidate.js'
import type { CapabilityManifest, VisibilityScope } from '../capability.js'
import { matchesFacetFilter } from '../index/types.js'

export type AuthorizationWarn = (message: string, detail: Record<string, unknown>) => void

/** 没声明 visibility = 全可见(§4.1b 缺省)。 */
export function visibilityScopeOf(
  manifest: CapabilityManifest,
  principal: SearchPrincipal,
): VisibilityScope {
  return manifest.visibility === undefined ? {} : manifest.visibility(principal)
}

/**
 * 范围进 filters。**范围赢** —— 调用方手打的过滤片不许把授权放宽。
 *
 * 「赢」的实现是**取交集**,不是覆盖(S6 改)。两者在「调用方想放宽」那一形上同解,
 * 但在「调用方想再收窄一点」那一形上不同,而后者是真实存在的:`search` 工具的
 * `scope: 'session'` 落成 `{ sessionId: '<本会话>' }`,而 agent 的可见范围也落在
 * **同一个键**上(`{ sessionId: [...允许的...] }`)。覆盖会把那次收窄整个抹掉 ——
 * 结果不是越权(仍在允许清单里),而是**它没照做**:模型说「只看这一条」,回来的是
 * 「你能看的全部」。交集两件事一起满足,而且永远不会比 scope 宽。
 *
 * 交集只在**表达得出来**的两形上做(允许清单 × 标量、允许清单 × 允许清单);其余
 * 组合(区间、`not`)退回覆盖 —— 那是今天的行为,也仍然不放宽。
 */
export function applyVisibility(query: SearchQuery, scope: VisibilityScope): SearchQuery {
  if (Object.keys(scope).length === 0) return query
  const filters = { ...query.filters }
  for (const [key, allowed] of Object.entries(scope)) {
    filters[key] = intersectFilter(query.filters[key], allowed)
  }
  return { ...query, filters }
}

/**
 * 允许范围 ∩ 调用方要求。答不出交集时给允许范围(不放宽)。
 *
 * 空数组是一个**能被表达**的答案:「一条都不符合」。两侧(core 的
 * `matchesFacetFilter` 与 SqliteIndex 的 `facetClause`)对空数组都是恒不命中。
 */
function intersectFilter(requested: FacetFilter | undefined, allowed: FacetFilter): FacetFilter {
  if (requested === undefined) return allowed
  if (!Array.isArray(allowed)) return allowed

  if (Array.isArray(requested)) {
    return requested.filter(value => allowed.includes(value))
  }
  if (typeof requested === 'object' && requested !== null) return allowed
  return allowed.includes(requested) ? requested : []
}

export interface AuthorizationResult {
  page: SearchPage
  leaked: Candidate[]
}

/**
 * 兜底核验。判不了的不丢:候选没声明这一格 facet 时,core 没有第二个信息源可问,
 * 丢掉它只会把「能力没填 facet」变成「结果凭空少了」。丢掉的会连 total 一起改小,
 * 免得再造出一个假数。
 */
export function assertAuthorized(
  page: SearchPage,
  scope: VisibilityScope,
  options: { capability: string; warn?: AuthorizationWarn } ,
): AuthorizationResult {
  const keys = Object.keys(scope)
  if (keys.length === 0) return { page, leaked: [] }

  const kept: Candidate[] = []
  const leaked: Candidate[] = []

  for (const candidate of page.items) {
    const facets = candidate.facets
    const escaped = facets !== undefined && keys.some(key =>
      facets[key] !== undefined && !matchesFacetFilter(facets[key], scope[key]!))
    if (escaped) leaked.push(candidate)
    else kept.push(candidate)
  }

  if (leaked.length === 0) return { page, leaked }

  options.warn?.('search candidate escaped its visibility scope', {
    capability: options.capability,
    dropped: leaked.length,
    ids: leaked.map(candidate => candidate.id),
  })

  return {
    page: {
      ...page,
      items: kept,
      total: page.total === undefined ? undefined : Math.max(0, page.total - leaked.length),
    },
    leaked,
  }
}
