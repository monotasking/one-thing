/**
 * 会话总览(Exposé)的形状。和 stage/ 一样:这里只有数据,没有 React、没有 DOM。
 *
 * 总览是「状态机 + 投影」:ExposeView 是唯一的形态事实,
 * 分组 / 焦点序列 / 搜索命中全部由它 + 数据源派生,组件不许自己拼条件。
 *
 * ── D1(接真数据)之后这张表说的是**真事实** ────────────────────────────
 * 每个字段都能在 `@shared/ipc/chat.ts` 的 `SessionMeta` 上指出产地(见
 * expose/projection.ts 的逐条映射)。映射不到的旧 mock 字段**删掉而不是留空壳**:
 *  - `badges`(diff 条数 / 测试通过):后端没有这两个事实,留着就是每张卡都在说谎;
 *  - `unread`(未读数):同上,会话元数据里没有已读水位;
 *  - `members`(房间头像字):`room.memberAgentIds` 是 **agent id** 不是显示名,
 *    要显示名得接 agents 域 —— 那不在本批,所以这一格现在不存在;
 *  - `live`(房间实况行):没有产地。
 *  - `segments` / `userTurns`:它们不是列表事实,而是**进了某条会话之后**才按需
 *    拉的东西(getSegments / getMessagesPage),所以从列表模型里摘出去,
 *    各自成为数据源上的一份按会话缓存。
 */

/**
 * 行形态的口径。`@shared/ipc/chat.ts` 的 `SessionKind` 是四档
 * ('chat' | 'room' | 'work' | 'agent'),私聊是 `room.dm === true` 那条标记
 * —— 屏幕上要分的是**六**档,所以这里把那条标记摊平成两个字面量:
 *  · `dm`   = 人 ⇄ agent 的私聊(`room.dm` 且成员一位);
 *  · `swap` = agent ⇄ agent 的私聊(`room.dm` 且成员两位,`@shared/ipc/chat.ts`
 *    的 `RoomConfig.dm` 注释里那条「双成员 = agent ↔ agent 私聊」)。
 * 缺席的 kind 读作 'chat'(与后端「旧会话零迁移」的读法一致)。
 *
 * 加一档 = 这个联合加一格 + `row-kinds.ts` 的 `ROW_KIND_SPECS` 加一行 +
 * `projection.sessionKindOf` 一句 —— 别处不许再出现形态名的分支(§6 演练)。
 */
export type SessionKind = 'chat' | 'room' | 'dm' | 'swap' | 'work' | 'agent'

/**
 * 一条会话在**列表面**上的全部事实。产地一律 `sessions.listMeta` 的 `SessionMeta`。
 */
export interface SessionSummary {
  /** SessionMeta.id */
  id: string
  /** SessionMeta.name */
  title: string
  /** SessionMeta.kind(+ room.dm + 成员数)*/
  kind: SessionKind
  /**
   * SessionMeta.isPinned —— 用户手动置顶。缺席读作 **false**(不是 null):
   * 「没置顶」是一个真状态,不是一格缺失的事实。它是分节表的第一道判据
   * (置顶先于时间落桶,见 sections.ts),所以 `sameSession` 必须比它,
   * 否则按下图钉之后列表一动不动(数据源那条 equals 会判两份列表一样)。
   */
  isPinned: boolean
  /**
   * SessionMeta.collab?.roomSessionId —— 这条会话服务的**父房间**。
   * `work`(派工)与 `agent`(执行)两档才有;别的形态一律 null。
   *
   * 它是列表层级的**唯一**判据(list-model.attachChildren):父在集合里就挂上去,
   * 父不在就回顶层(孤儿不静默丢,用户 09-03 拍板)。
   * 会话与房间的关系是**数据**(后端 `CollabWorkRef`),不是列表现造的分组。
   */
  roomId: string | null
  /** 由 SessionMeta.workingDirectory 归一而来;null = 不属于任何项目 */
  projectId: string | null
  /**
   * SessionMeta.previewText —— **第一条用户消息的截断预览**,不是摘要。
   * 旧 mock 里这个字段叫 summary,那个名字会让人以为后端算过一段总结;没有。
   */
  preview: string
  /**
   * SessionMeta.lastMessagePreview —— **最后一条 user/assistant 消息的预览**
   * (共享层读侧补齐 E 批新增的一格,H 批接上)。它与 `preview` 是并列的两格
   * 而不是替换:一个说「从哪句话开的」,一个说「最近说到哪儿」。
   *
   * 缺席读作 null:写侧从那一批上线之后才维护,存量老会话本来就没有这一格
   * (后端**刻意不做启动期全量回填**)。null = 卡面不画这一行,也就不占高 ——
   * 「无产地的格不占位」在布局上的样子。
   */
  digest: string | null
  /**
   * SessionMeta.messageCount。缺席读作 null(老会话 / 后端还没算过);
   * **0 是真值不是缺席** —— 一条真的空会话就该说自己是 0 条。
   */
  messageCount: number | null
  /** SessionMeta.updatedAt(毫秒时间戳)。显示成什么样是渲染层的事。 */
  updatedAt: number
  /**
   * SessionMeta.lastModel —— **上一轮实际跑的模型**,不是「这条会话绑定了哪个模型」
   * (那要连 modelPinned 一起读才说得准)。缺席 = 这条会话还没跑过任何一轮,
   * 于是这一格不存在,卡面与 Quick Look 都不画 —— 不拿一个默认模型名去顶。
   */
  model: string | null
  /**
   * SessionMeta.lastProvider —— 上一轮那个模型是**哪一家**的。与 `model` 是一对
   * (D2 接真模型选择时补的):药丸上写的是模型名,而「切到这个模型」的上行
   * (`sessions.updateModel`)与「这个模型的窗口多大」(provider 目录)都得先
   * 知道是哪一家。缺席 = 只知道模型名不知道出处 —— 那时窗口读作**不知道**,
   * 不去所有家的目录里猜一个同名的。
   */
  provider: string | null
  /**
   * SessionMeta.agentId。`DEFAULT_AGENT_ID`('default')与缺席在这里都读作 null:
   * 「默认 agent」不是一条值得占一格徽的信息,满屏一个 default 等于没说。
   */
  agentId: string | null
  /**
   * SessionMeta.workspaceId —— 这条会话归属哪个工作区。
   *
   * **缺席读作 `'default'`,不是 null**,与后端「旧会话零迁移,读取端自己缺省」
   * 逐字同一条(契约 `@shared/ipc/chat.ts` 的 `SessionMeta.workspaceId`)。
   * 别的格缺席时给 null 是因为「没有这个事实」;这一格不一样 —— 会话总归属于
   * 某个空间,没写就是默认那个。
   *
   * 缺省**只在一个地方发生**:`projection.sessionBelongsToSpace`。全仓读这一格的
   * 只有它一个,所以这里保持可选(线上形状本来就是可选的)而不是逼
   * `toSessionSummary` 之外的每一份手搭夹具都补一格 —— 判据的单产地是那个函数,
   * 不是这个类型。
   */
  workspaceId?: string
}

