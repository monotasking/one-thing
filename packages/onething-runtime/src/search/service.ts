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
 *    改问 registry」)。不认识的归到「全部」。S5 起那张写死的清单已经不存在:
 *    能搜的东西 = 注册表里的行。
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
  type ActionDescriptor,
  type Candidate,
  type CapabilityManifest,
  type CapabilityRegistry,
  type FacetFilter,
  type GroupResult,
  type PreviewOptions,
  type PreviewPayload,
  type RelaxLevel,
  type SearchCapability,
  type SearchContext,
  type SearchPrincipal,
  type SearchQuery,
} from '@onething/core/search'
import type { OnethingSearchProvidersAdapters } from './providers.js'
import { createBuiltinSearchCapabilities } from './capabilities/index.js'
import type { SearchIndexQueryFace } from './capabilities/indexed.js'
import type { ModelStatus } from './index/model-download.js'
import type { IndexStorage } from './index/worker-core.js'
import { searchResultOf, type SearchServiceResult } from './capabilities/scan-adapter.js'

/** 命令面板一页给多少条(旧路那个缺省值,数没变)。 */
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
  /**
   * **这一块的下一页**(检索面终稿 §0 ②)。从前 `allResponse` 把各能力答出来的
   * `page.cursor` 整个丢掉,于是全部档只能靠换整把查询键重发才翻得动 —— 那正是
   * 「Load more 跳回顶部」的病根。原样回传给 `{ category: 这一块, cursor }` 就是
   * 这一块的第二页。缺席 = 这一块取尽了。
   */
  cursor?: string
  /** 这一块零命中后放宽了几级(0 = 没放宽)。 */
  relaxed?: RelaxLevel
  /** 这一块自报的动作(不在 `results` 里、不计进 `total`)。 */
  actions?: SearchServiceAction[]
  /**
   * **这一块这一次没问**(09-07 事故第二条修;core 的 `GroupResult.deferred`)。
   *
   * 「不挑」那一档不等去外部枚举的那几路。调用方要么单独去问一次这一档
   * (壳就是这么做的:随即发一发单类请求,落地补进这一块),要么如实说这次没参与。
   * `results` 恒空、`total` 恒 0 —— 它们说的不是「一条都没有」,而是「还没问」,
   * 这两件事由这一格分开。
   */
  deferred?: boolean
  /** 这一块只扫到一半(预算到点交的部分);缺席 = 这一页是完整的。 */
  partial?: boolean
}

/**
 * 一个动作的**线上形**(契约层 `SearchActionDescriptor` 的同形件)。
 *
 * 与 core 的 `ActionDescriptor` **同形不同命**:那一份带 `label`(能力自己写的
 * 成品文案),这一份只带 `labelKey + params`(R12:给人看的句子由壳按键查出)。
 * 投影在 `actionDto` 那一个纯函数里,别处不许再拼一份。
 */
export interface SearchServiceAction {
  id: string
  labelKey: string
  icon?: string
  danger?: boolean
  capability?: string
  kind?: string
  payload?: unknown
  params?: Record<string, string | number>
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
  /**
   * **页级动作**(§0 ③「动作不是结果」)。全部档 = 各组动作按组序拼起来;
   * 单类档 = 那一组的。缺席 = 这一次没有动作可做。
   */
  actions?: SearchServiceAction[]
  /**
   * 整发失败的结构化说法。`success:false` 只说了「没成」;这一格说「为什么」,
   * 壳按它查字典画一句人话(R12),原话进日志。
   */
  error?: string
  /** 单类档:这一页只扫到一半(预算到点交的部分);缺席 = 完整的一页。 */
  partial?: boolean
}

/**
 * 索引在干什么(§8 的 `status` 路由)。
 *
 * S3b 起这是**真读数**:`mode` 由 Worker 宿主答(连崩两次 → `'error'`),
 * `pending` 是队列里还欠着的钥匙数。`'reader'` 要等 §5.6(拍点庚,09-04 裁
 * 「先不做」),今天不出现。**S7 起 `vector` 三格也是真读数**(§15)。
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
  /**
   * 语义召回此刻在干什么(§15;`'off'` = 开关关着 / 装不上扩展 / 自己关回去了)。
   */
  vector?: 'off' | 'downloading' | 'embedding' | 'ready'
  /** 还有几份文档没嵌进去(与 `pending` 同一种诚实,只是另一半派生数据)。 */
  vectorPending?: number
  /**
   * **这份产物装得上 sqlite-vec 扩展吗** —— 与「开关开没开」是两件事。
   *
   * 它存在的理由只有一个:`gate:packaged` 要在**开关关着**的默认档上证明
   * 「`asarUnpack` 那一行没漏」。等到用户去设置里打开才发现装不上,那就晚了。
   */
  vectorExtension?: 'loadable' | 'missing'
  /**
   * `vector === 'off'` 是因为**它自己关回去了**时,那一句原因(2026-09-17;契约只加)。
   * 缺席 = 「没关过 / 没开过」,不是「没出错」。契约层那一份的注释里有同一段话。
   */
  vectorError?: string
  /** 那句原因属于哪一类(R12;与 `vectorError` 同生同灭,判据在 `vector-writer.ts`)。 */
  vectorErrorKind?: 'network' | 'runtime' | 'model' | 'unknown'
  /**
   * **嵌入模型这件东西自己的状态**(2026-09-17)。与 `vector` 那一格是两件事:
   * 那一格说「语义召回在干什么」(要开关开着才有意义),这一格说「这台机器上有没有
   * 那份模型、下到哪儿了」——**开关关着时它照样说得出话**。
   *
   * 这台宿主管不了模型(没有索引 / 假嵌入器)时缺席。
   */
  model?: SearchSemanticModelStatus
}

