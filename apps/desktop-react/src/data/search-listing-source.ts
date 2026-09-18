import type {
  SearchActionDescriptor,
  SearchFilters,
  SearchItemRef,
  SearchResponse,
  SearchResult,
} from '@shared/ipc/search'
import { appendPage, landScan, landScanError, markPageError } from '../search/paging'
import { getLogger } from '../services/log'
import { createMutation, createQueryFamily, useQueryHeld } from './kernel'
import type { HeldSnapshot } from './kernel'
import type { FetchContext } from './kernel'
import { searchPort } from './search-port'

/**
 * 检索面**那一张清单**的格(检索面终稿 附录 B §5–§6;
 * `apps/desktop-react/docs/search-panel-2026-09.md`)。
 *
 * 它接的是 `search-catalog-source.ts` 里查询那一族的班 —— 那一族本批**原样留着**,
 * 两条路并存(迁移次序第 ④ 步「新数据层与旧并存」),换心在第 ⑦ 步。今天这个文件
 * 一个消费者都没有,所以屏上的行为零变化。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 输入 → 输出 → 不变量
 * ══════════════════════════════════════════════════════════════════════════
 *
 * | 输入 | 输出 | 不变量 |
 * | --- | --- | --- |
 * | `searchListingKey(ask, query, filters)` | 一把**三元**键 | `limit` / 页码 / cursor **不进键** —— 翻页不换格,于是 kernel 律②(重拉旧内容保留)对翻页是结构性质,不是组件自律 |
 * | 一次落地的回执 | `SearchListing{ blocks[] }` | 一形,不再有 `browse` / `groups` 两形;**分页语义逐块由 `block.cursor` 说** |
 * | 「加载更多」 | `searchLoadMore` → `patch(appendPage)` | 同一格**追加**,旧行对象引用不换;三道闸见 `../search/paging.ts` |
 * | `invalidate()` / `refetch()` | 头页 + 顺着游标把同样多的页再走一遍 | 回放**不缩行集**(`ctx.previous.blocks[].pages` 是唯一账) |
 * | 逐字相同的一份答案 | `equals` 判真 | `dataRev` 不动、引用不换(律④) |
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 旧消费者怎么不受影响
 * ══════════════════════════════════════════════════════════════════════════
 *
 * | 旧消费者 | 读的是什么 | 本批动了没有 |
 * | --- | --- | --- |
 * | `SearchPanel.tsx` | 步④ 当时是旧族(`useCapabilitySearch` / `ensureCapabilitySearch` / `refetchCapabilitySearch`) | **步⑦ 换心改吃这一族,步⑨ 旧族整段删了** —— 今天这个文件是唯一那条查询路 |
 * | `search-catalog-source.ts` 的自述 / 状态 / 预览三口 | 各自的格 | 没动(那三口至今原样) |
 * | `resetSearchCatalog()` | 三口 | **步⑨ 起它顺带调 `resetSearchListing()`** —— 两个模块合起来才是「这块面此刻记得的一切」,每个用例要两句 `reset` 的写法迟早漏一句 |
 * | 端口 `searchPort().query` | 位置参数第五格 `cursor` | 步①已经透传,这里只是第一个真的递它的调用方 |
 *
 * ── 为什么家门口不摆 `invalidate` ────────────────────────────────────────
 * 这个模块**不导出 family 本体**,只导出五口(`ensure / refetch / loadMore /
 * useListing / reset`)。有订阅者的 `invalidate()` 会后台重拉并**整份替换** ——
 * 而这一格是分几发攒出来的,整份替换正是「用户翻到第 5 页,后台对了一次账,
 * 屏幕上少了四页」。回放链把这件事补上了,但「谁能触发它」仍然收窄成结构保证:
 * 拿不到 family 就调不到 `invalidate`,不靠 grep 纪律。
 */

/* ── 键 ────────────────────────────────────────────────────────────────── */

