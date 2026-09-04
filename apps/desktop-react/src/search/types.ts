/**
 * 检索面的形状。和 expose/ 一样:这里只有数据,没有 React、没有 DOM。
 *
 * 终稿的形状决定了这张表长什么样:面板上**只有一张平铺列表**,没有分组、没有分栏,
 * 所以模型里也不能有「组」这一层 —— 一行就是 SearchRow,列表就是 SearchRow[]。
 * 会话命中和文件命中在同一条流水线上被造出来,靠 domain / badge 区分,不靠两棵树。
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
 * 素材来自哪一侧。**这一格不再决定过滤** —— 过滤看 `SearchRow.capability`
 * (哪个能力产的这一行),`domain` 只剩「排序时会话与文件交替」那一处消费
 * (`transitions.ts` 的 `interleave`),那是**版式**不是分类。
 */
export type SearchDomain = 'session' | 'file'

/**
 * 行首那颗空心小徽上的字。**两种产地,所以是可辨识联合而不是一个字符串**:
 * `labelKey` 那种是界面文案(换语言要变,走字典),`text` 那种是从数据推出来的
 * (`.ts` → `TS`,换语言不该变)。混成一个 string 就分不清谁该进字典了。
 *
 * S4a 起这一格**由目标渲染器答**(`targets/registry.ts` 的 `badge(row)`),
 * 不再是行自己驮着的一个字段 —— 「这一类的徽写什么」是那一类自己的事。
 */
export type SearchBadge = { labelKey: string } | { text: string }

/**
 * 跳转目标 —— **开放形**(S4a;契约 `SearchResult.target` 与 `Candidate.target`
 * 的同一个形)。
 *
 * 从前这里是 `{kind:'session'} | {kind:'file'}` 一个闭合联合。开放的理由是
 * §4.0 的硬指标:加一种能搜的东西,壳里允许动的只有「它自己的渲染模块 + 一行注册」;
 * 一个闭合联合意味着每加一类都要改这个类型、改 `activate` 那个 switch、改 badge 那个
 * switch —— 三处枚举点。今天 `kind` 由能力自述,壳按它从**目标渲染注册表**取组件,
 * `payload` 的形只有那个渲染器认识(它与能力模块是一对)。
 */
export interface SearchTarget {
  kind: string
  payload: unknown
}

/**
 * 行尾那行灰色小字的**素材**,不是成品字符串 —— 拼法(`:`、` · `)由
 * transitions 的 originText 定一次,组件不许自己拼。
 */
export type SearchOrigin =
  /** 消息 / 章节命中 → 所属会话名 */
  | { kind: 'session'; session: string }
  /** 文件行命中 → 文件名:行号 */
  | { kind: 'fileLine'; file: string; line: number }
  /** 会话标题命中 → 项目名 · 时间 */
  | { kind: 'projectTime'; project: string; time: string }
  /** 不属于任何项目的会话,以及空态的最近会话 → 只剩时间 */
  | { kind: 'time'; time: string }
  /** 文件名命中,以及空态的最近文件 → 路径 */
  | { kind: 'path'; path: string }

/**
 * 排序只有两级,**不是按类型分堆**:
 * 标题 / 文件名 / 章节标题命中(title)整体排在正文 / 代码行命中(body)之前,
 * 同级里会话与文件交替出现,各自保持自己那张表的次序。
 */
export type SearchTier = 'title' | 'body'

/** 一段命中区间(后端 `SearchResult.matchRanges` 的形状,半开区间 `[start, end)`)。 */
export interface HighlightRange {
  start: number
  end: number
}

