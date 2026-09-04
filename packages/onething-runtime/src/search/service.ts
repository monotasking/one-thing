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
  type Candidate,
  type CapabilityManifest,
  type CapabilityRegistry,
  type FacetFilter,
  type GroupResult,
  type PreviewPayload,
  type RelaxLevel,
  type SearchCapability,
  type SearchContext,
  type SearchPrincipal,
} from '@onething/core/search'
import type { OnethingSearchProvidersAdapters } from './providers.js'
import { createBuiltinSearchCapabilities } from './capabilities/index.js'
import type { SearchIndexQueryFace } from './capabilities/indexed.js'
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
  /** 索引还在追账本吗(§8);S3b 起是真读数,由 `index.status()` 填。 */
  index?: { pending: number; stale: boolean }
  groups?: SearchServiceGroup[]
}

/**
 * 索引在干什么(§8 的 `status` 路由)。
 *
 * S3b 起这是**真读数**:`mode` 由 Worker 宿主答(连崩两次 → `'error'`),
 * `pending` 是队列里还欠着的钥匙数。`'reader'` 要等 §5.6(拍点庚,09-04 裁
 * 「先不做」),`vector` 要等 §15,两格今天分别不出现与恒 `'off'`。
 */
export interface SearchIndexStatus {
  mode: 'owner' | 'reader' | 'error'
  owner?: { host: string; pid: number }
  pending: number
  /**
   * 索引里现在有多少份文档(S3c)。**没有索引就缺席** —— 「问不出来」与「零条」不是
   * 一回事。
   *
   * 加它是因为「索引建完了没有」在外面**问不出来**:`pending` 只说此刻队列空不空,而
   * 冷建那一段里队列会反复空掉又填上,盯着它会在一个只折了一半的索引上答「建完了」
   * (`search:parity-B` 就是这么被咬到的)。文档数是**单调**的,「涨到不再涨」是外面能
   * 拿到的唯一诚实判据。契约层那一份的注释里有同一段话。
   */
  docs?: number
  vector?: 'off' | 'downloading' | 'embedding' | 'ready'
}

/**
 * 预览 / 动作请求里指一条结果(§4.5 ③;契约层 `SearchItemRef` 的同形件)。
 *
 * **`target` 是可选的**,但缺席时预览基本画不出来 —— 目标载荷才是「去哪儿取内容」
 * 的那一格。这里不替调用方补:壳手上一定有它(结果就是从 `search.query` 回来的),
 * 补一个空的只会让错误从「你没给 target」变成「那条消息不在账本里」。
 */
export interface SearchPreviewItem {
  capability: string
  id: string
  target?: { kind: string; payload: unknown }
}

/** 基数是请求的一部分(§4.5 ③)。 */
export type SearchPreviewMode = 'single' | 'compare' | 'batch'

/** 能力没有这个动作时的那句话;`invoke` 路由把它照抄给调用方。 */
export const NO_SUCH_ACTION = 'no such action'

/**
 * 一条 item → 一枚**只够用来定位**的候选。
 *
 * 预览与动作要的只有 `capability` / `id` / `target` 三格;`title` / `score` 这些是
 * 搜索那一趟的产物,请求里没有也不该由这一层去猜(补一个假 title 会顺着
 * `PreviewPayload.title` 显示到屏幕上)。所以这里给空串与 0 —— 空得**显眼**,
 * 而不是编一个像真的。
 */