/**
 * **这一次去问谁**:一个能力 id / `'all'`,或者一张能力表(空词浏览态)。
 *
 * 表这一形不是「另一种查询」,是「同一个问题问了 n 遍」。一格的表**折回标量**:
 * 键与线上那一发因此与单类档逐字相同 —— 「今天只有一个」不该在缓存与线上留下
 * 第二种形状。
 */
export type SearchAsk = string | readonly string[]

function normalizeAsk(ask: SearchAsk): string | string[] {
  if (typeof ask === 'string') return ask
  return ask.length === 1 ? ask[0] : [...ask]
}

/**
 * 键 = 「问谁 + 什么词 + 哪些片」。**三元**。
 *
 * 旧那把键是四元,第三格是 `limit`,于是「页码 +1 = 换键 = 新格 `data===undefined`
 * = 列表清空 = 容器高度归零」—— 那正是用户报的「Load more 跳回顶部」的病根。
 * 这里把 `limit` 请出键面:一把键 = 一张列表的**主语**,页是这张列表里的事。
 *
 * 键里那份 JSON 的键序由 `filtersOf` 那只纯函数一次定死(它按固定次序填),
 * 所以同一份过滤永远算出同一个键。
 */
export function searchListingKey(
  ask: SearchAsk,
  query: string,
  filters?: SearchFilters,
): string {
  return JSON.stringify([normalizeAsk(ask), query.trim(), filters ?? {}])
}

interface ParsedKey {
  capabilities: string[]
  query: string
  filters: SearchFilters
}

const EMPTY_PARSE: ParsedKey = { capabilities: [], query: '', filters: {} }

function parseKey(key: string): ParsedKey {
  try {
    const parsed: unknown = JSON.parse(key)
    if (!Array.isArray(parsed)) return EMPTY_PARSE
    const [ask, query, filters] = parsed as [unknown, unknown, unknown]
    if (typeof query !== 'string') return EMPTY_PARSE
    const capabilities = typeof ask === 'string'
      ? [ask]
      : Array.isArray(ask) && ask.every(id => typeof id === 'string')
        ? (ask as string[])
        : []
    if (capabilities.length === 0 || capabilities.some(id => id.length === 0)) return EMPTY_PARSE
    return {
      capabilities,
      query,
      filters: typeof filters === 'object' && filters !== null ? (filters as SearchFilters) : {},
    }
  } catch {
    return EMPTY_PARSE
  }
}

/* ── 格值 ──────────────────────────────────────────────────────────────── */

/**
 * 屏幕上的**一块** —— 一个能力的命中。块之间不混排(次序由后端按自述的 `order`
 * 排好),**没有组头**(用户 09-05 裁定),每块自己原地续页。
 */
export interface SearchBlock {
  /** 能力 id;也是这一块在格里的身份(翻页、`data-block` 都按它取)。 */
  readonly capability: string
  /** 累加的行。**按 id 去重,旧行对象引用不换**(律④:行 memo 据它)。 */
  readonly rows: readonly SearchResult[]
  /** 这一块自报的页级动作(「新建提示词 …」)。**不在 `rows` 里、不计任何数**。 */
  readonly actions?: readonly SearchActionDescriptor[]
  /** 下一页的游标;缺席 = 没有下一页(契约原话,壳只认这一条)。 */
  readonly cursor?: string
  /** 这一块一共多少条(能力知道才给)。**缺席 = 不知道,不是 0**。 */
  readonly total?: number
  /** 这一块零命中后放宽了几级;0 / 缺席 = 严格档就中了。 */
  readonly relaxed?: number
  /**
   * **这一块后端这一次没问,壳正在单独去问**(09-07 事故第二条修)。
   *
   * 「不挑」那一档不等去外部枚举的那几路(契约 `groups[].deferred`)。屏上它是一块
   * **只有块尾一条「扫描中…」的块** —— 与「零命中不占行」不冲突:那条规矩说的是
   * 「问过了,没有」,这一格说的是「还没问」,两件事。
   *
   * 它由 `searchScanBlock` 那只 mutation 落地时清掉(成功补进 `rows`,失败落
   * `error` → 页脚一行「<能力名>没搜成 · 重试」)。
   */
  readonly scanning?: boolean
  /**
   * **只扫到一半**(预算到点交的部分;契约 `groups[].partial` / `SearchResponse.partial`)。
   * 块尾读数据它说「已扫描的部分 · 未扫完」,而不是谎称「共 N 条」。
   */
  readonly partial?: boolean
  /**
   * 取尽了。**与 `cursor` 是同一件事的两半**,恒等式 `exhausted === (cursor === undefined)`
   * 由 `blockOf` 这一处产地保住 —— 屏上那条块尾项读的是这一格(它说的是结论),
   * 翻页读的是 `cursor`(它说的是手段)。
   */
  readonly exhausted: boolean
  /** 头页塌了的原话;缺席 = 没塌。 */
  readonly error?: string
  /** 最近一次**翻页**塌了的原话;`rows` 照留(重试带同一个 cursor)。 */
  readonly pageError?: string
  /** 已落地几页。**回放链读它**,别处不读。 */
  readonly pages: number
}