export interface SearchRow {
  id: string
  /**
   * **哪个能力产的这一行**(S4a)。单类档的过滤只看它 —— 从前看的是
   * `domain`(session / file 两值),那张表装不下六个能力,更装不下插件能力。
   * 取值与 `search.capabilities` 回来的 `manifest.id` 逐字同。
   */
  capability: string
  domain: SearchDomain
  /** 中间的主角:命中原文一行(视图负责高亮与省略号) */
  text: string
  /** 代码行用等宽字体 */
  code: boolean
  origin: SearchOrigin
  target: SearchTarget
  tier: SearchTier
  /**
   * 键由产它的能力 `manifest.facets` 声明,**宿主不解释**(契约 `SearchResult.facets`
   * 原样搬过来)。壳只按键读它认得的那两个来画徽(归档 / 空间,§9「徽」那一条),
   * 别的键原样留着 —— 不认识不等于该丢掉。
   */
  facets?: Record<string, unknown>
  /**
   * 这一行的高亮**由产地给定**(09-02 正文检索)。缺席 = 视图照当前的词自己切
   * (会话 / 文件那两路本来就是本地滤出来的,词与文本都在手上)。
   *
   * 在场的那一路是消息正文:命中是**后端**判出来的,片段也是它截的
   * (前后各留一段 + 省略号)。让视图拿本地的词再 indexOf 一遍会有两个产地各说
   * 一次「什么算命中」—— 后端的 `normalizeQuery` 剥掉了开头的 `>` 与 `/`,
   * 本地那一遍不会,于是同一个词两边切出来的片能对不上。
   */
  highlight?: readonly HighlightRange[]
}

/**
 * 一条**正文命中**的素材(`data/message-search-source.ts` 交下来的那一份)。
 *
 * 它是后端 `SearchResult` 的一次**收窄**,不是「在契约旁边立第二份形状」:
 * 契约上那张表要同时装得下 action / prompt / file 几种命中,所以 `sessionId` /
 * `messageId` 都是可选的;而这一路的行必须**能落地**(点它要进会话、滚到那条
 * 消息),缺一格就画不出来。收窄只发生一次(在数据源那只 `toHits` 里),
 * 于是下游没有一处需要再判 `if (!hit.sessionId)`。
 */
export interface MessageHit {
  /** 后端给的 id(`msg:<sessionId>:<messageId>`);缺席时由数据源按同一形状补。 */
  id: string
  sessionId: string
  messageId: string
  /** 后端截好的片段(命中前后各留一段,两头可能带省略号)。 */
  text: string
  /** 后端判出来的命中区间,坐标落在 `text` 上。空表 = 这一行不高亮。 */
  ranges: readonly HighlightRange[]
  /**
   * 产它的能力 `manifest.facets` 声明的那几格,**宿主不解释**(S4a)。
   *
   * 壳只按键读它认得的两个来画徽(归档 / 空间,§9「徽」那一条)。归档那一格
   * 尤其要紧:S3b 之后**归档会话里的消息搜得到了**(索引照建它们的文档),
   * 所以屏幕上必须能一眼看出这一行来自一间已归档的会话 —— 否则「搜得到」
   * 就成了「悄悄混进来」。缺席 = 后端没给这几格,一颗徽都不画。
   */
  facets?: Record<string, unknown>
}

/*
 * 后端那份 `SearchResult` 上还有三格**没有搬过来**,理由逐条:
 *  · `timestamp` —— 正文行的出处画的是**所属会话名**(与章节行同一形),
 *    没有一处画消息时刻;搬一格没人读的字段就是留一个将来会和真相漂开的副本。
 *  · `subtitle`(后端给的会话名)—— 会话名的产地是壳里那张会话表(改名走 SSE
 *    增量,后端这一份是查询那一刻的快照)。**两个产地说同一个名字**,只留一个。
 *  · `detail`('User message' / 'Assistant message')—— 它是后端硬编码的英文,
 *    而界面文案要查字典。要画角色就得由徽或行自己去说,不能直接铺一句英文。
 */

/* ── 文件侧素材 ──────────────────────────────────────────────────────────
 * D5 之后这里**一个类型都没有**:文件侧的素材就是 `@shared/ipc/files` 的
 * `FileSearchEntry`(后端契约),壳不再在它旁边立第二份形状。
 * 旧的 `FileMock` / `FileLineMock`(假路径 + 假代码行)随 mock 一起退役,
 * 理由写在 ./data.ts 顶部。
 * ────────────────────────────────────────────────────────────────────── */