/**
 * 项目 = 一个工作目录。**它是推导出来的**,不是一张后端表:
 * `SessionMeta.workingDirectory` 撞在一起的会话就成一组
 * (与 Vue 壳 `packages/renderer/stores/projects.ts` 顶部记的同一条判例)。
 */
export interface ProjectSummary {
  /** 归一后的绝对路径 —— 同时是分组键 */
  id: string
  /** 路径末段 */
  name: string
  /**
   * 副名那行显示的路径。当下 = 原样的绝对路径:把 home 折成 `~` 需要一个
   * 「home 在哪」的端口,渲染层没有,而按 store 路径的父目录去猜就是编。
   */
  path: string
}

/*
 * ── 09-04 P2:`SessionGroup` 已删 ────────────────────────────────────────
 * 「组」曾是总览的一行分区(项目组 / 协作组 / 独立组)。方向 A 之后它不再是
 * 列表的事实:列表只按时间分一次组(`sections.ts` 的 `SECTION_BUCKETS`),
 * 项目降级成侧栏的一格范围(`scopes.ts` 的 `SCOPE_SPECS`)。
 * 形状连同 `projection.buildGroups` / `sessions-source.groups` 一并退役,
 * 列表的唯一模型是 `list-model.buildListModel`。
 */

/**
 * 章节 = `sessions.getSegments` 的一条(`@shared/ipc/toc.ts` 的 `SessionSegment`)。
 * 只留屏幕要的那几格,`kind` 如实转述后端的 'task' | 'question' —— 不合并成一种。
 */
export interface SessionChapter {
  id: string
  title: string
  detail: string
  kind: 'task' | 'question'
  /** 章的起点消息;缺席 = 后端没记(旧账本),渲染层不许自己猜 */
  startMessageId?: string
}

/**
 * 一条用户消息的**锚点**(`sessions.getUserMarkers` 的 `UserMessageMarker`)。
 * 钢琴键一键对一条 —— 键是「我说过的话」的目录,不是全部消息的目录。
 */
export interface SessionMarker {
  id: string
  /** 后端截断好的那一行预览,直接当键上的标签。 */
  preview: string
}

/**
 * QuickLook 首页的一条消息。D1 只到「谁说的 + 说了什么」这一层:
 * 富渲染(markdown / 工具卡 / 流式)是 D3。
 */
export interface SessionPreviewMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | 'error'
  text: string
}

/**
 * **两层**视图,没有第三层 —— 「关着」不是内容的一种态(这块面在不在场由
 * Placement 说了算,08-29 去接管化拍板),而「进某个组的列表」这一层
 * 09-04 随方向 A 一起退役:总览与组列表合并成同一张树
 * (`docs/design/react-shell-sessions-list-2026-09.md` §1),
 * 于是没有可以钻进去的第二屏,`enterList` / `backToOverview` 一并删除。
 */
