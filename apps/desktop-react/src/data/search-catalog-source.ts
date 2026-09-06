import type {
  SearchCapabilityManifestDto,
  SearchFilters,
  SearchItemRef,
  SearchPreviewPayload,
  SearchResponse,
  SearchResult,
  SearchStatusResponse,
} from '@shared/ipc/search'
import { createQuery, createQueryFamily, useQuery } from './kernel'
import type { QuerySnapshot } from './kernel'
import { searchPort } from './search-port'

/**
 * 检索面的**自述 / 索引状态 / 查询 / 预览**四条口(S4a 立三条,S4b 加预览并把
 * 查询变成唯一那条;设计 `docs/design/search-index-2026-09.md` §9 / §4.5)。
 *
 * 与 `message-search-source.ts` 同一体例(kernel 的 query,不手写四件套),
 * 只是问的是另外三件事:
 *
 *  | 口 | 问什么 | 消费处 |
 *  | --- | --- | --- |
 *  | `useSearchCapabilities` | 有哪些能力 | tab 条(`search/capabilities.ts` 的 `tabsOf`) |
 *  | `useSearchIndexStatus` | 索引在干什么 | 底部「索引更新中(剩 n)」/「由 … 维护」两行 |
 *  | `useCapabilitySearch` | **这一档**的结果(含 `all` 档的 groups) | 检索面板的整张列表 |
 *  | `useSearchPreview` | 选中那条(几条)的富预览 | 预览窗(`search/components/SearchPreview.tsx`) |
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三张状态表(状态先行,09-01 用户令)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── 一、生命周期 ─────────────────────────────────────────────────────────
 * | 时机 | 自述 / 状态 | 通用查询 |
 * | --- | --- | --- |
 * | 挂载 | 面板挂上来就 `ensure()` 一次 —— tab 条画不出来面板就是空的 | **什么都不发**:族的格是被问出来的(选了那一档、去抖到点才建) |
 * | 首载 | `phase==='initial' && inflight`;tab 条此刻**只有 `all` 一格**(自述还没回来),不画骨架、不画空条 | 这一路无行;底部读数走 `moreState` 的 pending 那一格 |
 * | 换宿主 | 不存在(数据源没有落点形态);面板重挂后 `useQuery` 订回同一格,答案原样在 | 同左 |
 * | 换空间 | **不作废**:能力表是进程级的事实,与空间无关 | 不作废(键里带档与词,换空间不换键) |
 * | 卸载 | 格留着 = 缓存;整族退役只有 `resetSearchCatalog()` 与 HMR dispose 两口 | 同左 |
 *
 * ── 二、UI 生命状态 ──────────────────────────────────────────────────────
 * | 状态 | 判据 | 屏幕上 |
 * | --- | --- | --- |
 * | empty | 自述回来是空表 | tab 条只剩 `all`;**照实**,不伪造六格 |
 * | loading | `phase==='initial' && inflight` | tab 条只有 `all`;列表照旧画别的产地的行(律②:不为它清屏) |
 * | 重拉 | `phase==='ready' && inflight` | **旧 tab 留在屏上**,不闪 |
 * | ready | 有 `data` | 按自述画 |
 * | error | `snapshot.error` 在 | tab 条退到只有 `all`(问不到就是不知道有哪些档),列表不受影响 |
 * | 超量 | 能力多到 tab 条装不下 | 由 tab 条那个控件自己弯腰(挤压纪律),数据这一层不截断 |
 *
 * ── 三、UI 交互状态 ──────────────────────────────────────────────────────
 * 这块是数据源,**自己一个控件都不画**。rest / hover / focus / active 全长在 tab 条
 * (`ui/Segmented`)与行上(`ui/ButtonBase` + `ui/a11y/list-selection`);
 * disabled 一处都没有 —— 自述还没回来时 `all` 那一档照样能用。
 */

/** 消费面。今天只有命令面板一个(`manifest.surfaces` 缺席 = 全部面都参与)。 */
const PALETTE_SURFACE = 'palette'