function itemCandidate(item: SearchPreviewItem): Candidate {
  return {
    capability: item.capability,
    id: item.id,
    title: '',
    score: 0,
    target: item.target ?? { kind: '', payload: undefined },
  }
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
  private readonly index: SearchIndexQueryFace | undefined

  constructor(options: SearchServiceOptions & { index?: SearchIndexQueryFace } = {}) {
    this.registry = options.registry ?? createCapabilityRegistry()
    this.warn = options.warn
    this.now = options.now ?? (() => Date.now())
    this.index = options.index
  }

  /** 一行注册,返回注销(§4.3)。插件能力用的就是它。 */
  register(capability: SearchCapability): () => void {
    return this.registry.register(capability)
  }

  /**
   * 这份服务背后的索引问答面。
   *
   * server 那一侧按 owner 现装一份服务(取材面是 per-owner 的),但**索引是 store
   * 级的** —— 每个 owner 各建一个库既是浪费也是错(同一份账本折两遍)。所以那一侧
   * 从进程里已经装好的这份服务上取同一个面,而不是自己再起一条 Worker。
   */
  indexFace(): SearchIndexQueryFace | undefined {
    return this.index
  }

  /** 壳的 tab / 图标 / 过滤片 / 分组次序全从这里算(§4.3 / §9)。 */
  capabilities(surface?: string): CapabilityManifest[] {
    const manifests = this.registry.list().map(capability => capability.manifest)
    return surface === undefined
      ? manifests
      : manifests.filter(manifest => capabilityServesSurface(manifest, surface))
  }

  /**
   * §8 的 `status` 路由。没有索引面(单测里的裸服务)时如实答 `'error'` ——
   * 「没有索引」不是「索引空闲」。
   */
  async status(): Promise<SearchIndexStatus> {
    if (this.index === undefined) return { mode: 'error', pending: 0, vector: 'off' }
    const status = await this.index.status()
    return { mode: status.mode, pending: status.pending, docs: status.docs, vector: 'off' }
  }

  /**
   * 一次查询要不要在响应上带 `index` 那一格。`stale` = 「现在答的这一份还没追上
   * 账本」:队列里还欠着钥匙,或者启动校对还在跑。索引问不出来就**不带**这一格
   * (契约上缺席 = 不知道,不是「不 stale」)。
   */
  private async indexReport(): Promise<{ pending: number; stale: boolean } | undefined> {
    if (this.index === undefined) return undefined
    try {
      const status = await this.index.status()
      return { pending: status.pending, stale: status.pending > 0 || status.building }
    } catch {
      return undefined
    }
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

    const index = await this.indexReport()
    const response = single ? this.singleResponse(groups) : this.allResponse(groups, limit)
    return index === undefined ? response : { ...response, index }
  }

  /**
   * 这个档认不认 —— **问注册表**(§8)。不认识的归到「全部」,与旧路
   * `normalizeOnethingSearchCategory` 逐字同义(那时问的是一张写死的清单)。
   */
  private resolveCategory(requested: string | undefined): string {
    if (requested === undefined || requested === ALL_CAPABILITIES) return ALL_CAPABILITIES
    return this.registry.has(requested) ? requested : ALL_CAPABILITIES
  }

  /**
   * §8 的 `preview` 路由(S4a 起是真件)。
   *
   * **服务这一层不认识任何一种预览的形** —— 它只做三件事:把 item 翻回候选、
   * 问能力、按基数(§4.5 ③)组装。三种基数逐条:
   *
   *  | mode | 谁答 | 组装 |
   *  | --- | --- | --- |
   *  | `single`(缺省) | 该能力 `preview(候选)` | 原样 |
   *  | `compare` | 同 kind 且能力有 `compare?` → 它;否则两条各 `preview` | `composite{layout:'side-by-side'}` |
   *  | `batch` | 各条 `preview`(能失败,失败的那条不出) | `composite{layout:'grid'}` + 一行汇总 |
   *
   * `compare` 的「同 kind」判据在这一层,不在能力里 —— 能力不知道「多选」这回事
   * (§4.5 ③末句),它只被问「给我这一条(或这两条)的预览」。
   *
   * 能力没有 `preview` = **结构化拒绝**,不是空预览:自述里没说有预览的能力被问到,
   * 那是调用方问错了地方,不是「这一条恰好没有内容」。
   */
  async preview(items: readonly SearchPreviewItem[], mode: SearchPreviewMode = 'single'): Promise<PreviewPayload> {
    if (items.length === 0) throw new Error('没有指定要预览哪一条')
    if (mode === 'compare') return await this.comparePreview(items)
    if (mode === 'batch') return await this.batchPreview(items)
    return await this.previewOne(items[0])
  }

  /**
   * §8 的 `invoke` 路由(S4a 接通)。
   *
   * **本批没有任何一个能力声明动作**,所以这条路今天恒走「没有这个动作」那一支 ——
   * 接通它的理由与 S0 立形同源:动作的落点从此在服务层,加一个动作是能力自己多写
   * 一格 `invoke`,不是壳里多一条 if。
   *
   * 一次 `invoke` 只问**一个**能力(`SearchInvokeRequest.capability`):动作是能力
   * 自己的词汇表,跨能力的「同一个动作」并不存在。
   */
  async invoke(
    capabilityId: string,
    actionId: string,
    items: readonly SearchPreviewItem[],
    context: Partial<SearchContext> = {},
  ): Promise<void> {
    const capability = this.registry.get(capabilityId)
    if (capability === undefined) throw new Error(`no such capability: ${capabilityId}`)
    if (capability.invoke === undefined) throw new Error(NO_SUCH_ACTION)
    await capability.invoke(actionId, items.map(itemCandidate), createSearchContext(context))
  }

  /** 一条 item → 它那个能力的预览。 */
  private async previewOne(item: SearchPreviewItem): Promise<PreviewPayload> {
    const capability = this.registry.get(item.capability)
    if (capability === undefined) throw new Error(`no such capability: ${item.capability}`)
    if (capability.preview === undefined) {
      throw new Error(`capability ${item.capability} has no preview`)
    }
    return await capability.preview([itemCandidate(item)], createSearchContext())
  }

  private async comparePreview(items: readonly SearchPreviewItem[]): Promise<PreviewPayload> {
    const [a, b] = items
    if (b === undefined) return await this.previewOne(a)
    // 能力自己给的 `compare` 只在**同一个能力、同一种 kind**时才问得着:diff 一条
    // 消息和一个文件没有意义,而「可比」的判据(§4.5 ③)是壳与这一层的事。
    if (a.capability === b.capability && a.target?.kind === b.target?.kind) {
      const capability = this.registry.get(a.capability)
      if (capability?.compare !== undefined) {
        return await capability.compare(itemCandidate(a), itemCandidate(b), createSearchContext())
      }
    }
    const both = await Promise.all([this.previewOne(a), this.previewOne(b)])
    return { kind: 'composite', payload: { layout: 'side-by-side', items: both } }
  }

  /**
   * N > 2 条:各自预览 + 一段汇总(§4.5 ③ batch 那一行)。
   *
   * 算不出的那几条**不让整批塌掉** —— batch 的语义是「这一堆大概是些什么」,
   * 一条读不到文件不该把另外九条也吞了。汇总里如实报「几条没画出来」。
   */
  private async batchPreview(items: readonly SearchPreviewItem[]): Promise<PreviewPayload> {
    const settled = await Promise.all(
      items.map(item => this.previewOne(item).then(payload => payload, () => undefined)),
    )
    const previews = settled.filter((payload): payload is PreviewPayload => payload !== undefined)
    const kinds = [...new Set(previews.map(payload => payload.kind))]
    return {
      kind: 'composite',
      payload: {
        layout: 'grid',
        items: previews,
        summary: { total: items.length, shown: previews.length, kinds },
      },
    }
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
 *
 * **索引面是必填的**(S3b):messages / chats / daily 三路已经是索引型,没有索引
 * 就没有这三类结果 —— 而不是「悄悄退回旧扫描」(§13 留账那一条:旧扫描 S5 会删,
 * 这里不许再长出第二条路)。索引是 **store 级**的:桌面与回环 server 各装一份服务却传
 * 同一份索引。**按 owner 沙箱化的那一支例外** —— 索引文档上没有 owner 这一格,共用即串
 * owner,所以 `server/runtime.ts` 的不可信端口传的是 `unavailableIndexFace()`(如实答
 * 「这台宿主没有索引」),而不是共用一份库再指望以后补过滤。
 */
export function createOnethingSearchService(
  adapters: OnethingSearchProvidersAdapters,
  options: SearchServiceOptions & { index: SearchIndexQueryFace },
): OnethingSearchService {
  const service = new OnethingSearchService(options)
  for (const capability of createBuiltinSearchCapabilities(adapters, options.index)) {
    service.register(capability)
  }
  return service
}
