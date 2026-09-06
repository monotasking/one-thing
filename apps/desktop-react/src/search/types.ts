import type { SearchPreviewPayload } from '@shared/ipc/search'

/**
 * 检索面的形状。和 expose/ 一样:这里只有数据,没有 React、没有 DOM。
 *
 * 终稿的形状决定了这张表长什么样:一行就是 SearchRow,列表就是 SearchRow[];
 * **块**不是行模型里的一层 —— 它由后端的 `groups` 说,由数据层的
 * `SearchListing.blocks` 装(`data/search-listing-source.ts`),序列由
 * `sequence.ts` 一次 flatten 产出。(第 ⑨ 步改口:从前这里指的
 * `transitions.ts` 的 `SearchSection` 与分节那台机整台删了。)
 */

/**
 * 此刻选中的那一档:**一个能力 id,或 `'all'`**(S4a)。
 *
 * 从前它是 `'all' | 'sessions' | 'files'` 三个字面量 —— 那正是 §4.0 那张枚举点
 * 清账表要拆掉的东西:加一类能搜的东西就得改这个联合。今天档位由
 * `search.capabilities` 回来的自述算出来(`../capabilities.ts` 的 `tabsOf`),
 * 所以这里放宽成 `string`,「这个档认不认」由那张表答,不由一个联合答。
 */
export type SearchScope = string

/**
 * 行首那颗空心小徽上的字。**两种产地,所以是可辨识联合而不是一个字符串**:
 * `labelKey` 那种是界面文案(换语言要变,走字典),`text` 那种是从数据推出来的
 * (`.ts` → `TS`,换语言不该变)。混成一个 string 就分不清谁该进字典了。
 *
 * 这一格**由目标渲染器答**(`targets/registry.ts` 的 `badge(row)`),
 * 不是行自己驮着的一个字段 —— 「这一类的徽写什么」是那一类自己的事。
 */
export type SearchBadge = { labelKey: string } | { text: string }

/**
 * 跳转目标 —— **开放形**(契约 `SearchResult.target` 与 `Candidate.target` 的同一
 * 个形)。开放的理由是 §4.0 的硬指标:加一种能搜的东西,壳里允许动的只有
 * 「它自己的渲染模块 + 一行注册」;一个闭合联合意味着每加一类都要改这个类型、
 * 改 `activate` 那个 switch、改 badge 那个 switch —— 三处枚举点。
 * 今天 `kind` 由能力自述,壳按它从**目标渲染注册表**取组件,`payload` 的形只有
 * 那个渲染器认识(它与能力模块是一对)。
 */
export interface SearchTarget {
  kind: string
  payload: unknown
}

/**
 * 行尾那行灰色小字的**素材**,不是成品字符串 —— 拼法(`:`、` · `)由
 * transitions 的 originText 定一次,组件不许自己拼。
 *
 * S4b 之后**产地只剩一个**:后端候选的 `subtitle` / `detail`,于是造出来的永远是
 * `path` 那一支。另外四支**留着**,理由不是「将来也许有用」:`originText` 是这一
 * 族的**唯一拼法产地**,而 `targetText`(通知里那句「已打开 …」)今天就在用
 * `fileLine`。真到一条能力开始自己说「我的出处是项目 · 时间」时,它落的也是这张表。
 */
export type SearchOrigin =
  /** 消息 / 章节命中 → 所属会话名 */
  | { kind: 'session'; session: string }
  /** 文件行命中 → 文件名:行号 */
  | { kind: 'fileLine'; file: string; line: number }
  /** 会话标题命中 → 项目名 · 时间 */
  | { kind: 'projectTime'; project: string; time: string }
  /** 不属于任何项目的会话 → 只剩时间 */
  | { kind: 'time'; time: string }
  /** 后端候选的 `subtitle` / `detail`(S4b 起唯一在产的那一支) */
  | { kind: 'path'; path: string }

/** 一段命中区间(后端 `SearchResult.matchRanges` 的形状,半开区间 `[start, end)`)。 */
export interface HighlightRange {
  start: number
  end: number
}

export interface SearchRow {
  id: string
  /**
   * **哪个能力产的这一行**。单类档的过滤、`all` 档的分组、预览请求里那条
   * `SearchItemRef.capability` 都读它。取值与 `search.capabilities` 回来的
   * `manifest.id` 逐字同。
   */
  capability: string
  /** 中间的主角:命中原文一行(视图负责高亮与省略号)。 */
  text: string
  origin: SearchOrigin
  target: SearchTarget
  /**
   * 键由产它的能力 `manifest.facets` 声明,**宿主不解释**(契约 `SearchResult.facets`
   * 原样搬过来)。壳只按键读它认得的那两个来画徽(归档 / 空间,§9「徽」那一条),
   * 别的键原样留着 —— 不认识不等于该丢掉。
   */
  facets?: Record<string, unknown>
  /**
   * 这一行的高亮**由产地给定**。缺席 = 视图照当前的词自己切。
   *
   * 在场的那一路是后端判出来的命中:片段也是它截的(前后各留一段 + 省略号)。
   * 让视图拿本地的词再 indexOf 一遍会有两个产地各说一次「什么算命中」——
   * 后端的 `normalizeQuery` 剥掉了开头的 `>` 与 `/`,本地那一遍不会,
   * 于是同一个词两边切出来的片能对不上。
   */
  highlight?: readonly HighlightRange[]
  /**
   * **随候选带的预览**(§4.5 ①的 `mode: 'inline'`;S4b 起有消费者)。
   *
   * 只有自述里说了 `preview: { mode: 'inline' }` 的能力才会有这一格(今天是
   * `chats`)。有它 = 选中这一行时预览窗**当场就有内容**,一发请求都不出门;
   * 缺席 = 走 `search.preview` 那条 lazy 路。
   */
  preview?: SearchPreviewPayload
  /**
   * **哪条召回器造的这枚候选**(契约 `SearchResult.source`;检索面终稿 §6「语义徽」)。
   * `vector` 的行右列多一枚「语义」小徽 —— 说实话,不装成字面命中。
   */
  source?: 'lexical' | 'vector'
  /**
   * **这一行没有标题**(检索面终稿 §6「无标题会话」)。
   *
   * 后端把占位名(`New Chat`)归了空 —— 它不是标题,是「这间还没起名」的另一种
   * 写法。归空之后画什么是**壳**的事:首条用户消息顶上(`text` 已经换成它),
   * 两样都没有时这一格为真,由行画「未命名会话」。
   */
  untitled?: boolean
}
