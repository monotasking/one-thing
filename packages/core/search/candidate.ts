/**
 * 检索内核的词汇表:一次搜索里流动的那几种值。
 *
 * 设计:docs/design/search-index-2026-09.md §4.1 / §4.5 / §7.3
 *
 * 法条(§3 括号里那条,S0 由边界检查器 `checkCoreSearchNamesNoCapability` 执法):
 * 本目录不出现任何能力 id 字面量,也不在 `.kind` / `.capability` 上 switch。
 * 所以 `target` 与 `preview` 都是 `{ kind, payload }` —— core 对 payload 一无所知,
 * 形由能力自己定义并导出类型,壳按 kind 从渲染注册表取渲染器。
 */

/** 原文里的一段闭开区间 [start, end)。命名避开 DOM 的全局 `Range`。 */
export interface TextRange {
  start: number
  end: number
}

/** 一次搜索里「一条可能的结果」。能力只产它,流水线只吃它。 */
export interface Candidate {
  capability: string
  /** 能力内唯一、跨次稳定 */
  id: string
  title: string
  subtitle?: string
  /** title 内高亮(原文偏移) */
  ranges?: TextRange[]
  /** 能力内可比;跨能力不可比(§7.2 不混排) */
  score: number
  time?: number
  /** 开放:形由能力定义,壳按 kind 取渲染器 */
  target: { kind: string; payload: unknown }
  /** 键由能力的 manifest.facets 声明;core 只按键过滤,不解释 */
  facets?: Record<string, FacetValue>
  /** 富预览(开放,同 target) */
  preview?: PreviewPayload
  /** 层级结果:上级候选 id */
  parent?: string
  /** ctx.debug 时才填:分数拆解 / 命中词 */
  explain?: unknown
}

export type FacetValue = string | number | boolean

/**
 * 过滤片的取值形。core 只认这四种**形状**,不认识任何键名:
 * 标量 = 相等,数组 = 属于,`{ gte, lte }` = 区间,`{ not }` = 排除。
 */
export type FacetFilter =
  | FacetValue
  | FacetValue[]
  | { gte?: number; lte?: number }
  | { not: FacetValue | FacetValue[] }

/** 查询 AST。`type` 上分支是允许的(它不是能力的 kind)。 */
export type QueryNode =
  | { type: 'and'; children: QueryNode[] }
  | { type: 'or'; children: QueryNode[] }
  | { type: 'not'; child: QueryNode }
  | { type: 'term'; text: string; range: TextRange }
  | { type: 'phrase'; text: string; range: TextRange }

export interface SearchQuery {
  raw: string
  ast: QueryNode
  /** 由注册表里各 manifest 的 intentPrefixes 判出;都不中 = DEFAULT_INTENT */
  intent: string
  /** 键由各能力的 facets 声明;core 不解释 */
  filters: Record<string, FacetFilter>
  /** 意图之外还想只问一个能力时由调用方填;缺省 ALL_CAPABILITIES */
  capability?: string
  /**
   * 本次试的是放宽阶梯的哪一级(§6.2)。plan 产阶梯,fanout **对每个能力各自**
   * 逐级填这一格再调 `search()`,能力读它决定要不要 AND、短语要不要相邻。
   * 缺席 = 最严的那一级。
   */
  ladder?: LadderStep
}

/** 放宽阶梯的一级。plan 产它,fanout 逐级试,能力读它。 */
export interface LadderStep {
  level: RelaxLevel
  /** 这一级要求命中几个词。数的是**查询 AST 里的词**,不是分析器切出来的词元 */
  minShouldMatch: number
  /** 短语要不要相邻 */
  phraseAdjacent: boolean
  /**
   * **一个查询词分析成多个词元时,这一级把它看成什么**(§6.2)。
   *
   * `'phrase'` = 一体:`2026-09-05` 切成 `2026` `09` `05`,这一级要求三个词元**一起
   * 出现**(①还要求相邻,②只要求同在一个字段里),与用户手打 `"…"` 短语走同一条
   * 翻译。`'split'` = 摊平成三个独立词元,由 `minShouldMatch` 说了算。
   *
   * 为什么要这一格而不是拿 `minShouldMatch` 推:单个查询词的查询在四级上
   * `minShouldMatch` 都是 1(`Math.max(1, ceil(1/2))` 也是 1),推不出「这一级还认
   * 不认词的完整性」。少了它,`①严格 = 全 AND` 在「一个词摊成多词元」这一形上就是
   * OR —— `2026-09-05` 把 `2026-09-06` 也召回来(S3b 读数,§13)。
   */
  multiTokenTerms: 'phrase' | 'split'
}