/**
 * 有哪些能力。**一格**(不是族):这台进程的能力表只有一份。
 *
 * 问不到就是**空表**而不是抛:tab 条退到只有 `all` 一格,列表照常工作 ——
 * 「不知道有哪些档」不该让整块面塌掉。
 */
export const searchCapabilitiesQuery = createQuery<SearchCapabilityManifestDto[]>(
  'search.capabilities',
  async () => {
    const port = await searchPort()
    await port.ready()
    return await port.capabilities(PALETTE_SURFACE)
  },
)

/** 索引在干什么。同样一格。 */
export const searchStatusQuery = createQuery<SearchStatusResponse>(
  'search.status',
  async () => {
    const port = await searchPort()
    await port.ready()
    return await port.status()
  },
)

/** 一档的答案。`limit` 原样带回来 —— 「取尽了没有」要这两个数才判得出来。 */
export interface CapabilitySearchAnswer {
  results: readonly SearchResult[]
  limit: number
  /**
   * `all` 档的分组总览(§7.2)。**单类档缺席** —— 缺席就是「这一档不分组」,
   * 不是「一个组都没有」。壳按它画组头、组的次序、每组的 total 与「没搜成」。
   */
  groups?: SearchResponse['groups']
  /** 这一档一共有多少条(能力知道才给)。**缺席 = 不知道,不是 0**。 */
  total?: number
  /** 下一页的游标(能力给得出才有);缺席 = 没有下一页可翻。 */
  cursor?: string
  /** 放宽到第几级才有的命中(§6.2);0 / 缺席 = 严格档就中了。 */
  relaxed?: number
  /**
   * **索引在干什么**(检索面终稿 §4:「查询响应带 `index`」)。
   *
   * 后端每一次查询回执里本来就有这一格(`SearchResponse.index`),从前这条 fetcher
   * 把它丢了 —— 于是「索引更新中(剩 n)」那行读数只能靠挂载时问一次
   * `search.status`,查询回来的**更新的**那一份反而看不见。带回来不改任何行为
   * (今天没有读者;页脚读数换产地是第 ⑦ 步的事),它只是不再扔掉已经到手的事实。
   *
   * 多能力那一形(浏览态 fanout)这一格**缺席**:那是 n 发回执,选哪一发的都是
   * 编出来的答案 —— 新数据层(`search-listing-source.ts`)也照这条办。
   */
  index?: SearchResponse['index']
  /**
   * **这一份是空词的浏览态**(S4b 修)—— 也就是「所有」档在零词元时问了
   * 声明 `browse` 的那几个能力,一组一发(见下面的 fetcher)。
   *
   * 它与后端 `all` 档的 `groups` 长得一样,但**分页语义相反**,所以必须分得开:
   *  · 后端的总览 = 各能力按配额各给几条、**不分页**(拿它比 limit 会把「组多到
   *    装满了」误读成「后面还有」);
   *  · 浏览态的每一组 = 各要了**一整页**,组内真的还能再翻。
   * 缺席 = 不是浏览态。
   */
  browse?: boolean
}

/**
 * 键 = 「哪一档 + 什么词 + 要多少条 + 哪些过滤片」。四格都换答案就是另一张列表。
 *
 * `filters` 进键是 S4b 加的,而且**必须**进:一颗片按下去,同一个词同一档的答案
 * 是另一份 —— 不进键的话第二次问会命中第一次那一格,屏幕上「按了没反应」。
 * 键里那份 JSON 的**键序**由 `filtersOf` 那只纯函数一次定死(它按固定次序填),
 * 所以同一份过滤永远算出同一个键。
 */
export function searchCatalogKey(
  capability: SearchAsk,
  query: string,
  limit: number,
  filters?: SearchFilters,
): string {
  return JSON.stringify([normalizeAsk(capability), query, limit, filters ?? {}])
}

/**
 * **这一次去问谁**:一个能力 id / `'all'`,或者一张能力表(空词浏览态,S4b)。
 *
 * 表这一形不是「另一种查询」,是「同一个问题问了 n 遍」—— 每个能力各要一整页,
 * 结果按组交回来。今天那张表只有一格(只有 chats 声明 `browse`),所以
 * `normalizeAsk` 把**一格的表折回标量**:键与线上那一发因此与单类档逐字相同,
 * 走的也是同一条分支 —— 「今天只有一个」不该在缓存与线上留下第二种形状。
 */
