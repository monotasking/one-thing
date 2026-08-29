import type { MessageKey } from '../i18n'

/**
 * 会话总览(Exposé)的形状。和 stage/ 一样:这里只有数据,没有 React、没有 DOM。
 *
 * 总览也是「状态机 + 投影」:ExposeView 是唯一的形态事实,
 * 分组 / 焦点序列 / 搜索命中全部由它 + 静态数据派生,组件不许自己拼条件。
 */
export type SessionKind = 'chat' | 'room' | 'dm'

/** 徽标是「内容的状态」,挂在会话上而不是形态上 —— 同 StageBadge 的判例。 */
export interface SessionBadges {
  diff?: number
  testOk?: boolean
}

/** 一段:总览卡只显示最新一段的 detail(= summary),Quick Look / 搜索才看全部。 */
export interface SessionSegment {
  title: string
  detail: string
}

export interface SessionMock {
  id: string
  title: string
  kind: SessionKind
  projectId: string | null
  /** 最新段 detail,卡面两行截断 */
  summary: string
  segments: SessionSegment[]
  userTurns: string[]
  time: string
  badges?: SessionBadges
  unread?: number
  /** room/dm 头像字 */
  members?: string[]
  /** room 实况行 */
  live?: string
}

export interface ProjectMock {
  id: string
  name: string
  path: string
  active: boolean
}

/**
 * 组是「总览的一行分区」,不是一张新表:项目组的 id 就是 projectId,
 * 协作 / 独立组的 projectId 是 null(它们的会话本来就不属于任何项目)。
 */
export interface GroupMock {
  id: string
  /**
   * 组名 / 副名有两种来源,恰有其一:
   * - 项目组:name / path 是**数据**(项目名与磁盘路径),换语言不该变;
   * - 合成组(协作 / 独立会话):nameKey / pathKey 是**界面文案**,换语言要变。
   * 所以这里不是「可选字段」而是「两条来源」,消费方一律 key 优先。
   */
  name?: string
  nameKey?: MessageKey
  path?: string
  pathKey?: MessageKey
  projectId: string | null
  sessions: SessionMock[]
  defaultCollapsed: boolean
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
  /** 折叠的组 id。唯一被持久化的字段。 */
  collapsedGroups: string[]
  /** 搜索条内容;非空时总览的分组区换成搜索结果视图 */
  query: string
  /** 「当前会话」= TopBar 显示的那个。Enter 进入就是改这一个字段。 */
  currentSessionId: string
}

export type FocusDir = 'up' | 'down' | 'left' | 'right'

/** 搜索命中:三层缩进各对应这里的一层,视图不再自己过滤。 */
export interface SearchHit {
  session: SessionMock
  segments: SessionSegment[]
  turns: { text: string; index: number }[]
}

/** 高亮切片:hit=true 的段落由视图包 <mark>。 */
export interface HighlightPart {
  text: string
  hit: boolean
}