/** 一张清单。三种档一台机,差别只在首页怎么来(见 fetcher)。 */
export interface SearchListing {
  /** `browse` = 空词逐能力各要一页;`overview` = 全部档的分组;`single` = 单类档。 */
  readonly mode: 'browse' | 'overview' | 'single'
  /** 造这份清单用的词。**高亮读它**,不读输入框里那个(换词在飞时它们不是同一个)。 */
  readonly query: string
  readonly blocks: readonly SearchBlock[]
  readonly total?: number
  readonly relaxed?: number
  /** 索引在干什么(页脚读数)。查询回执捎回来的那一格。 */
  readonly index?: SearchResponse['index']
  /** 页级动作(不属于任何一块的那些)。 */
  readonly actions?: readonly SearchActionDescriptor[]
}

/** 一页的落地形 —— 翻页那只 mutation 交回来的东西,也是 `appendPage` 的入参。 */
export interface SearchPage {
  readonly rows: readonly SearchResult[]
  readonly cursor?: string
  readonly total?: number
  readonly relaxed?: number
  /** 这一页只扫到一半(契约 `SearchResponse.partial`)。 */
  readonly partial?: boolean
  readonly actions?: readonly SearchActionDescriptor[]
}

interface BlockInput {
  capability: string
  rows: readonly SearchResult[]
  cursor?: string
  total?: number
  relaxed?: number
  actions?: readonly SearchActionDescriptor[]
  error?: string
  pageError?: string
  scanning?: boolean
  partial?: boolean
  pages: number
}

/**
 * **一块的唯一产地**。`exhausted` 在这里从 `cursor` 算出来,别处一律不自己拼 ——
 * 两格说的是同一件事,而同一件事只许有一处会算错。
 */
export function blockOf(input: BlockInput): SearchBlock {
  return {
    capability: input.capability,
    rows: input.rows,
    ...(input.actions === undefined ? {} : { actions: input.actions }),
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    ...(input.total === undefined ? {} : { total: input.total }),
    ...(input.relaxed === undefined ? {} : { relaxed: input.relaxed }),
    ...(input.error === undefined ? {} : { error: input.error }),
    ...(input.pageError === undefined ? {} : { pageError: input.pageError }),
    ...(input.scanning === true ? { scanning: true } : {}),
    ...(input.partial === true ? { partial: true } : {}),
    exhausted: input.cursor === undefined,
    pages: input.pages,
  }
}

/** 一次回执 → 一页。`SearchResponse` 那几格里翻页真正要的就这六格。 */
function pageOf(response: SearchResponse): SearchPage {
  return {
    rows: response.results,
    ...(response.cursor === undefined ? {} : { cursor: response.cursor }),
    ...(response.total === undefined ? {} : { total: response.total }),
    ...(response.relaxed === undefined ? {} : { relaxed: response.relaxed }),
    ...(response.partial === true ? { partial: true } : {}),
    ...(response.actions === undefined ? {} : { actions: response.actions }),
  }
}

