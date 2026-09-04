/**
 * S2 的过渡件:把「今天那个 `(query, limit) => SearchResult[]` 的扫描器」按 core 的
 * 基座包装成一个能力。
 *
 * 设计:docs/design/search-index-2026-09.md §4.2(三种基座)/ §10 S2 行
 * (「六个内置能力按三种基座包装,**消息那一路暂仍是旧扫描**」)。
 *
 * ## 为什么候选驮着一条旧结果走
 *
 * S2 的验收是 `search:parity-A`:新旧两条路的 `results` **逐字节相同**。而旧结果的
 * 键序、以及「哪些键在、哪些键因为值是 undefined 而不在」,是那六个扫描器一行行写
 * 出来的;重新投影一份等价的既证不出来、又马上要被 S3 换掉。所以这一期让候选驮着
 * 那条记录走,投影就是「原样 + `target`」——`LegacyBackedCandidate.legacy`。
 * S3 起 messages / chats / daily 换成索引型能力,候选自己就是真候选;这一格随旧扫描
 * 器一起删(§10 S5)。
 *
 * ## 为什么基座是**每次调用现造**的
 *
 * 旧扫描器的 `limit` 是**它自己语义的一部分**,不是外面切一刀就能等价的:
 * `searchMessages` 按 limit 提前收工(收工点决定翻到第几间会话),`searchPrompts`
 * 的「新建提示词」快捷项按 `slice(0, limit - 1)` 之后**是不是空**决定要不要出。
 * 而两个基座的 `scan` / `items` 都拿不到本次的 `page.limit`(它只到 `search()`)。
 * 所以基座在 `search()` 里、拿到 limit 之后才造。这是 parity 的价钱,不是形状问题。
 *
 * ## 分数 = 逆序名次
 *
 * 旧扫描器交回来的已经是**排好序、切好片**的一页。core 的 `defaultRanker` 会按
 * `score` 再排一次(组内排序,§6.5),所以这里给的分数是严格递减且互不相同的
 * 「逆序名次」——排序于是恒等,旧次序一格不动。
 */

import {
  scanCapability,
  staticCapability,
  type Candidate,
  type CapabilityManifest,
  type SearchCapability,
  type SearchContext,
  type SearchQuery,
} from '@onething/core/search'

/**
 * S2 里流动的那条结果 —— 今天的 `OnethingSearchResult` 加上 §8 新添的两格。
 *
 * 与契约层那份 `SearchResult` **同形不同命**:产品层不许 import 契约层
 * (`boundary` 执法 —— 连这行注释里都不许出现那个模块名),而契约那份要能过 JSON。
 * 两份同形是有意的,与 S1 里 `CapabilityManifest` 在 core 与契约各有一份是同一条判例。
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
}

/** 驮着旧结果的候选。`legacy` 这一格是 S2 专有的,S5 随旧扫描器一起删。 */
export interface LegacyBackedCandidate extends Candidate {
  readonly legacy: SearchServiceResult
}

/** 一条旧结果 → 它的目标形(§4.1 `target`,开放:形由能力自己定义并导出类型)。 */
export type LegacyTargetOf = (result: SearchServiceResult) => { kind: string; payload: unknown }

export interface LegacyCapabilityOptions {
  manifest: CapabilityManifest
  /** 今天那一路的扫描器,逐字调用,不在这里重写匹配或排序。 */
  run(query: string, limit: number): Promise<readonly SearchServiceResult[]> | readonly SearchServiceResult[]
  target: LegacyTargetOf
  /** 缺省 = 恒真(旧路在 `all` 档里对这一类是无条件调用的)。 */
  supports?(query: SearchQuery): boolean
}

/**
 * 候选 → 结果:原样 + `target` + `facets`。
 *
 * 键序 = 旧记录的键序,新加的两格在最后;所以 parity 门把这两格剥掉之后与旧路
 * **逐字节相同**。没驮旧记录的候选(不该发生,但绝不吞结果)按候选自己的话给一行。
 */
export function searchResultOf(candidate: Candidate): SearchServiceResult {
  const legacy = (candidate as Partial<LegacyBackedCandidate>).legacy
  if (legacy === undefined) {
    return {
      id: candidate.id,
      type: candidate.target.kind as SearchServiceResult['type'],
      title: candidate.title,
      subtitle: candidate.subtitle,
      timestamp: candidate.time,
      target: candidate.target,
      facets: candidate.facets,
    }
  }
  return { ...legacy, target: candidate.target, facets: candidate.facets }
}

function toCandidates(
  capability: string,
  rows: readonly SearchServiceResult[],
  target: LegacyTargetOf,
): LegacyBackedCandidate[] {
  return rows.map((legacy, index) => ({
    capability,
    id: legacy.id,
    title: legacy.title,
    subtitle: legacy.subtitle,
    // 逆序名次:严格递减且唯一 → `defaultRanker` 的排序恒等,旧次序原样保留。
    score: rows.length - index,
    time: legacy.timestamp,
    target: target(legacy),
    ranges: legacy.matchRanges,
    legacy,
  }))
}

/** 扫描型(§4.2 第二行):`total` 不给 —— 扫描器不知道全集有多大,不知道就别编。 */
export function legacyScanCapability(options: LegacyCapabilityOptions): SearchCapability {
  const manifest = options.manifest
  const supports = options.supports ?? (() => true)

  return {
    manifest,
    supports,
    async search(query: SearchQuery, page, ctx: SearchContext) {
      const rows = await options.run(query.raw, page.limit)
      const candidates = toCandidates(manifest.id, rows, options.target)
      return scanCapability<LegacyBackedCandidate>({
        manifest,
        supports,
        scan: async function* scan() {
          for (const candidate of candidates) yield candidate
        },
        match: () => candidate => candidate,
        positionOf: candidate => candidate.id,
      }).search(query, page, ctx)
    },
  }
}

/** 静态型(§4.2 第三行):全量小表,一次全给,`cursor` 恒缺席,`total` 是真数。 */
export function legacyStaticCapability(options: LegacyCapabilityOptions): SearchCapability {
  const manifest = options.manifest
  const supports = options.supports ?? (() => true)

  return {
    manifest,
    supports,
    async search(query: SearchQuery, page, ctx: SearchContext) {
      const rows = await options.run(query.raw, page.limit)
      const candidates = toCandidates(manifest.id, rows, options.target)
      return staticCapability<LegacyBackedCandidate>({
        manifest,
        supports,
        items: () => candidates,
        score: candidate => candidate.score,
        toCandidate: candidate => candidate,
      }).search(query, page, ctx)
    },
  }
}