/**
 * 嵌入模型此刻的样子。**形与 Worker 那一侧的 `ModelStatus` 逐格相同** —— 这里不
 * 重新发明,直接引它:两份同形的东西在两个包里各写一遍,迟早漂开。
 */
export type SearchSemanticModelStatus = ModelStatus

/**
 * **检索占了多少地方**(2026-09-18)。同上一条判例:形与 Worker 那一侧的
 * `IndexStorage` 逐格相同,所以直接引它,不在这里再写一遍。
 */
export type SearchStorageReport = IndexStorage

/** 这台宿主管不了模型时,那三个动作的答复。 */
export const SEMANTIC_MODEL_UNAVAILABLE_ERROR = 'semantic model management is not available on this host'

/** 这台宿主答不出「占了多少地方」时的那一句(没有索引 —— 那就没有地方可占)。 */
export const SEARCH_STORAGE_UNAVAILABLE_ERROR = 'search storage is not measurable on this host'

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
 * **这个能力自述里就没有预览**(检索面终稿 R6)。
 *
 * 与「有预览但这一条算不出」(`PreviewUnavailableError`)是两件事:前者是调用方
 * 问错了地方,后者是这一条恰好画不出来。分成两个类型是为了让路由层能把它折成
 * `reason: 'no-preview'` —— 壳据此画「行的放大版」而不是一句错误。
 */
export class NoPreviewError extends Error {
  readonly capability: string

  constructor(capability: string) {
    super(`capability ${capability} has no preview`)
    this.name = 'NoPreviewError'
    this.capability = capability
  }
}

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
  authorization?: {
    query(capability: string, query: SearchQuery, context: SearchContext): SearchQuery | Promise<SearchQuery>
    targets(capability: string, items: readonly SearchPreviewItem[], context: SearchContext, actionId?: string): void | Promise<void>
  }
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
    executionContext: partial.executionContext,
    surface: partial.surface ?? DEFAULT_SEARCH_SURFACE,
    spaceId: partial.spaceId ?? '',
    signal: partial.signal ?? new AbortController().signal,
    debug: partial.debug,
    now: partial.now ?? Date.now(),
  }
}

export class OnethingSearchService {
  private readonly authorization: SearchServiceOptions['authorization']
  readonly registry: CapabilityRegistry
  private readonly warn: SearchServiceOptions['warn']
  private readonly now: () => number
  private readonly index: SearchIndexQueryFace | undefined

  constructor(options: SearchServiceOptions & { index?: SearchIndexQueryFace } = {}) {
    this.authorization = options.authorization
    this.registry = options.registry ?? createCapabilityRegistry()
    this.warn = options.warn
    this.now = options.now ?? (() => Date.now())
    this.index = options.index
  }

  /** 一行注册,返回注销(§4.3)。插件能力用的就是它。 */
  register(capability: SearchCapability): () => void {
    const authorization = this.authorization
    if (!authorization) return this.registry.register(capability)
    return this.registry.register({
      ...capability,
      search: async (query, page, context) => capability.search(
        await authorization.query(capability.manifest.id, query, context), page, context,
      ),
    })
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
    return {
      mode: status.mode,
      pending: status.pending,
      docs: status.docs,
      vector: status.vector,
      vectorPending: status.vectorPending,
      vectorExtension: status.vectorExtension,
      ...(status.vectorError !== undefined ? { vectorError: status.vectorError } : {}),
      ...(status.vectorErrorKind !== undefined ? { vectorErrorKind: status.vectorErrorKind } : {}),
      ...(status.model !== undefined ? { model: status.model } : {}),
    }
  }