/* ── 一页要多少条 ──────────────────────────────────────────────────────── */

/**
 * 一页多少条。**只有一个数** —— 首屏与「再要一页」是同一件事,不再有
 * 「首屏 20 + 每页再 20 的窗口」那套算术(那套的存在只是因为从前的翻页是
 * 「带一个更大的 limit 从头重查」)。
 */
export const SEARCH_LISTING_PAGE = 20

/* ── 键面封顶 ──────────────────────────────────────────────────────────── */

/** 半小时前那个词不该占着内存(与两个既有数据源同一条纪律)。 */
const CACHE_KEYS = 24
const recent: string[] = []

function remember(key: string): void {
  const at = recent.indexOf(key)
  if (at >= 0) recent.splice(at, 1)
  recent.push(key)
  while (recent.length > CACHE_KEYS) {
    const oldest = recent.shift()
    if (oldest !== undefined) searchListingQuery.drop(oldest)
  }
}

/* ── fetcher ───────────────────────────────────────────────────────────── */

type Port = Awaited<ReturnType<typeof searchPort>>

const log = getLogger('search.listing')

/** 单发:一个能力 id(或 `'all'`)。回执带 `groups` 就是分组总览,否则是一块。 */
async function fetchOne(
  port: Port,
  capability: string,
  query: string,
  filters: SearchFilters,
  signal?: AbortSignal,
): Promise<SearchListing> {
  const response = await port.query(query, capability, SEARCH_LISTING_PAGE, filters, undefined, signal)
  /*
   * `success:false` **抛**出去而不是回一份空结果 —— 失败与「一条都没搜到」是两件事。
   * 抛出去之后 kernel 把原话放进 `error` 那一格,而 `data` 照旧是上一次那份(律②):
   * 屏幕上「这是上次的」与「这次没拿到,原话是这句」同时看得见。
   */
  if (!response.success) throw new Error(response.error ?? 'search failed')

  /*
   * **分组总览由回执自己说**(`groups` 在场),不由壳判「这一档是不是 `all`」——
   * 那样壳里就多一个档位名的枚举点。
   */
  if (response.groups !== undefined) {
    return {
      mode: 'overview',
      query,
      blocks: response.groups.map(group => (
        /*
         * **「这一次没问它」是一种块,不是一块空结果**(09-07 事故第二条修)。
         *
         * 这一块带着 `scanning` 进清单 —— 屏上是一条「扫描中…」的块尾项;
         * `useSearchListing` 看见它就发一发单类请求把它补上(`searchScanBlock`)。
         * 后端那一格 `total: 0` **一个字都不收**:它说的不是「零命中」,收下来
         * 块尾读数就会画出一句「共 0 条」的谎话。
         */
        group.deferred === true
          ? blockOf({ capability: group.capability, rows: [], scanning: true, pages: 1 })
          : blockOf({
            capability: group.capability,
            rows: group.results,
            ...(group.cursor === undefined ? {} : { cursor: group.cursor }),
            ...(group.total === undefined ? {} : { total: group.total }),
            ...(group.relaxed === undefined ? {} : { relaxed: group.relaxed }),
            ...(group.actions === undefined ? {} : { actions: group.actions }),
            ...(group.error === undefined ? {} : { error: group.error }),
            ...(group.partial === true ? { partial: true } : {}),
            pages: 1,
          })
      )),
      ...(response.total === undefined ? {} : { total: response.total }),
      ...(response.relaxed === undefined ? {} : { relaxed: response.relaxed }),
      ...(response.index === undefined ? {} : { index: response.index }),
      ...(response.actions === undefined ? {} : { actions: response.actions }),
    }
  }

  /*
   * 单发那一形:`response.actions` 是**页级**的(契约上它就摆在 `SearchResponse`
   * 上,不在 `groups[]` 里)。把同一批动作再挂进这一块,屏幕上就会画两遍
   * ——「一条动作两个产地」,与 `groups[].actions` 那一支的语义也不一致。
   * 所以这里把块级那一格摘掉,页级留在 listing 上。
   */
  const { actions: _pageActions, ...page } = pageOf(response)
  return {
    mode: 'single',
    query,
    blocks: [blockOf({ capability, ...page, pages: 1 })],
    ...(response.total === undefined ? {} : { total: response.total }),
    ...(response.relaxed === undefined ? {} : { relaxed: response.relaxed }),
    ...(response.index === undefined ? {} : { index: response.index }),
    ...(response.actions === undefined ? {} : { actions: response.actions }),
  }
}

