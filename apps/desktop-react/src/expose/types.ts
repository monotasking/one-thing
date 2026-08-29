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
  /** SessionMeta.updatedAt(毫秒时间戳)。显示成什么样是渲染层的事。 */
  updatedAt: number
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

/**
 * 搜索命中:两层缩进各对应这里的一层。
 *
 * **第三层(消息正文)在 D1 不可得** —— 后端没有跨会话内容检索面
 * (`sessions.*` 二十六条里没有一条是「在所有会话里搜正文」),
 * 硬要做就得把每条会话的每一页消息都拉下来在前端扫,那不是缺口的补法。
 * 判据与缺口记在 expose/transitions.ts 的 searchSessions 上,留待后批。
 */
export interface SearchHit {
  session: SessionSummary
  chapters: SessionChapter[]
}

/** 高亮切片:hit=true 的段落由视图包 <mark>。 */
export interface HighlightPart {
  text: string
  hit: boolean
}
