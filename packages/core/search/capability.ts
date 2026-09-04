/**
 * 能力自述(manifest)与能力注册表 —— 联邦骨架的那一格。
 *
 * 设计:docs/design/search-index-2026-09.md §4.1b / §4.2 / §4.3
 *
 * 这里是「凡按能力枚举的地方改成能力自述、别人读表」那条法的落点:
 * parse 的意图前缀、budgetPolicy 的配额、全部档的分组次序、索引的字段与权重、
 * 打分的半衰与加权、放宽阶梯跑不跑、谁能看 —— 全部由能力在 manifest 里说,
 * 流水线各段只是「读表然后算」的纯函数,里面没有任何能力的名字。
 */

import type {
  Candidate,
  FacetFilter,
  PageRequest,
  PreviewPayload,
  SearchContext,
  SearchPage,
  SearchPrincipal,
  SearchQuery,
} from './candidate.js'
import type { DocumentFeed } from './feed.js'

/** 能力对外说的全部话。 */
export interface CapabilityManifest {
  id: string
  labelKey: string
  /** 宿主图标名;core 不解释 */
  icon: string
  kind: CapabilityKind
  /** 例:命令类能力自报 ['/', '>'];符号类自报 ['#', '@']。core 里没有前缀字面量 */
  intentPrefixes?: string[]
  budget: CapabilityBudget
  facets?: FacetDeclaration[]
  /** 索引型才有:字段 → 分析器 id + 权重 */
  schema?: Record<string, FieldSchema>
  /** 全部档分组的缺省次序 */
  order: number
  orderWhenIntent?: Record<string, number>
  /** 谁能看(§6.4b);缺省 = 全可见 */
  visibility?: VisibilityRule
  /** 只在哪些消费面参与;缺省全部 */
  surfaces?: string[]
  /**
   * 吃不吃放宽阶梯(§6.2)。false = 只跑第 ① 级 —— scan / static / remote 型
   * 的匹配语义自带模糊,再放宽没有意义。缺省 true。
   */
  relax?: boolean
  /** 缺省打分器读的那格数据(§6.5);core 里没有 role / title 这些词 */
  ranking?: RankingDeclaration
  /** 召回路的开关(§15.4);数据,不是 if */
  retrievers?: { vector?: { when: VectorRetrieverWhen } }
  /** 预览是随候选带还是选中再取(§4.5 ①) */
  preview?: { mode: 'inline' | 'lazy' }
}

export type CapabilityKind = 'indexed' | 'scan' | 'static' | 'remote'

export type VectorRetrieverWhen = 'relaxed' | 'explicit' | 'always'

export interface CapabilityBudget {
  default: number
  timeoutMs: number
  whenIntent?: Record<string, number>
}

export interface FacetDeclaration {
  key: string
  type: 'enum' | 'range' | 'boolean'
  values?: string[]
}

export interface FieldSchema {
  analyzer: string
  weight: number
  /** S7:这一字段进不进向量索引 */
  embed?: boolean
}

/**
 * 缺省打分器的数据(§6.5)。半衰、按 facet 值加权、某字段命中就置顶 —— 三格全是
 * 数据:messages 声明 `boosts: { role: { user: 1.1 } }`,core 只是照着乘。
 */
export interface RankingDeclaration {
  halfLifeDays?: number
  /** facet 键 → 值 → 乘数 */
  boosts?: Record<string, Record<string, number>>
  /** 这一字段命中的候选置顶 */
  pinFieldHit?: string
}

/**
 * 授权是查询的输入,不是结果的过滤(§6.4b)。
 * 规则收「谁在问」,答「这个人能看的范围」;范围的形由能力定义,fanout 在调
 * `search()` 之前把它塞进 `SearchQuery.filters`,于是 total / cursor / relaxed
 * 都是授权之后的真数。
 */
export type VisibilityRule = (principal: SearchPrincipal) => VisibilityScope

/** 范围形是开放的:键由能力定义,core 只负责搬进 filters。 */
export type VisibilityScope = Record<string, FacetFilter>

/** 能力接口只有这一份(§4.2:v2 那份平铺 id / labelKey 的旧形已删)。 */
export interface SearchCapability {
  readonly manifest: CapabilityManifest
  /** 自己答空词 / 命令语法 / 路径语法 —— switch 不替它答 */
  supports(query: SearchQuery): boolean
  search(query: SearchQuery, page: PageRequest, ctx: SearchContext): Promise<SearchPage>
  /** 索引型自带来源(§5.2b);索引服务从这里收 */
  feed?: DocumentFeed
  /** 选中一条(或几条)时的富预览(§4.5);lazy 模式才有意义 */
  preview?(candidates: Candidate[], ctx: SearchContext): Promise<PreviewPayload>
  /** 两条同 kind 的候选可以给一个更好的形(如 diff) */
  compare?(a: Candidate, b: Candidate, ctx: SearchContext): Promise<PreviewPayload>
  /** 结果上的后端动作(§8 invoke 路由) */
  invoke?(actionId: string, candidates: Candidate[], ctx: SearchContext): Promise<void>
}

export class DuplicateCapabilityError extends Error {
  readonly capabilityId: string

  constructor(capabilityId: string) {
    super(`search capability already registered: ${capabilityId}`)
    this.name = 'DuplicateCapabilityError'
    this.capabilityId = capabilityId
  }
}

export interface CapabilityRegistry {
  /** 重名抛;返回注销 */
  register(capability: SearchCapability): () => void
  get(id: string): SearchCapability | undefined
  /** 注册顺序 = 缺省展示顺序 */
  list(): SearchCapability[]
  has(id: string): boolean
  size(): number
}

export function createCapabilityRegistry(): CapabilityRegistry {
  // Map 的迭代顺序就是插入顺序 —— list() 的「按注册序」不需要另记一张表。
  const map = new Map<string, SearchCapability>()

  return {
    register(capability) {
      const id = capability.manifest.id
      if (map.has(id)) throw new DuplicateCapabilityError(id)
      map.set(id, capability)
      let disposed = false
      return () => {
        if (disposed) return
        disposed = true
        // 只删自己那一条:注销晚到时不许把后来注册的同名能力顺手删掉。
        if (map.get(id) === capability) map.delete(id)
      }
    },
    get: id => map.get(id),
    list: () => [...map.values()],
    has: id => map.has(id),
    size: () => map.size,
  }
}

/** 这个能力参不参与这一次搜索的消费面(manifest.surfaces 缺省 = 全部)。 */
export function capabilityServesSurface(manifest: CapabilityManifest, surface: string): boolean {
  return manifest.surfaces === undefined || manifest.surfaces.includes(surface)
}

/** 全部档的分组次序(§7.2):命中意图时用 orderWhenIntent。 */
export function capabilityOrder(manifest: CapabilityManifest, intent: string): number {
  return manifest.orderWhenIntent?.[intent] ?? manifest.order
}
