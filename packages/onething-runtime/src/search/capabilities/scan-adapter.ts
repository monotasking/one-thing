/**
 * 把一只 `(query, limit, filters) => SearchResult[]` 的**匹配器**按 core 的基座
 * 包成一个能力。
 *
 * 设计:docs/design/search-index-2026-09.md §4.2(三种基座)。
 *
 * S5(2026-09-05)之前这个文件叫 `legacy.ts`,因为那时它包的是**旧扫描路**里那六个
 * 扫描器;旧路退役之后包的是各能力自己的匹配器(`actions` / `prompts` 的静态小表、
 * `files` 的按名扫盘),所以改名叫「扫描适配器」——名字说的是它做的事,不是它的来历。
 *
 * ## 为什么候选驮着一条 `SearchServiceResult` 走
 *
 * 结果的**键序**、以及「哪些键在、哪些键因为值是 undefined 而不在」,是各能力自己
 * 一行行写出来的;在这里重新投影一份等价的既证不出来、又会变成第二个「一条结果长
 * 什么样」的产地。所以候选驮着那条记录走,投影就是「原样 + `target`」——
 * `ResultBackedCandidate.result`。三条索引型能力(chats / messages / daily)也用
 * 同一格:它们从索引答的文档里造出那条记录,再挂到候选上。
 *
 * ## 为什么基座是**每次调用现造**的
 *
 * 匹配器的 `limit` 是**它自己语义的一部分**,不是外面切一刀就能等价的:
 * `searchPrompts` 的「新建提示词」快捷项按 `slice(0, limit - 1)` 之后**是不是空**
 * 决定要不要出;`chats` 的浏览态里 limit 就是「最近几间」的 N。而两个基座的
 * `scan` / `items` 都拿不到本次的 `page.limit`(它只到 `search()`)。所以基座在
 * `search()` 里、拿到 limit 之后才造。
 *
 * ## 分数 = 逆序名次
 *
 * 匹配器交回来的已经是**排好序、切好片**的一页。core 的 `defaultRanker` 会按
 * `score` 再排一次(组内排序,§6.5),所以这里给的分数是严格递减且互不相同的
 * 「逆序名次」——排序于是恒等,匹配器自己的次序一格不动。
 */

import {
  scanCapability,
  staticCapability,
  type ActionDescriptor,
  type Candidate,
  type CapabilityManifest,
  type FacetFilter,
  type PreviewPayload,
  type SearchCapability,
  type SearchContext,
  type SearchPage,
  type SearchQuery,
} from '@onething/core/search'

/**
 * 服务层流动的那条结果 —— 今天的 `OnethingSearchResult` 加上 §8 新添的两格。
 *
 * 与契约层那份 `SearchResult` **同形不同命**:产品层不许 import 契约层
 * (`boundary` 执法 —— 连这行注释里都不许出现那个模块名),而契约那份要能过 JSON。
 * 两份同形是有意的,与 `CapabilityManifest` 在 core 与契约各有一份是同一条判例。
 */
export interface SearchServiceResult {
  id: string
  type: 'chat' | 'message' | 'action' | 'file' | 'daily' | 'prompt' | 'plugin'
  title: string
  subtitle?: string
  detail?: string
  sessionId?: string
  messageId?: string
  actionId?: string
  filePath?: string
  timestamp?: number
  shortcut?: string
  matchRanges?: Array<{ start: number; end: number }>
  group?: string
  icon?: string
  /** 去哪儿(§4.1 的 `Candidate.target`)——形由能力定义,壳按 kind 取渲染器。 */
  target?: { kind: string; payload: unknown }
  /** 键由产它的能力 `manifest.facets` 声明;宿主不解释。 */
  facets?: Record<string, string | number | boolean>
  /**
   * 随候选带的预览(§4.5 ①`mode: 'inline'`;S4a 加)。
   * 只有自述里说了 `preview: { mode: 'inline' }` 的能力才会有这一格。
   */
  preview?: { kind: string; payload: unknown; title?: string }
  /**
   * 这条摘要是从哪一段开的窗(检索面终稿 §4)。坐标系是**剥过记号的全文**,
   * 与 `title` / `matchRanges` 同一个。缺席 = 那串字就是全文。
   */
  snippet?: SearchResultSnippetWindow
  /** 这条是哪一路召回的(语义徽);缺席 = 不知道 / 这一类只有一路。 */
  source?: 'lexical' | 'vector'
}