export type SearchAsk = string | readonly string[]

function normalizeAsk(ask: SearchAsk): string | string[] {
  if (typeof ask === 'string') return ask
  return ask.length === 1 ? ask[0] : [...ask]
}

/** 这一次到底要问哪几个能力(标量与一格的表在这里合流)。 */
function askedCapabilities(ask: SearchAsk): string[] {
  return typeof ask === 'string' ? [ask] : [...ask]
}

/** 键面封顶(与 message-search-source 同一条:半小时前那个词不该占着内存)。 */
const CACHE_KEYS = 24
const recent: string[] = []

function remember(key: string): void {
  const at = recent.indexOf(key)
  if (at >= 0) recent.splice(at, 1)
  recent.push(key)
  while (recent.length > CACHE_KEYS) {
    const oldest = recent.shift()
    if (oldest !== undefined) capabilitySearchQuery.drop(oldest)
  }
}

function parseKey(key: string): {
  capabilities: string[]
  query: string
  limit: number
  filters: SearchFilters
} {
  const empty = { capabilities: [] as string[], query: '', limit: 0, filters: {} }
  try {
    const parsed: unknown = JSON.parse(key)
    if (!Array.isArray(parsed)) return empty
    const [capability, query, limit, filters] = parsed as [unknown, unknown, unknown, unknown]
    if (typeof query !== 'string' || typeof limit !== 'number') return empty
    const capabilities = typeof capability === 'string'
      ? [capability]
      : Array.isArray(capability) && capability.every(id => typeof id === 'string')
        ? (capability as string[])
        : []
    if (capabilities.length === 0 || capabilities.some(id => id.length === 0)) return empty
    return {
      capabilities,
      query,
      limit,
      filters: typeof filters === 'object' && filters !== null ? (filters as SearchFilters) : {},
    }
  } catch {
    return empty
  }
}

/**
 * 通用一档的取数。`success:false` **抛**出去而不是回一份空结果 —— 失败与
 * 「一条都没搜到」是两件事(与正文那一路逐字同一条判据)。
 */
export const capabilitySearchQuery = createQueryFamily<CapabilitySearchAnswer>(
  'search.capability',
  async (ctx) => {
    const { capabilities, query, limit, filters } = parseKey(ctx.key)
    if (capabilities.length === 0 || limit <= 0) return { results: [], limit: 0 }
    const port = await searchPort()
    await port.ready()
    if (capabilities.length > 1) return await browseFanout(port, capabilities, query, limit, filters)
    const response = await port.query(query, capabilities[0], limit, filters)
    if (!response.success) throw new Error('search failed')
    return {
      results: response.results,
      limit,
      ...(response.groups === undefined ? {} : { groups: response.groups }),
      ...(response.total === undefined ? {} : { total: response.total }),
      ...(response.cursor === undefined ? {} : { cursor: response.cursor }),
      ...(response.relaxed === undefined ? {} : { relaxed: response.relaxed }),
      ...(response.index === undefined ? {} : { index: response.index }),
    }
  },
)

/**
 * 空词浏览态的**多能力那一形**:一个能力一发,各要一整页,按组交回来。
 *
 * 三件事与单类那条路不同,每一件都有理由:
 *
 *  1. **并发发,不串行**。它们互不相干,串起来只是让屏幕多等几个来回。
 *  2. **一组塌了不拖累别组**(§9 第四条「某组 `error` 时组头一句『没搜成』」):
 *     所以这里逐组 catch,把原话放进那一组的 `error`,而不是让整格抛。单类那条
 *     路仍然抛 —— 它没有别的组可以承接这句话,而律②要的是「失败与空结果分得开」。
 *  3. **组名留空**。后端只在 `category:'all'` 那一发上给组名;这几发是壳自己拼的,
 *     名字于是由面板从自述表读(`capabilities.ts` 的 `labelKeyOf`)。
 *     这里不去猜一个 —— 猜出来的名字会是第二个产地。
 */