/**
 * 浏览态那一形:一个能力一发,各要一整页,按块交回来。
 *
 * 三件事与单发那条路不同,每一件都有理由:
 *  1. **并发发,不串行** —— 它们互不相干,串起来只是让屏幕多等几个来回;
 *  2. **一块塌了不拖累别块** —— 逐块 catch,原话进那一块的 `error`,整格不抛
 *     (单发那条路仍然抛:它没有别的块可以承接这句话);
 *  3. **块名不猜** —— 后端只在分组总览那一发上给组名;这几发是壳自己拼的,
 *     名字由面板从自述表读(`search/capabilities.ts` 的 `labelKeyOf`)。
 */
async function fetchBrowse(
  port: Port,
  capabilities: readonly string[],
  query: string,
  filters: SearchFilters,
  signal?: AbortSignal,
): Promise<SearchListing> {
  const blocks = await Promise.all(capabilities.map(async (capability) => {
    try {
      const response = await port.query(query, capability, SEARCH_LISTING_PAGE, filters, undefined, signal)
      if (!response.success) throw new Error(response.error ?? 'search failed')
      return blockOf({ capability, ...pageOf(response), pages: 1 })
    } catch (error) {
      return blockOf({
        capability,
        rows: [],
        error: error instanceof Error ? error.message : String(error),
        pages: 1,
      })
    }
  }))
  return { mode: 'browse', query, blocks }
}

/**
 * **回放链**:头页拿到之后,顺着游标把上一次已经翻到的页数再走一遍,整份交回。
 *
 * 没有它,`refetch()` 之后行集会当场缩回去 —— 用户翻到第 5 页,按了一下重试,
 * 屏幕上少了四页。账**只有一处**:`ctx.previous.blocks[].pages`(kernel 只负责把
 * 上一份答案原样递过来,它不认识页、游标、块);不立「`pagesWanted` 旁表」。
 *
 * 两处如实:
 *  · 回放半途塌了 → 交回**已经走到的那一份**(不缩,也不假装走完);
 *  · 逐块顺序走 → 回放只发生在显式重拉上(family 不导出,`invalidate` 没有调用方),
 *    多几个来回换代码上一条直路,划算。
 */
async function replay(
  port: Port,
  head: SearchListing,
  parsed: ParsedKey,
  previous: SearchListing | undefined,
  signal?: AbortSignal,
): Promise<SearchListing> {
  if (previous === undefined) return head
  let listing = head
  for (const first of head.blocks) {
    const want = previous.blocks.find(b => b.capability === first.capability)?.pages ?? 1
    for (;;) {
      const current = listing.blocks.find(b => b.capability === first.capability)
      if (current === undefined || current.pages >= want) break
      const cursor = current.cursor
      if (cursor === undefined) break
      let response: SearchResponse
      try {
        response = await port.query(
          parsed.query,
          current.capability,
          SEARCH_LISTING_PAGE,
          parsed.filters,
          cursor,
          signal,
        )
      } catch (error) {
        log.warn('replay page failed; keeping what we walked', {
          capability: current.capability,
          page: current.pages + 1,
          err: error instanceof Error ? error.message : String(error),
        })
        break
      }
      if (!response.success) break
      const next = appendPage(listing, current.capability, cursor, pageOf(response))
      if (next === undefined || next === listing) break
      listing = next
    }
  }
  return listing
}

