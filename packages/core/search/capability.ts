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
  /**
   * 召回路的开关(§15.4)。**键是召回器的 id,不是「向量」这个词** —— core 只知道
   * 「这一路有没有一条什么时候跑的规矩」,不知道哪一路是向量路。加第三条召回路
   * (符号 / 结构查)= 这张表里多一行,core 一个字不改。
   *
   * 缺席的召回器 = `'always'`(词法路从来不用声明)。
   */
  retrievers?: Record<string, RetrieverPolicy>
  /** 预览是随候选带还是选中再取(§4.5 ①) */
  preview?: { mode: 'inline' | 'lazy' }
  /**
   * **空词时我有浏览态**(S4b;09-01 用户裁定「所有档空词 = 全部会话列表、
   * 看得到总条数、翻得了页」)。
   *
   * 零词元的查询对索引恒零命中,所以「空输入框里列什么」这件事只有能力自己
   * 答得出:chats 有(旧 `searchChats('')` = 按 `updatedAt` 取前 N 间),
   * 别的能力今天都没有。缺席 = 没有浏览态。
   *
   * 宿主(壳)因此**不必认识任何能力的名字**就画得出空词那一屏:读这一格,
   * 声明了的各占一组。core 自己不读它 —— 它是一句**自述**,给壳读的。
   */
  browse?: boolean
}

export type CapabilityKind = 'indexed' | 'scan' | 'static' | 'remote'

export interface RetrieverPolicy {
  when: RetrieverWhen
  /**
   * **距离上限**(向量路专用的一格数据;缺席 = 不设限)。
   *
   * 施工时量出来的一件事,写在这里免得下一个人再踩:**KNN 没有下限**。
   * `WHERE embedding MATCH ? AND k = 5` 答的永远是「最近的 5 条」,哪怕它们跟查询
   * 毫无关系 —— 在一间只有两条消息的 store 上,任何一句话都能把那两条都召回来
   * (`gate:search-index` ⑧ 的第一版控制组就是被这一条打红的)。
   *
   * 今天**故意留空**:合适的阈值要拿真模型在真库上的读数定,而 e5 这类模型的余弦
   * 相似度天生偏高、不相关的一对也常在 0.7 以上,凭空拍一个数会把该召回的也切掉。
   * 机制先放在这里、由能力自述,定值是另一件事(§13 留账)。
   *
   * 单位是索引答的 `distance`(单位向量上的 L2:`sqrt(2 - 2cos)`,余弦 0.5 ↔ 距离 1.0)。
   */
  maxDistance?: number
  /**
   * `when: 'explicit'` 时,**哪些消费面算「明说要了」**。能力自己列(`['agent-tool']`),
   * core 不认识任何一个消费面的名字。缺席 = 只认调用方显式打开的那个开关。
   */
  surfaces?: string[]
}

/**
 * 一条召回路什么时候跑(§15.4)。**判据全是查询自己的事实**,core 里没有能力名、
 * 也没有召回器名:
 *
 * | 值 | 判据 |
 * | --- | --- |
 * | `'always'` | 每次都跑 |
 * | `'relaxed'` | 严格档零命中、走到放宽阶梯 ② 及以后才跑(`ladder.level >= 1`) |
 * | `'explicit'` | 调用方明说要:`query.filters.semantic === true`,或 `ctx.surface` 在 `alwaysOnSurfaces` 里 |
 *
 * `'relaxed'` 那条的理由是预算:查询嵌入本身要 ~40ms,命令面板边打边出的 < 10ms
 * 容不下它;而「词法严格档已经有答案」的时候本来也不需要它。
 */
export type RetrieverWhen = 'relaxed' | 'explicit' | 'always'

/** 旧名。S1 定的时候这张表只有向量一行,S7 接上去才发现键该是召回器 id。 */
export type VectorRetrieverWhen = RetrieverWhen

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

/**
 * 预览请求上除了「哪几条」之外的话(检索面终稿 §4)。
 *
 * 今天只有一格:**列表上那次查询的词**。预览里的高亮必须与列表行是同一个产地,
 * 否则壳只能自己再匹配一遍 —— 那是第二套「什么算命中」。第三个参数而不是塞进
 * `SearchContext`:`ctx` 是「谁在什么现场问」,查询词是**这一次请求**的内容,
 * 而搜索流水线从不设它。**可选**,所以两参数的旧实现照样满足这个接口。
 */
export interface PreviewOptions {
  query?: string
}

/** 能力接口只有这一份(§4.2:v2 那份平铺 id / labelKey 的旧形已删)。 */
export interface SearchCapability {
  readonly manifest: CapabilityManifest
  /** 自己答空词 / 命令语法 / 路径语法 —— switch 不替它答 */
  supports(query: SearchQuery): boolean
  search(query: SearchQuery, page: PageRequest, ctx: SearchContext): Promise<SearchPage>
  /** 索引型自带来源(§5.2b);索引服务从这里收 */
  feed?: DocumentFeed
  /** 选中一条(或几条)时的富预览(§4.5);lazy 模式才有意义 */
  preview?(candidates: Candidate[], ctx: SearchContext, options?: PreviewOptions): Promise<PreviewPayload>
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
