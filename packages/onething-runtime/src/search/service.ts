/**
 * `SearchService` —— 注册表 + 流水线 + (S3 起)索引 的门面。
 *
 * 设计:docs/design/search-index-2026-09.md §3 落位表最后一行 / §7 全部档与分页 /
 * §8 契约 / §10 S2 行。
 *
 * 一句话:**它自己不认识任何一类能搜的东西。** 它做的全部是「读注册表然后算」:
 *
 *  - 哪一档由谁答 —— `query.capability`(单类)或 `supports`(全部档),`fanout` 判;
 *  - 每一路给多少条 —— `budgetPolicy` 读各 manifest 的 `budget`(§7.1);
 *  - 组与组的先后 —— `createGroupMerge` 读各 manifest 的 `order` / `orderWhenIntent`(§7.2);
 *  - 这个 `category` 认不认 —— **问注册表**,不问一张字面量清单(§8「`isSearchCategory`
 *    改问 registry」)。不认识的归到「全部」,与旧路 `normalizeOnethingSearchCategory`
 *    同义。
 *
 * 两档的输出形(§7.2 / §8):
 *
 *  | 档 | `results` | `groups` | `total` / `cursor` |
 *  | --- | --- | --- | --- |
 *  | 单类 | 本页 | 缺席 | 能力知道就给 |
 *  | 全部 | 各组按 order 拼接,再切到 `limit` | 真值 | 缺席(总览不分页) |
 *
 * 「全部档 `results` 切到 `limit`」是旧路 `ordered.slice(0, limit)` 那一刀,保旧壳。
 */

import {
  ALL_CAPABILITIES,
  budgetPolicy as defaultBudgetPolicy,
  collectGroups,
  capabilityServesSurface,
  compose,
  createCapabilityRegistry,
  singleCapabilityBudgetPolicy,
  type CapabilityManifest,
  type CapabilityRegistry,
  type FacetFilter,
  type GroupResult,
  type RelaxLevel,
  type SearchCapability,
  type SearchContext,
  type SearchPrincipal,
} from '@onething/core/search'
import type { OnethingSearchProvidersAdapters } from './providers.js'
import { createBuiltinSearchCapabilities } from './capabilities/index.js'
import { searchResultOf, type SearchServiceResult } from './capabilities/legacy.js'

/** 旧路 `executeOnethingSearch` 的缺省页大小;换个名字,数没变。 */
export const DEFAULT_SEARCH_LIMIT = 20

/** 没人说消费面时按命令面板算(今天唯一的消费面)。 */
export const DEFAULT_SEARCH_SURFACE = 'palette'

export interface SearchServiceRequest {
  query: string
  /** 能力 id 或 `'all'`;不认识的归到 `'all'`。 */
  category?: string
  limit?: number
  cursor?: string
  filters?: Record<string, FacetFilter>
}

export interface SearchServiceGroup {
  capability: string
  label: string
  total?: number
  results: SearchServiceResult[]
  error?: string
}

export interface SearchServiceResponse {
  success: boolean
  results: SearchServiceResult[]
  total?: number
  cursor?: string
  relaxed?: RelaxLevel
  groups?: SearchServiceGroup[]
}

/**
 * 索引在干什么(§8 的 `status` 路由)。S3 之前没有索引,所以恒
 * `{ mode:'owner', pending:0, vector:'off' }` —— `mode` 那一格的另外两个取值要等
 * §5.6(拍点庚,09-04 裁「先不做」)与 §15。
 */
export interface SearchIndexStatus {
  mode: 'owner' | 'reader' | 'error'
  owner?: { host: string; pid: number }
  pending: number
  vector?: 'off' | 'downloading' | 'embedding' | 'ready'
}

export interface SearchServiceOptions {
  registry?: CapabilityRegistry
  /** 候选逃出可见范围时的报警口(§6.4b 的兜底核验)。 */
  warn?: (message: string, detail: Record<string, unknown>) => void
  now?: () => number
}

const DEFAULT_PRINCIPAL: SearchPrincipal = { kind: 'user', id: 'local' }

/** 补齐一次搜索的现场:调用方只说它知道的那几格。 */
export function createSearchContext(partial: Partial<SearchContext> = {}): SearchContext {
  return {
    principal: partial.principal ?? DEFAULT_PRINCIPAL,
    surface: partial.surface ?? DEFAULT_SEARCH_SURFACE,
    spaceId: partial.spaceId ?? '',
    signal: partial.signal ?? new AbortController().signal,
    debug: partial.debug,
    now: partial.now ?? Date.now(),
  }
}