export type ExposeView =
  | { mode: 'overview' }
  | { mode: 'quicklook'; sessionId: string }

/**
 * 侧栏的**范围**(方向 A §1.3)。四档,前三档是恒定的合成范围,第四档带着
 * 一个项目目录(= `SessionSummary.projectId`)。
 *
 * 它是一个**联合而不是一个字符串**,因为 `project` 那一档携带参数;
 * 判据表在 `scopes.ts`(`SCOPE_SPECS`),这里只有形状。
 */
export type ProjectScope =
  | { kind: 'all' }
  | { kind: 'collab' }
  | { kind: 'loose' }
  | { kind: 'project'; projectId: string }

export interface ExposeState {
  view: ExposeView
  /** 总览里键盘焦点所在的卡;null = 还没落焦 */
  focusId: string | null
  /** 焦点环是否点亮:只有键盘导航(方向键 / Quick Look 换卡)才点亮;打开总览只设锚点、不亮环 */
  focusVisible: boolean
  /**
   * 侧栏选中的范围。缺省 `{ kind: 'all' }` —— 「打开就看见全部」是这块面的
   * 出厂语义;记住上次选的那一格是**家具**(按工作区分格持久化,见 store.ts)。
   *
   * 列数(`columns`)与折叠组(`collapsedGroups`)09-04 随卡网格与项目组
   * 一起退役:方向 A 的行是一维的(↑↓ 只走一行,不需要知道一行几张),
   * 分节不可折叠(§1.2)。
   */
  scope: ProjectScope
  /**
   * 展开着的房间 id。房间(room / dm / swap)的子行(work / agent)缺省收起,
   * 展开是一次用户动作 —— 与从前的 `collapsedGroups` 正好相反:那一格记的是
   * 「我关掉了谁」,这一格记的是「我打开了谁」,因为**缺省态换了边**
   * (顶层一行一条会话是这张表的常态,子行是展开才看的细节)。
   *
   * 搜索命中子行时父行**强制展开**,那是派生态(list-model 现算),不落这一格
   * —— 落进来的话清掉搜索词之后房间会莫名其妙地敞着。
   */
  expandedRooms: string[]
  /**
   * 收起来的分节 id(`pinned` / `today` / `yesterday` / `thisWeek` / `month:yyyy-mm`)。
   *
   * 与 `expandedRooms` **缺省态相反**,而且这一格是刻意的:分节缺省全开
   * (「打开就看见全部」),所以记的是「我关掉了哪几节」—— 与卡片时代那格
   * `collapsedGroups` 同一个方向,理由也同一条:落库的永远是**偏离缺省的那一半**,
   * 这样新加一个分节桶(比如「上周」)不会因为不在表里而默认收着。
   *
   * 分节 id **稳定**(不是下标、不含会话 id),所以它跟着工作区持久化是安全的:
   * 月桶那一族的 id 带年月,过期的键是一格无害的死键(那一节都不在了)。
   *
   * 搜索时**全开**是派生态(list-model 现算),不写进这一格 —— 落进来的话
   * 清掉词之后节会莫名其妙地全敞着(与房间强制展开逐字同一条)。
   */
  collapsedSections: string[]
  /** 搜索条内容;非空时列表只留命中的行与还剩行的节(形状不变,§1.4) */
  query: string
  /** 「当前会话」= TopBar 显示的那个。空串 = 还没有(数据未到 / 一条都没有)。 */
  currentSessionId: string
}

/**
 * 活动行的走法。**只剩一维** —— 卡网格时代的 ←→(在同一行里走一格)随网格
 * 一起退役;树上的 ←→ 不是「走一格」而是**树语义**(展开 / 收起 / 进子 / 回父),
 * 它有自己的入口(`transitions.treeKey`),不共用这个联合:
 * 两件事共用一个类型,正是从前 `moveFocus(state,'right')` 既像走位又像展开的来源。
 */
export type FocusDir = 'up' | 'down'

/*
 * ── F 批:`SearchHit` 退役 ────────────────────────────────────────────────
 * 曾经搜索是**另一种呈现**(三层缩进的命中列表),于是它需要一个自己的形状。
 * 现在搜索只是**喂给分组纯函数的一个过滤参数** —— 屏幕上仍是「项目头 + 卡网格」,
 * 只是不命中的卡与变空的组不在了(expose/transitions.ts 的 filterGroups)。
 * 一个过滤器不需要自己的结果类型:结果就是同一份 `ListModel`,和不搜时同一种东西。
 *
 * 随它一起退役的还有「章节也算命中」那一层:卡面上没有章节的位置,
 * 一张因为章节命中而出现、却没有任何高亮的卡只会让人以为过滤器坏了。
 * 章节数据本身没动(`ensureChapters` 仍在,检索面板与进入会话时照常用)。
 */

/** 高亮切片:hit=true 的段落由视图包 <mark>。 */
export interface HighlightPart {
  text: string
  hit: boolean
}