/** 缺省意图:没有任何能力的前缀命中时的意图名。 */
export const DEFAULT_INTENT = 'content'

/** 「全部档」的能力选择子。它不是一个能力 id,是「不挑」。 */
export const ALL_CAPABILITIES = 'all'

export interface PageRequest {
  limit: number
  cursor?: string
}

/** 放宽阶梯的级数(§6.2):0 = 严格,3 = 单词。 */
export type RelaxLevel = 0 | 1 | 2 | 3

export interface SearchPage {
  items: Candidate[]
  /** 缺席 = 不知道(§7.3);壳不许用「回来的比要的少」猜 */
  total?: number
  /** 缺席 = 取尽 */
  cursor?: string
  relaxed?: RelaxLevel
  took: number
  /**
   * **这一页上能做的动作**,与 `items` 分开的一格(检索面终稿 §0 ③)。
   *
   * 「新建一条叫 jira 的提示词」不是一条搜到的东西:它不该占配额、不该计进
   * `total`、不该被当成命中。能力从前只能把它 `unshift` 进 `items` 里冒充结果,
   * 因为页上没有第二个地方放它 —— 这一格就是那个地方。
   *
   * core 不解释动作的 `kind`,也不认识任何一个动作 id(法条同 `target`)。
   * 缺席 = 这一页没有动作。
   */
  actions?: ActionDescriptor[]
}

/** 一次搜索的现场:唯一带「谁 / 在哪 / 还要不要」的东西。 */
export interface SearchContext {
  principal: SearchPrincipal
  /** Captured host authority; search targets and product-space filters never set it. */
  executionContext?: unknown
  /** 消费面:命令面板 / 输入框 / CLI / agent 工具 / 插件自报 —— core 不枚举 */
  surface: string
  spaceId: string
  /** 换词即取消 */
  signal: AbortSignal
  /** 填 Candidate.explain */
  debug?: boolean
  now: number
}

export interface SearchPrincipal {
  kind: 'user' | 'agent' | 'plugin'
  id: string
  sessionId?: string
}

/** 一个能力答完就出一组(§6.5b)。失败 / 超时 = 这一组带 error,不拖死别组。 */
export interface GroupResult {
  capability: string
  page?: SearchPage
  error?: string
}

/** 预览的「媒介描述」,不是文本(§4.5 ②)。 */
export interface PreviewPayload {
  kind: string
  payload: unknown
  title?: string
  actions?: ActionDescriptor[]
}

/**
 * 结果上的动作(§4.5 / §4.6)。`kind` 开放:'open' / 'copy' / 'continue' …
 * `continue` 那一类带一个 SearchScope,壳把它落成「替换当前查询状态」。
 */
export interface ActionDescriptor {
  id: string
  kind: string
  label?: string
  danger?: boolean
  payload?: unknown
  /**
   * **文案键**(检索面终稿 R12:后端只交数据,给人看的句子由壳按键查出)。
   *
   * `label` 那一格是**成品文案**(能力自己写的字),它上了屏就是后端在替壳说话,
   * 而且必然只有一种语言。新代码填这一格;`label` 留着不删,它有旧读者。
   */
  labelKey?: string
  /**
   * `labelKey` 的插值格。「新建提示词 “jira”」里的 `jira` 依赖**这一次的查询词**,
   * 所以句子拼不得,只能把料交出去。
   */
  params?: Record<string, string | number>
  /** 按下去要 `invoke` 哪个能力;页级动作没有这一格就问不出该找谁。 */
  capability?: string
}

/** 续搜的值对象(§4.6):三格一起换。 */
export interface SearchScope {
  capability?: string
  query?: string
  filters?: Record<string, FacetFilter>
}