  /**
   * **检索占了多少地方**(2026-09-18;`search` 域那条 `storage` 路由的落点)。
   *
   * 与 `semanticModel` 同一条落位判据:这台进程里「索引是哪一份」已经有唯一答案
   * (这份服务手上的 `indexFace()`),不再立第二个产地。
   *
   * 没有索引就**结构化拒绝**,不答一堆零 —— 屏幕上「没量出来」与「0 MB」是两句
   * 完全不同的话(而且这台机器上很可能压根没有那个库)。
   */
  async storage(): Promise<SearchStorageReport> {
    const measure = this.index?.storage
    if (this.index === undefined || measure === undefined) {
      throw new Error(SEARCH_STORAGE_UNAVAILABLE_ERROR)
    }
    return await measure.call(this.index)
  }

  /**
   * 嵌入模型的三个动作(2026-09-17;`search` 域那三条路由的落点)。
   *
   * **为什么挂在服务上而不是开一条新端口**:这台进程里「索引是哪一份」这件事已经
   * 有唯一答案了 —— 就是这份服务手上的 `indexFace()`,`status()` 读的也是它。
   * 再立一个进程单槽就是第二份真相(而且 `assembly:gate` 立着的那条规矩正是
   * 「装配层不许再长模块级状态」)。
   *
   * 这台宿主管不了模型时**结构化拒绝**:没有索引(`unavailableIndexFace`)、或者
   * 这条 Worker 的嵌入器根本没有可下的模型(假嵌入器),都走这一句。
   */
  async semanticModel(op: 'download' | 'cancel' | 'remove'): Promise<SearchSemanticModelStatus> {
    const index = this.index
    if (index === undefined) throw new Error(SEMANTIC_MODEL_UNAVAILABLE_ERROR)
    switch (op) {
      case 'download': {
        if (index.downloadModel === undefined) throw new Error(SEMANTIC_MODEL_UNAVAILABLE_ERROR)
        return await index.downloadModel()
      }
      case 'cancel': {
        if (index.cancelModelDownload === undefined) throw new Error(SEMANTIC_MODEL_UNAVAILABLE_ERROR)
        return await index.cancelModelDownload()
      }
      case 'remove': {
        if (index.removeModel === undefined) throw new Error(SEMANTIC_MODEL_UNAVAILABLE_ERROR)
        return await index.removeModel()
      }
    }
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
   * S5 之前那只 `normalizeOnethingSearchCategory` 逐字同义 —— 差别只是它问的是一张写死的清单,这里问注册表。
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
  async preview(
    items: readonly SearchPreviewItem[],
    mode: SearchPreviewMode = 'single',
    options: PreviewOptions = {},
    context: Partial<SearchContext> = {},
  ): Promise<PreviewPayload> {
    const ctx = createSearchContext(context)
    // Validate the complete batch before any provider reads a body.
    for (const item of items) await this.authorization?.targets(item.capability, [item], ctx)
    if (items.length === 0) throw new Error('没有指定要预览哪一条')
    if (mode === 'compare') return await this.comparePreview(items, options, ctx)
    if (mode === 'batch') return await this.batchPreview(items, options, ctx)
    return await this.previewOne(items[0], options, ctx)
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
    const ctx = createSearchContext(context)
    await this.authorization?.targets(capabilityId, items, ctx, actionId)
    const capability = this.registry.get(capabilityId)
    if (capability === undefined) throw new Error(`no such capability: ${capabilityId}`)
    if (capability.invoke === undefined) throw new Error(NO_SUCH_ACTION)
    await capability.invoke(actionId, items.map(itemCandidate), ctx)
  }

  /** 一条 item → 它那个能力的预览。`options` 里那格查询词原样递下去(高亮同产地)。 */
  private async previewOne(
    item: SearchPreviewItem,
    options: PreviewOptions = {},
    context: SearchContext = createSearchContext(),
  ): Promise<PreviewPayload> {
    const capability = this.registry.get(item.capability)
    if (capability === undefined) throw new Error(`no such capability: ${item.capability}`)
    if (capability.preview === undefined) {
      throw new NoPreviewError(item.capability)
    }
    return await capability.preview([itemCandidate(item)], context, options)
  }

  private async comparePreview(
    items: readonly SearchPreviewItem[],
    options: PreviewOptions = {},
    context: SearchContext = createSearchContext(),
  ): Promise<PreviewPayload> {
    const [a, b] = items
    if (b === undefined) return await this.previewOne(a, options, context)
    // 能力自己给的 `compare` 只在**同一个能力、同一种 kind**时才问得着:diff 一条
    // 消息和一个文件没有意义,而「可比」的判据(§4.5 ③)是壳与这一层的事。
    if (a.capability === b.capability && a.target?.kind === b.target?.kind) {
      const capability = this.registry.get(a.capability)
      if (capability?.compare !== undefined) {
        return await capability.compare(itemCandidate(a), itemCandidate(b), context)
      }
    }
    const both = await Promise.all([this.previewOne(a, options, context), this.previewOne(b, options, context)])
    return { kind: 'composite', payload: { layout: 'side-by-side', items: both } }
  }

  /**
   * N > 2 条:各自预览 + 一段汇总(§4.5 ③ batch 那一行)。
   *
   * 算不出的那几条**不让整批塌掉** —— batch 的语义是「这一堆大概是些什么」,
   * 一条读不到文件不该把另外九条也吞了。汇总里如实报「几条没画出来」。
   */
  private async batchPreview(
    items: readonly SearchPreviewItem[],
    options: PreviewOptions = {},
    context: SearchContext = createSearchContext(),
  ): Promise<PreviewPayload> {
    const settled = await Promise.all(
      items.map(item => this.previewOne(item, options, context).then(payload => payload, () => undefined)),
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

  /**
   * core 的 `ActionDescriptor` → 线上形。`labelKey` 缺席时退到 `label`、再退到 `id`
   * —— 画一个 id 比画一个空按钮诚实(与 `previewDto` 那条判例逐字同源)。
   */
  private static actionDto(action: ActionDescriptor): SearchServiceAction {
    return {
      id: action.id,
      labelKey: action.labelKey ?? action.label ?? action.id,
      ...(action.danger === undefined ? {} : { danger: action.danger }),
      ...(action.capability === undefined ? {} : { capability: action.capability }),
      ...(action.kind === undefined ? {} : { kind: action.kind }),
      ...(action.payload === undefined ? {} : { payload: action.payload }),
      ...(action.params === undefined ? {} : { params: action.params }),
    }
  }

  /**
   * 单类档。**组带 error 时整发算失败**(检索面终稿 §4):单类档只有一组,那一组
   * 塌了就是这一次什么都没搜到 —— 从前它答 `success:true` 配零条结果,屏上画出来
   * 的是「没有匹配的结果」,而真相是「这一类没搜成」。两件事不能画成一件。
   */
  private singleResponse(groups: readonly GroupResult[]): SearchServiceResponse {
    const group = groups[0]
    if (group?.error !== undefined) return { success: false, results: [], error: group.error }
    const page = group?.page
    const actions = (page?.actions ?? []).map(OnethingSearchService.actionDto)
    return {
      success: true,
      results: (page?.items ?? []).map(searchResultOf),
      total: page?.total,
      cursor: page?.cursor,
      relaxed: page?.relaxed,
      ...(page?.partial === true ? { partial: true } : {}),
      ...(actions.length === 0 ? {} : { actions }),
    }
  }

  private allResponse(groups: readonly GroupResult[], limit: number): SearchServiceResponse {
    const labels = new Map(
      this.registry.list().map(capability => [capability.manifest.id, capability.manifest.labelKey]),
    )
    const projected: SearchServiceGroup[] = groups.map(group => {
      const page = group.page
      const actions = (page?.actions ?? []).map(OnethingSearchService.actionDto)
      // 「这一次没问它」:结果空、总数 0,而 `deferred` 说清楚这个 0 不是「没有」。
      if (group.deferred === true) {
        return {
          capability: group.capability,
          label: labels.get(group.capability) ?? group.capability,
          total: 0,
          results: [],
          deferred: true,
        }
      }
      return {
        capability: group.capability,
        label: labels.get(group.capability) ?? group.capability,
        total: page?.total,
        results: (page?.items ?? []).map(searchResultOf),
        error: group.error,
        ...(page?.partial === true ? { partial: true } : {}),
        // **这三格是全部档从前丢掉的东西**(检索面终稿 §4)。`fanout` 本来就按
        // `{limit, cursor}` 跑、`page.ts` 给满即产游标 —— 缺的只是这一次投影。
        ...(page?.cursor === undefined ? {} : { cursor: page.cursor }),
        ...(page?.relaxed === undefined ? {} : { relaxed: page.relaxed }),
        ...(actions.length === 0 ? {} : { actions }),
      }
    })
    // 页级动作 = 各组的动作按组序拼起来。它们**不在 `results` 里**,所以下面那一刀
    // 切不到它们,`total` 也数不到它们 —— 这正是「动作不是结果」的全部意思。
    const actions = projected.flatMap(group => group.actions ?? [])
    return {
      success: true,
      // 旧路那一刀:各组按 order 拼接之后切到本档的页大小。
      results: projected.flatMap(group => group.results).slice(0, Math.max(0, limit)),
      groups: projected,
      ...(actions.length === 0 ? {} : { actions }),
    }
  }
}

/**
 * 装上六个内置能力的服务。桌面装一份(进程单例,见 `service-bound.ts`),
 * server 按请求上下文各装一份(它的会话 / 文件 / 提示词表是 per-owner 的)。
 *
 * **索引面是必填的**(S3b):messages / chats / notes 三路已经是索引型,没有索引
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