async function fetchListing(ctx: FetchContext<SearchListing>): Promise<SearchListing> {
  const parsed = parseKey(ctx.key)
  if (parsed.capabilities.length === 0) {
    return { mode: 'single', query: parsed.query, blocks: [] }
  }
  const port = await searchPort()
  await port.ready()
  // kernel 在同一格上后一发发车时拉这条(`FetchContext.signal`);它一路递到 fetch。
  const signal = ctx.signal
  const head = parsed.capabilities.length > 1
    ? await fetchBrowse(port, parsed.capabilities, parsed.query, parsed.filters, signal)
    : await fetchOne(port, parsed.capabilities[0], parsed.query, parsed.filters, signal)
  return await replay(port, head, parsed, ctx.previous, signal)
}

/* ── `equals`:逐字相同就不换引用(律④)────────────────────────────────── */

function sameActions(
  a: readonly SearchActionDescriptor[] | undefined,
  b: readonly SearchActionDescriptor[] | undefined,
): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined || a.length !== b.length) return false
  return a.every((action, i) => action.id === b[i].id && action.labelKey === b[i].labelKey)
}

/**
 * **比内容,但不深比行**:块的那六格(游标 / 取尽 / 两种错 / 页数 / 总数)加上
 * **行的 id 序列**。比 id 不是深比 —— 它正是「这一块的行集变没变」这件事本身,
 * 而 fetcher 每次都新造数组,不比就等于「每次都算变了」(那时 `dataRev` 每次 +1,
 * 每一次重拉都让整张列表换一次引用)。
 */
function listingEquals(a: SearchListing, b: SearchListing): boolean {
  if (a === b) return true
  if (a.mode !== b.mode || a.query !== b.query) return false
  if (a.total !== b.total || a.relaxed !== b.relaxed) return false
  if (a.index?.pending !== b.index?.pending || a.index?.stale !== b.index?.stale) return false
  if (!sameActions(a.actions, b.actions)) return false
  if (a.blocks.length !== b.blocks.length) return false
  return a.blocks.every((block, i) => {
    const other = b.blocks[i]
    return block.capability === other.capability
      && block.cursor === other.cursor
      && block.exhausted === other.exhausted
      && block.error === other.error
      && block.pageError === other.pageError
      && block.pages === other.pages
      && block.total === other.total
      && block.relaxed === other.relaxed
      && block.scanning === other.scanning
      && block.partial === other.partial
      && sameActions(block.actions, other.actions)
      && block.rows.length === other.rows.length
      && block.rows.every((row, j) => row.id === other.rows[j].id)
  })
}

/**
 * 这一族**不导出**(见文件头最后一段)。五口在下面。
 */
const searchListingQuery = createQueryFamily<SearchListing>(
  'search.listing',
  fetchListing,
  { equals: listingEquals },
)

/* ── 翻页 ──────────────────────────────────────────────────────────────── */

export interface SearchLoadMoreInput {
  /** 哪一格(`searchListingKey` 造的那把)。 */
  key: string
  /** 哪一块。 */
  capability: string
  /**
   * **发车这一刻**那一块的游标。它进 input 而不是在 `run` 里现读,是闸①的全部实现:
   * 落地时格里那一块的游标已经不是它了(同游标双发 / 头页重拉在翻页飞行期间落地),
   * `appendPage` 当场丢弃这一发。
   */
  cursor: string
}

/** 忙态长在**哪一格**上(律③:反馈逐块,不是整张列表转圈)。 */
export function searchLoadMoreKey(key: string, capability: string): string {
  return `${key}#${capability}`
}

/**
 * 「让这一块再长一页」。
 *
 * **没有 `optimistic`**:mutation 失败时先 `rollback()` 再 `onError`,而 kernel 的
 * 回滚是**整格快照还原** —— 块 A 的重试若带乐观补丁,失败时会把块 B 刚追加的一页
 * 整批抹掉。清 `pageError` 因此放在 `appendPage` 里,不经 `optimistic`。
 */