/** `SearchServiceResult.snippet` 那三格(契约层 `SearchResult.snippet` 的同形件)。 */
export interface SearchResultSnippetWindow {
  offset: number
  truncatedStart: boolean
  truncatedEnd: boolean
}

/** 驮着一条成品结果的候选。 */
export interface ResultBackedCandidate extends Candidate {
  readonly result: SearchServiceResult
}

/** 一条结果 → 它的目标形(§4.1 `target`,开放:形由能力自己定义并导出类型)。 */
export type ResultTargetOf = (result: SearchServiceResult) => { kind: string; payload: unknown }

export interface ResultBackedCapabilityOptions {
  manifest: CapabilityManifest
  /**
   * 这一路的匹配器,逐字调用,不在这里重写匹配或排序。
   *
   * 第三格 `filters` **只递不解释**:`fanout` 已经按 `narrowToDeclaredFacets` 把
   * 这一份收窄成「这个能力自述里声明过的那几个键」,所以匹配器拿到的键一定是它
   * 自己认的。不声明 facets 的能力恒收到 `{}` —— 它们的签名少一格参数,JS 直接
   * 忽略,行为零变化。
   */
  run(
    query: string,
    limit: number,
    filters: Readonly<Record<string, FacetFilter>>,
  ): Promise<readonly SearchServiceResult[]> | readonly SearchServiceResult[]
  target: ResultTargetOf
  /** 缺省 = 恒真(这一类在 `all` 档里被无条件问到)。 */
  supports?(query: SearchQuery): boolean
  /**
   * 随候选带的**内联预览**(§4.5 ①的 `mode: 'inline'`;S4a 加)。
   *
   * 缺席 = 这条路不带预览 —— 与 manifest 上 `preview` 缺席是同一句话的两半:
   * 自述说「我有 inline 预览」,这一格就是它兑现的地方。算不出来时返回
   * `undefined`(一条候选没有预览,不是整页失败)。
   */
  preview?(result: SearchServiceResult): PreviewPayload | undefined
  /**
   * 这一页上的**动作**(检索面终稿 §0 ③「动作不是结果」)。
   *
   * 「新建提示词 “jira”」从前是匹配器 `unshift` 进结果里的一行,靠 `slice(0, limit-1)`
   * 给自己留位置 —— 于是它占配额、计进 `total`、被当成一条命中。现在它走这一格:
   * 基座把它挂到 `SearchPage.actions` 上,与 `items` 分开,谁都不用替谁让位置。
   *
   * 回调收**这一页的结果**,因为「一条都没搜到时才提议新建」这种判据要看见页。
   * 返回空表或 `undefined` = 这一次没有动作。
   */
  actions?(query: SearchQuery, items: readonly SearchServiceResult[]): ActionDescriptor[] | undefined
}

/**
 * 静态型的匹配器交的是**全集**,不是一页。
 *
 * 从前它交一页(`run(query, page.limit)`),理由写在文件头:`searchPrompts` 的
 * 「新建提示词」快捷项要按 `slice(0, limit - 1)` 之后是不是空来决定出不出。那条
 * 理由随「动作不是结果」一起消失了(快捷项现在是 `actions`,不占结果的位置),
 * 而交全集是 `staticCapability` 能答出**真 `total`** 与偏移游标的前提 —— 一个
 * 已经被切成 6 条的表,后面还有 34 条这件事在结构上就丢了。
 *
 * 匹配器那一侧的 `slice(0, limit)` 因此变成恒等,一行都不用改。
 */
const STATIC_FULL_LIMIT = Number.MAX_SAFE_INTEGER