async function browseFanout(
  port: Awaited<ReturnType<typeof searchPort>>,
  capabilities: readonly string[],
  query: string,
  limit: number,
  filters: SearchFilters,
): Promise<CapabilitySearchAnswer> {
  const groups = await Promise.all(capabilities.map(async (capability) => {
    try {
      const response = await port.query(query, capability, limit, filters)
      if (!response.success) throw new Error('search failed')
      return {
        capability,
        label: '',
        results: response.results,
        ...(response.total === undefined ? {} : { total: response.total }),
      }
    } catch (error) {
      return {
        capability,
        label: '',
        results: [],
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }))
  return { results: groups.flatMap(group => group.results), limit, groups, browse: true }
}

/** 「问一次这一档的这个词」。幂等(`ensure` 的语义),去抖副作用可以无脑调。 */
export function ensureCapabilitySearch(
  capability: SearchAsk,
  query: string,
  limit: number,
  filters?: SearchFilters,
): Promise<void> {
  if (askedCapabilities(capability).length === 0 || limit <= 0) return Promise.resolve()
  const key = searchCatalogKey(capability, query.trim(), limit, filters)
  remember(key)
  return capabilitySearchQuery.get(key).ensure()
}

/** 「同一页再问一次」——「重试」那一下的落点。 */
export function refetchCapabilitySearch(
  capability: SearchAsk,
  query: string,
  limit: number,
  filters?: SearchFilters,
): Promise<void> {
  if (askedCapabilities(capability).length === 0 || limit <= 0) return Promise.resolve()
  const key = searchCatalogKey(capability, query.trim(), limit, filters)
  remember(key)
  return capabilitySearchQuery.get(key).refetch()
}

/** 面板挂上来问一次自述与索引状态。两条都幂等。 */
export function ensureSearchCatalog(): Promise<void> {
  return Promise.all([
    searchCapabilitiesQuery.ensure(),
    searchStatusQuery.ensure(),
  ]).then(() => undefined)
}

/** 有哪些能力。问不到 = 空表(tab 条退到只有 `all`),不抛。 */
export function useSearchCapabilities(): readonly SearchCapabilityManifestDto[] {
  return useQuery(searchCapabilitiesQuery).data ?? []
}

/** 索引在干什么。问不到 = `undefined`(底下那两行都不画)。 */
export function useSearchIndexStatus(): SearchStatusResponse | undefined {
  return useQuery(searchStatusQuery).data
}

/**
 * 通用一档的读法。**建格但不发请求** —— 发不发由 `ensureCapabilitySearch` 说了算
 * (它长在面板那条带去抖的副作用上)。`capability` 为空(这一档有壳自带产地,
 * 或者还没选定)时订空串那一格:它永远没人问过,快照恒定是出厂那一份。
 */
export function useCapabilitySearch(
  capability: SearchAsk,
  query: string,
  limit: number,
  filters?: SearchFilters,
): QuerySnapshot<CapabilitySearchAnswer> {
  const asked = askedCapabilities(capability).filter(id => id.length > 0)
  const key = asked.length > 0 && limit > 0
    ? searchCatalogKey(asked, query.trim(), limit, filters)
    : ''
  return useQuery(capabilitySearchQuery.get(key))
}

/* ── 预览(S4b,§4.5)───────────────────────────────────────── */

/**
 * 预览的一格。**键 = 「哪几条 + 什么基数」**,所以 ↑↓ 换行就是换一格。
 *
 * ── 「↑↓ 换行即 abort 上一条」这句话在这里怎么兑现(与设计的一处出入)────────
 * §4.5 ① 的原话是「↑↓ 换行即 abort 上一条」。这里做到的是**语义上的 abort**:
 * 上一条那一发仍然会跑完,但它落在**它自己那一格**上,而预览窗只订当前这一格 ——
 * 于是屏幕上永远不会闪出上一行的预览。真正把在飞的那一发**掐断**要 transport
 * 支持 `AbortSignal`(`@onething/client` 的 http Transport 今天不收),那是一次
 * 跨包的改动,自成一批。代价如实记在这里:快速连按 ↑↓ 十下会发出十次请求,
 * 而不是一次。缓存那一格挡住了「按回去」的重发,键面封顶挡住了内存。
 */
export interface SearchPreviewAnswer {
  preview?: SearchPreviewPayload
  /** 后端的**原话**(§4.5 ⑤);缺席 = 这一发成了。 */
  error?: string
}

export type SearchPreviewMode = 'single' | 'compare' | 'batch'

/** 键 = 「哪几条 + 什么基数」。`items` 的次序有意义(compare 的左右两格)。 */
export function searchPreviewKey(items: readonly SearchItemRef[], mode: SearchPreviewMode): string {
  return JSON.stringify([mode, items])
}

/** 预览的键面封顶(比查询那一族小:一次检索里选中过的行不会有几十条)。 */
const PREVIEW_KEYS = 12
const recentPreviews: string[] = []

function rememberPreview(key: string): void {
  const at = recentPreviews.indexOf(key)
  if (at >= 0) recentPreviews.splice(at, 1)
  recentPreviews.push(key)
  while (recentPreviews.length > PREVIEW_KEYS) {
    const oldest = recentPreviews.shift()
    if (oldest !== undefined) searchPreviewQuery.drop(oldest)
  }
}

/**
 * 预览的取数。
 *
 * `success:false` **不抛**,而是把原话放进 `error` 交出去 —— 与查询那一路相反,
 * 理由是它们说的不是同一件事:查询失败时「这一档搜不出来」该由 kernel 的 error
 * 那一格带着旧结果并陈(律②);而预览失败是**这一条**算不出来,预览窗要把后端
 * 那句原话原样画在自己那一格里(§4.5 ⑤「error(原话),列表不受影响」)。
 * 让它抛的话,`snapshot.error` 会是一个被 kernel 包过一层的字符串,而且
 * `data` 恒为 undefined —— 那时预览窗分不清「还没问」与「问了但算不出」。
 */
export const searchPreviewQuery = createQueryFamily<SearchPreviewAnswer>(
  'search.preview',
  async (ctx) => {
    const parsed: unknown = JSON.parse(ctx.key)
    if (!Array.isArray(parsed)) return {}
    const [mode, items] = parsed as [SearchPreviewMode, SearchItemRef[]]
    if (!Array.isArray(items) || items.length === 0) return {}
    const port = await searchPort()
    await port.ready()
    const response = await port.preview(items, mode)
    if (!response.success) return { error: response.error ?? 'preview failed' }
    return response.preview === undefined ? {} : { preview: response.preview }
  },
)

/** 「取一次这几条的预览」。幂等 —— 选中不变就不会再问。 */
export function ensureSearchPreview(
  items: readonly SearchItemRef[],
  mode: SearchPreviewMode,
): Promise<void> {
  if (items.length === 0) return Promise.resolve()
  const key = searchPreviewKey(items, mode)
  rememberPreview(key)
  return searchPreviewQuery.get(key).ensure()
}

/**
 * 读法。**建格但不发请求** —— 发不发由 `ensureSearchPreview` 说了算。
 * 空表时订空串那一格:它永远没人问过,快照恒定是出厂那一份。
 */
export function useSearchPreview(
  items: readonly SearchItemRef[],
  mode: SearchPreviewMode,
): QuerySnapshot<SearchPreviewAnswer> {
  return useQuery(searchPreviewQuery.get(items.length === 0 ? '' : searchPreviewKey(items, mode)))
}

/** 测试与 HMR 用:四条口一起回到出厂,两本键面账一并清空。 */
export function resetSearchCatalog(): void {
  searchCapabilitiesQuery.reset()
  searchStatusQuery.reset()
  capabilitySearchQuery.reset()
  searchPreviewQuery.reset()
  recent.length = 0
  recentPreviews.length = 0
}

/**
 * 模块级副作用的退役口(09-01 立法)。这个模块在模块作用域里留着两格 query、
 * 两族 query 与两本键面账 —— 寿命就是「这个模块实例」,热更时必须退役,
 * 否则新旧两份缓存同时活着各自应答。退役**复用已有的那一口拆卸**,不写第二套。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    resetSearchCatalog()
  })
}