export const searchLoadMore = createMutation<SearchLoadMoreInput, SearchPage>('search.loadMore', {
  key: ({ key, capability }) => searchLoadMoreKey(key, capability),
  run: async ({ key, capability, cursor }) => {
    const parsed = parseKey(key)
    const port = await searchPort()
    await port.ready()
    const response = await port.query(
      parsed.query,
      capability,
      SEARCH_LISTING_PAGE,
      parsed.filters,
      cursor,
    )
    if (!response.success) throw new Error(response.error ?? 'search failed')
    return pageOf(response)
  },
  settle: (page, { key, capability, cursor }) => {
    searchListingQuery.get(key).patch(prev => appendPage(prev, capability, cursor, page))
  },
  onError: (error, { key, capability }) => {
    searchListingQuery.get(key).patch(prev => markPageError(prev, capability, error.message))
  },
})

/* ── 补上「不挑」那一档没问的那一块 ────────────────────────────────────── */

/**
 * 在飞的那几发扫描,按 `key#capability` 记着 —— **为了能杀掉它们**。
 *
 * 为什么要一本自己的账,而不是靠 kernel:这几发不是 query 的取数,是 mutation
 * (它们往一个已经落地的格里打补丁),而 mutation 没有 kernel 给的信号。
 * 而这一路恰恰是最需要杀的那一路:它在后端会去起 `rg`。
 */
const scansInFlight = new Map<string, AbortController>()

function abortScan(id: string): void {
  const controller = scansInFlight.get(id)
  if (controller === undefined) return
  scansInFlight.delete(id)
  controller.abort(new Error('search scan superseded'))
}

/** 换键时把**别的键**上那几发扫描全杀掉(换词 / 清词 / 换档都走这里)。 */
function abortScansOtherThan(key: string): void {
  for (const id of [...scansInFlight.keys()]) {
    if (!id.startsWith(`${key}#`)) abortScan(id)
  }
}

/**
 * 「后端说这一块它没问,壳自己去问一次」(09-07 事故第二条修的壳侧一半)。
 *
 * 同词、同片、同页大小 —— 与那一块出现在单类档时**逐字同一发**,所以后端那边
 * 没有第二条路径要维护。落地走 `patch`:成功就把行填进那一块并清掉 `scanning`,
 * 失败落 `error` → 页脚一行「<能力名>没搜成 · 重试」(与头页塌了同一条口)。
 *
 * **忙态与翻页共用一把键**(`key#capability`,律③):于是块尾那条项在扫描期间
 * 本来就按 `loading` 画,`canLoadMore` 也自然是假 —— 不必再发明第二套忙态。
 */
export const searchScanBlock = createMutation<{ key: string; capability: string }, SearchPage>(
  'search.scanBlock',
  {
    key: ({ key, capability }) => searchLoadMoreKey(key, capability),
    run: async ({ key, capability }) => {
      const parsed = parseKey(key)
      const id = searchLoadMoreKey(key, capability)
      abortScan(id)
      const controller = new AbortController()
      scansInFlight.set(id, controller)
      try {
        const port = await searchPort()
        await port.ready()
        const response = await port.query(
          parsed.query,
          capability,
          SEARCH_LISTING_PAGE,
          parsed.filters,
          undefined,
          controller.signal,
        )
        if (!response.success) throw new Error(response.error ?? 'search failed')
        return pageOf(response)
      } finally {
        if (scansInFlight.get(id) === controller) scansInFlight.delete(id)
      }
    },
    settle: (page, { key, capability }) => {
      searchListingQuery.get(key).patch(prev => landScan(prev, capability, page))
    },
    onError: (error, { key, capability }) => {
      /*
       * **被自己人杀掉的那一发不算失败**(换词了 —— 用户没做错什么,屏上也不该
       * 冒出一句「文件没搜成」)。判据是这一发是不是 abort 出来的;别的错照旧
       * 落进这一块的 `error`,由页脚说一句人话 + 一个「重试」。
       */
      if (error.name === 'AbortError' || /abort/i.test(error.message)) return
      searchListingQuery.get(key).patch(prev => landScanError(prev, capability, error.message))
    },
  },
)