/** 一页的动作:能力给了就挂上,没给就一格都不加(缺席 = 没有动作)。 */
function withActions(page: SearchPage, actions: ActionDescriptor[] | undefined): SearchPage {
  return actions === undefined || actions.length === 0 ? page : { ...page, actions }
}

/**
 * 候选 → 结果:原样 + `target` + `facets` + (有的话)`preview`。
 *
 * 键序 = 那条记录的键序,新加的几格在最后。没驮记录的候选(不该发生,但绝不吞
 * 结果)按候选自己的话给一行。
 *
 * `preview` **没有就不加这一格**(不是 `preview: undefined`)—— 与 `toCandidates`
 * 里那条判据同源:契约上「缺席 = 这条没有预览」,而一个 undefined 值过 JSON 之后
 * 也会消失,两种写法在线上不可区分、在键比对上却是两件事。
 */
export function searchResultOf(candidate: Candidate): SearchServiceResult {
  const backing = (candidate as Partial<ResultBackedCandidate>).result
  const base: SearchServiceResult = backing === undefined
    ? {
        id: candidate.id,
        type: candidate.target.kind as SearchServiceResult['type'],
        title: candidate.title,
        subtitle: candidate.subtitle,
        timestamp: candidate.time,
        target: candidate.target,
        facets: candidate.facets,
      }
    : { ...backing, target: candidate.target, facets: candidate.facets }
  return candidate.preview === undefined ? base : { ...base, preview: candidate.preview }
}

function toCandidates(
  capability: string,
  rows: readonly SearchServiceResult[],
  target: ResultTargetOf,
  preview?: ResultBackedCapabilityOptions['preview'],
): ResultBackedCandidate[] {
  return rows.map((result, index) => {
    const candidate: ResultBackedCandidate = {
      capability,
      id: result.id,
      title: result.title,
      subtitle: result.subtitle,
      // 逆序名次:严格递减且唯一 → `defaultRanker` 的排序恒等,原次序原样保留。
      score: rows.length - index,
      time: result.timestamp,
      target: target(result),
      ranges: result.matchRanges,
      result,
    }
    // 缺席的 `preview` **一格都不加**:比的是键的在与不在,
    // 一个 `preview: undefined` 与「没有这一格」在 JSON 上是两件事。
    const inline = preview?.(result)
    return inline === undefined ? candidate : { ...candidate, preview: inline }
  })
}

/** 扫描型(§4.2 第二行):`total` 不给 —— 扫描器不知道全集有多大,不知道就别编。 */
export function scanBackedCapability(options: ResultBackedCapabilityOptions): SearchCapability {
  const manifest = options.manifest
  const supports = options.supports ?? (() => true)

  return {
    manifest,
    supports,
    async search(query: SearchQuery, page, ctx: SearchContext) {
      const rows = await options.run(query.raw, page.limit, query.filters)
      const candidates = toCandidates(manifest.id, rows, options.target, options.preview)
      const scanned = await scanCapability<ResultBackedCandidate>({
        manifest,
        supports,
        scan: async function* scan() {
          for (const candidate of candidates) yield candidate
        },
        match: () => candidate => candidate,
        positionOf: candidate => candidate.id,
      }).search(query, page, ctx)
      return withActions(scanned, options.actions?.(query, rows))
    },
  }
}

/** 静态型(§4.2 第三行):全量小表交上来,基座切页 —— `total` 是真数,游标是偏移形。 */
export function staticBackedCapability(options: ResultBackedCapabilityOptions): SearchCapability {
  const manifest = options.manifest
  const supports = options.supports ?? (() => true)

  return {
    manifest,
    supports,
    async search(query: SearchQuery, page, ctx: SearchContext) {
      const rows = await options.run(query.raw, STATIC_FULL_LIMIT, query.filters)
      const candidates = toCandidates(manifest.id, rows, options.target, options.preview)
      const paged = await staticCapability<ResultBackedCandidate>({
        manifest,
        supports,
        items: () => candidates,
        score: candidate => candidate.score,
        toCandidate: candidate => candidate,
      }).search(query, page, ctx)
      return withActions(paged, options.actions?.(query, rows))
    },
  }
}