export class OnethingSearchService {
  readonly registry: CapabilityRegistry
  private readonly warn: SearchServiceOptions['warn']
  private readonly now: () => number

  constructor(options: SearchServiceOptions = {}) {
    this.registry = options.registry ?? createCapabilityRegistry()
    this.warn = options.warn
    this.now = options.now ?? (() => Date.now())
  }

  /** 一行注册,返回注销(§4.3)。插件能力用的就是它。 */
  register(capability: SearchCapability): () => void {
    return this.registry.register(capability)
  }

  /** 壳的 tab / 图标 / 过滤片 / 分组次序全从这里算(§4.3 / §9)。 */
  capabilities(surface?: string): CapabilityManifest[] {
    const manifests = this.registry.list().map(capability => capability.manifest)
    return surface === undefined
      ? manifests
      : manifests.filter(manifest => capabilityServesSurface(manifest, surface))
  }

  status(): SearchIndexStatus {
    return { mode: 'owner', pending: 0, vector: 'off' }
  }

  async query(
    request: SearchServiceRequest,
    context: Partial<SearchContext> = {},
  ): Promise<SearchServiceResponse> {
    const ctx = createSearchContext(context)
    const limit = request.limit ?? DEFAULT_SEARCH_LIMIT
    const category = this.resolveCategory(request.category)
    const single = category !== ALL_CAPABILITIES

    const pipeline = compose({
      registry: this.registry,
      // 单类档:这一路吃满页大小(旧路 `adapters.searchX(query, limit)` 那一刀);
      // 全部档:各 manifest 自己的配额(旧路那张写死的 6/5/10/6/6/4|8 表)。
      budgets: single ? singleCapabilityBudgetPolicy(limit) : defaultBudgetPolicy,
      warn: this.warn,
      now: this.now,
    })

    const runOptions = {
      capability: category,
      filters: request.filters,
      // 全部档不带游标(§7.2 不分页)。
      ...(single ? { page: { limit, cursor: request.cursor } } : {}),
    }
    const query = pipeline.compile(request.query, ctx, runOptions)
    const groups = await collectGroups(
      pipeline.searchQuery(query, ctx, runOptions),
      { registry: this.registry, intent: query.intent, capability: category },
    )

    return single ? this.singleResponse(groups) : this.allResponse(groups, limit)
  }

  /**
   * 这个档认不认 —— **问注册表**(§8)。不认识的归到「全部」,与旧路
   * `normalizeOnethingSearchCategory` 逐字同义(那时问的是一张写死的清单)。
   */
  private resolveCategory(requested: string | undefined): string {
    if (requested === undefined || requested === ALL_CAPABILITIES) return ALL_CAPABILITIES
    return this.registry.has(requested) ? requested : ALL_CAPABILITIES
  }

  private singleResponse(groups: readonly GroupResult[]): SearchServiceResponse {
    const group = groups[0]
    const page = group?.page
    return {
      success: true,
      results: (page?.items ?? []).map(searchResultOf),
      total: page?.total,
      cursor: page?.cursor,
      relaxed: page?.relaxed,
    }
  }

  private allResponse(groups: readonly GroupResult[], limit: number): SearchServiceResponse {
    const labels = new Map(
      this.registry.list().map(capability => [capability.manifest.id, capability.manifest.labelKey]),
    )
    const projected: SearchServiceGroup[] = groups.map(group => ({
      capability: group.capability,
      label: labels.get(group.capability) ?? group.capability,
      total: group.page?.total,
      results: (group.page?.items ?? []).map(searchResultOf),
      error: group.error,
    }))
    return {
      success: true,
      // 旧路那一刀:各组按 order 拼接之后切到本档的页大小。
      results: projected.flatMap(group => group.results).slice(0, Math.max(0, limit)),
      groups: projected,
    }
  }
}

/**
 * 装上六个内置能力的服务。桌面装一份(进程单例,见 `service-bound.ts`),
 * server 按请求上下文各装一份(它的会话 / 文件 / 提示词表是 per-owner 的)。
 */
export function createOnethingSearchService(
  adapters: OnethingSearchProvidersAdapters,
  options: SearchServiceOptions = {},
): OnethingSearchService {
  const service = new OnethingSearchService(options)
  for (const capability of createBuiltinSearchCapabilities(adapters)) {
    service.register(capability)
  }
  return service
}
