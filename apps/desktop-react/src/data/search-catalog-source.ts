import type {
  SearchCapabilityManifestDto,
  SearchItemRef,
  SearchPreviewPayload,
  SearchStatusResponse,
} from '@shared/ipc/search'
import { createQuery, createQueryFamily, useQuery } from './kernel'
import type { QuerySnapshot } from './kernel'
import { resetSearchListing } from './search-listing-source'
import { searchPort } from './search-port'

/**
 * 检索面的**自述 / 索引状态 / 预览**三条口(S4a 立三条,S4b 加预览)。
 *
 * ── 第 ⑨ 步:查询那一族在这里没有了 ──────────────────────────────────────
 * S4b 时这个文件还管着第四条口(`useCapabilitySearch` / `ensureCapabilitySearch` /
 * `refetchCapabilitySearch` + `capabilitySearchQuery` + `browseFanout` + 四元键
 * `searchCatalogKey`)。第 ④ 步立了 `search-listing-source.ts` 与它并存,第 ⑦ 步
 * 面板换心改吃新族,这一批(第 ⑨ 步)把旧族**整段删掉** —— 它的最后一个消费者在
 * ⑦ 那一笔就没了,留着只会让人以为查询有两条路。四元键(第三格是 `limit`)是
 * 「Load more 跳回顶部」的病根,它随旧族一起下葬;`SearchAsk` 这个名字从此只有
 * `search-listing-source.ts` 一份产地。
 *
 * 与 `message-search-source.ts` 同一体例(kernel 的 query,不手写四件套):
 *
 *  | 口 | 问什么 | 消费处 |
 *  | --- | --- | --- |
 *  | `useSearchCapabilities` | 有哪些能力 | tab 条(`search/capabilities.ts` 的 `tabsOf`) |
 *  | `useSearchIndexStatus` | 索引在干什么 | 页脚读数(索引 / 读者 / 语义召回三行) |
 *  | `useSearchPreview` | 选中那条(几条)的富预览 | 预览窗(`search/components/SearchPreview.tsx`) |
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三张状态表(状态先行,09-01 用户令)
 * ══════════════════════════════════════════════════════════════════════════
 * 检索面整面的三张表**正本在** `apps/desktop-react/docs/search-panel-2026-09.md`
 * 附录 B §2–§4。这里只说这三条口自己的那几格。
 *
 * ── 一、生命周期 ─────────────────────────────────────────────────────────
 * | 时机 | 自述 / 状态 | 预览 |
 * | --- | --- | --- |
 * | 挂载 | 面板挂上来就 `ensureSearchCatalog()` 一次 —— tab 条画不出来面板就是空的 | **什么都不发**:格是被问出来的(选中了哪一行才建) |
 * | 首载 | `phase==='initial' && inflight`;tab 条此刻**只有 `all` 一格**(自述还没回来),不画骨架、不画空条 | 「选一条看看」 |
 * | 换宿主 | 不存在(数据源没有落点形态);面板重挂后 `useQuery` 订回同一格,答案原样在 | 同左 |
 * | 换空间 | **不作废**:能力表是进程级的事实,与空间无关 | 不作废(键是那几条的身份) |
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

/** 索引在干什么。问不到 = `undefined`(底下那几行都不画)。 */
export function useSearchIndexStatus(): SearchStatusResponse | undefined {
  return useQuery(searchStatusQuery).data
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

/**
 * 测试与 HMR 用:三条口一起回到出厂,预览那本键面账一并清空。
 *
 * **顺带把清单那一族也归零**(第 ④ 步留的账,第 ⑨ 步结清):检索面这两个模块
 * 合起来才是「这块面此刻记得的一切」,而每个用例都要两句 `reset` 才干净的写法
 * 迟早漏一句 —— 漏掉的那一次表现为「上一个用例的行还在屏上」。方向是单向的
 * (这里认识清单族,清单族不认识这里),不成环。
 */
export function resetSearchCatalog(): void {
  searchCapabilitiesQuery.reset()
  searchStatusQuery.reset()
  searchPreviewQuery.reset()
  recentPreviews.length = 0
  resetSearchListing()
}

/**
 * 模块级副作用的退役口(09-01 立法)。这个模块在模块作用域里留着两格 query、
 * 一族 query 与一本键面账 —— 寿命就是「这个模块实例」,热更时必须退役,
 * 否则新旧两份缓存同时活着各自应答。退役**复用已有的那一口拆卸**,不写第二套。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    resetSearchCatalog()
  })
}
