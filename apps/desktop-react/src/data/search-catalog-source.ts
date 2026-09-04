import type {
  SearchCapabilityManifestDto,
  SearchResult,
  SearchStatusResponse,
} from '@shared/ipc/search'
import { createQuery, createQueryFamily, useQuery } from './kernel'
import type { QuerySnapshot } from './kernel'
import { searchPort } from './search-port'

/**
 * 检索面的**自述 / 索引状态 / 通用查询**三条口(S4a,设计
 * `docs/design/search-index-2026-09.md` §9)。
 *
 * 与 `message-search-source.ts` 同一体例(kernel 的 query,不手写四件套),
 * 只是问的是另外三件事:
 *
 *  | 口 | 问什么 | 消费处 |
 *  | --- | --- | --- |
 *  | `useSearchCapabilities` | 有哪些能力 | tab 条(`search/capabilities.ts` 的 `tabsOf`) |
 *  | `useSearchIndexStatus` | 索引在干什么 | 底部「索引更新中(剩 n)」/「由 … 维护」两行 |
 *  | `useCapabilitySearch` | 通用一档的结果 | 壳没有自带产地的那几类(`search/sources.ts`) |
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

/** 通用一档的答案。`limit` 原样带回来 —— 「取尽了没有」要这两个数才判得出来。 */
export interface CapabilitySearchAnswer {
  results: readonly SearchResult[]
  limit: number
  /** 这一档一共有多少条(能力知道才给)。**缺席 = 不知道,不是 0**。 */
  total?: number
  /** 下一页的游标(能力给得出才有);缺席 = 没有下一页可翻。 */
  cursor?: string
  /** 放宽到第几级才有的命中(§6.2);0 / 缺席 = 严格档就中了。 */
  relaxed?: number
}

/** 键 = 「哪一档 + 什么词 + 要多少条」。三格都换答案就是另一张列表。 */
function catalogKey(capability: string, query: string, limit: number): string {
  return JSON.stringify([capability, query, limit])
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

function parseKey(key: string): { capability: string; query: string; limit: number } {
  const empty = { capability: '', query: '', limit: 0 }
  try {
    const parsed: unknown = JSON.parse(key)
    if (!Array.isArray(parsed)) return empty
    const [capability, query, limit] = parsed as [unknown, unknown, unknown]
    if (typeof capability !== 'string' || typeof query !== 'string' || typeof limit !== 'number') {
      return empty
    }
    return { capability, query, limit }
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
    const { capability, query, limit } = parseKey(ctx.key)
    if (!capability || limit <= 0) return { results: [], limit: 0 }
    const port = await searchPort()
    await port.ready()
    const response = await port.query(query, capability, limit)
    if (!response.success) throw new Error('search failed')
    return {
      results: response.results,
      limit,
      ...(response.total === undefined ? {} : { total: response.total }),
      ...(response.cursor === undefined ? {} : { cursor: response.cursor }),
      ...(response.relaxed === undefined ? {} : { relaxed: response.relaxed }),
    }
  },
)

/** 「问一次这一档的这个词」。幂等(`ensure` 的语义),去抖副作用可以无脑调。 */
export function ensureCapabilitySearch(capability: string, query: string, limit: number): Promise<void> {
  if (!capability || limit <= 0) return Promise.resolve()
  const key = catalogKey(capability, query.trim(), limit)
  remember(key)
  return capabilitySearchQuery.get(key).ensure()
}

/** 「同一页再问一次」——「重试」那一下的落点。 */
export function refetchCapabilitySearch(capability: string, query: string, limit: number): Promise<void> {
  if (!capability || limit <= 0) return Promise.resolve()
  const key = catalogKey(capability, query.trim(), limit)
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
  capability: string,
  query: string,
  limit: number,
): QuerySnapshot<CapabilitySearchAnswer> {
  const key = capability && limit > 0 ? catalogKey(capability, query.trim(), limit) : ''
  return useQuery(capabilitySearchQuery.get(key))
}

/** 测试与 HMR 用:三条口一起回到出厂,键面一并清空。 */
export function resetSearchCatalog(): void {
  searchCapabilitiesQuery.reset()
  searchStatusQuery.reset()
  capabilitySearchQuery.reset()
  recent.length = 0
}

/**
 * 模块级副作用的退役口(09-01 立法)。这个模块在模块作用域里留着两格 query、
 * 一族 query 与那本键面账 —— 寿命就是「这个模块实例」,热更时必须退役,
 * 否则新旧两份缓存同时活着各自应答。退役**复用已有的那一口拆卸**,不写第二套。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    resetSearchCatalog()
  })
}
