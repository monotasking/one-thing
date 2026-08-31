import type { MessageKey } from '../i18n'

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
 * 形态徽的口径。`@shared/ipc/chat.ts` 的 `SessionKind` 是四档
 * ('chat' | 'room' | 'work' | 'agent'),再加一条 `room.dm === true` 的私聊标记
 * —— 屏幕上要分的正是五档,所以这里把那条标记摊平成第五个字面量。
 * 缺席的 kind 读作 'chat'(与后端「旧会话零迁移」的读法一致)。
 */
export type SessionKind = 'chat' | 'room' | 'dm' | 'work' | 'agent'

/**
 * 一条会话在**列表面**上的全部事实。产地一律 `sessions.listMeta` 的 `SessionMeta`。
 */
export interface SessionSummary {
  /** SessionMeta.id */
  id: string
  /** SessionMeta.name */
  title: string
  /** SessionMeta.kind(+ room.dm)*/
  kind: SessionKind
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

/**
 * 组是「总览的一行分区」,不是一张新表:项目组的 id 就是 projectId,
 * 协作 / 独立组的 projectId 是 null(它们的会话本来就不属于任何项目)。
 */
export interface SessionGroup {
  id: string
  /**
   * 组名 / 副名有两种来源,恰有其一:
   * - 项目组:name / path 是**数据**(目录末段与磁盘路径),换语言不该变;
   * - 合成组(协作 / 独立会话):nameKey / pathKey 是**界面文案**,换语言要变。
   * 所以这里不是「可选字段」而是「两条来源」,消费方一律 key 优先。
   */
  name?: string
  nameKey?: MessageKey
  path?: string
  pathKey?: MessageKey
  projectId: string | null
  sessions: SessionSummary[]
}

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
 * 三层视图,没有第四层 —— 「关着」不再是内容的一种态:
 * 这块面在不在场由 Placement 说了算(08-29 去接管化拍板),
 * 所以状态机只管「在场时看到的是哪一层」。
 */
export type ExposeView =
  | { mode: 'overview' }
  /**
   * drill 的目标是**组**,不是项目 —— 协作组和独立组都没有 projectId,
   * 以前两者都用 null 表示,于是「进协作组」和「进独立组」落到同一个视图里。
   * 换成 groupId 之后每个组各进各的,面包屑也能直接用组名。
   */
  | { mode: 'list'; groupId: string }
  | { mode: 'quicklook'; sessionId: string }

export interface ExposeState {
  view: ExposeView
  /** 总览里键盘焦点所在的卡;null = 还没落焦 */
  focusId: string | null
  /** 焦点环是否点亮:只有键盘导航(方向键 / Quick Look 换卡)才点亮;打开总览只设锚点、不亮环 */
  focusVisible: boolean
  /**
   * 卡网格「一行几张」。**产地是 CSS 的计算值**,不是这里算出来的:
   * 网格用 `repeat(auto-fill, …)` 按容器宽度自适应(浮窗 / 架子的宽度连续可变),
   * 渲染层读回那个数报进来(Overview 的 useGridColumns)。↑↓ 走一整行要用它,
   * 所以它必须跟着屏幕走 —— 写死成 3 就会出现「窄到一列还跳三张」。
   * 不持久化:它是当下这块面有多宽的事实,下次开可能完全不同。
   */
  columns: number
  /**
   * 折叠的组 id。唯一被持久化的字段。
   *
   * D1 起**没有「默认折叠」这回事**:旧 mock 的 `ProjectMock.active` 在
   * `SessionMeta` 上没有产地,按「最近更新」现造一个活跃度就是造概念。
   * 于是所有组一律展开起步,折叠永远是一次用户动作(并被记住)。
   */
  collapsedGroups: string[]
  /** 搜索条内容;非空时总览的分组区换成搜索结果视图 */
  query: string
  /** 「当前会话」= TopBar 显示的那个。空串 = 还没有(数据未到 / 一条都没有)。 */
  currentSessionId: string
}

export type FocusDir = 'up' | 'down' | 'left' | 'right'

/*
 * ── F 批:`SearchHit` 退役 ────────────────────────────────────────────────
 * 曾经搜索是**另一种呈现**(三层缩进的命中列表),于是它需要一个自己的形状。
 * 现在搜索只是**喂给分组纯函数的一个过滤参数** —— 屏幕上仍是「项目头 + 卡网格」,
 * 只是不命中的卡与变空的组不在了(expose/transitions.ts 的 filterGroups)。
 * 一个过滤器不需要自己的结果类型:结果就是 `SessionGroup[]`,和不搜时同一种东西。
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