/**
 * **按下一条动作**(P5,§8 `invoke`)。
 *
 * 三条真动作今天都在 `notes` 那一类上:新建今天的日记 / 新建一篇笔记 / 在它自己的
 * app 里打开。壳这一侧**一个都不认识** —— 它拿到的是一个能力 id、一个动作号和
 * (行动作才有的)那一行的指纹,原样转发。
 *
 * **不落格、不改清单**:动作做完这张清单不变(建出来的那篇笔记要等下一次查询才
 * 进索引,那是索引 feed 的事,不是壳能替它宣布的)。所以这只 mutation 没有
 * `optimistic`、没有 `settle` 补丁 —— 成功与失败的差别只在屏幕上那一句话,由
 * 调用方(面板)用 `notify` 说。
 */
export const searchInvoke = createMutation<
  { capability: string; actionId: string; items?: readonly SearchItemRef[] },
  void
>('search.invoke', {
  key: ({ capability, actionId }) => `${capability}:${actionId}`,
  run: async ({ capability, actionId, items }) => {
    const port = await searchPort()
    await port.ready()
    const response = await port.invoke(capability, actionId, items)
    if (!response.success) throw new Error(response.error ?? 'search action failed')
  },
})

/* ── 五口 ──────────────────────────────────────────────────────────────── */

/** 「问一次这把键」。幂等(`ensure` 的语义),去抖副作用可以无脑调。 */
export function ensureSearchListing(key: string): Promise<void> {
  /*
   * **换主语 = 杀掉别的主语手上那几发扫描**(09-07 事故第四条修的壳侧一半)。
   *
   * 这一句排在最前面,连「这把键认不认」都不看:清空输入框那一下会把键换成
   * 浏览态那一把(甚至换成一把空的),而那一刻正是最需要把在飞的扫盘停掉的时候
   * —— 报障原话是「清了词那两条 rg 也不死」。这一发 abort 会一路传到后端:
   * fetch 断开 → HTTP 面 `response.close` → `ctx.signal` → `fanout` 派生信号 →
   * `listOnethingRipgrepFiles` 的 `finally` → `proc.kill()`。
   */
  abortScansOtherThan(key)
  if (parseKey(key).capabilities.length === 0) return Promise.resolve()
  remember(key)
  return searchListingQuery.get(key).ensure()
}

/**
 * 「再问一次」——「重试」那一下的落点。**同一把键**,所以旧行留在屏上(律②),
 * 而回放链保证行集不缩。
 */
export function refetchSearchListing(key: string): Promise<void> {
  if (parseKey(key).capabilities.length === 0) return Promise.resolve()
  remember(key)
  return searchListingQuery.get(key).refetch()
}

/**
 * 读法。**建格但不发请求** —— 发不发由 `ensureSearchListing` 说了算(它长在
 * `SearchBindings` 那条带去抖的副作用上)。
 *
 * 交出来的是 `useQueryHeld` 的快照:换键在飞的那一段,上一把键的行**留在屏上**
 * (律②′),`stale` 说这份是不是别的键的,`shownKey` 是**屏上那份数据的键** ——
 * 滚动记忆、行 key、块标识一律按它取。
 */
export function useSearchListing(key: string): HeldSnapshot<SearchListing> {
  return useQueryHeld(searchListingQuery.get(key))
}

/** 测试与 HMR 用:整族回到出厂,键面账一并清空。 */
export function resetSearchListing(): void {
  searchListingQuery.reset()
  searchLoadMore.reset()
  searchScanBlock.reset()
  // 回到出厂 = 一发在途的扫盘都不留(它们在后端各有一条 `rg`)。
  for (const id of [...scansInFlight.keys()]) abortScan(id)
  recent.length = 0
}

/**
 * 模块级副作用的退役口(09-01 立法)。这个模块在模块作用域里留着一族 query、
 * 一只 mutation 与一本键面账 —— 寿命就是「这个模块实例」,热更时必须退役,
 * 否则新旧两份缓存同时活着各自应答。退役**复用已有的那一口拆卸**,不写第二套。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    resetSearchListing()
  })
}
