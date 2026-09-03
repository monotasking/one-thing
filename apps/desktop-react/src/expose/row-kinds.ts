import type { MessageKey } from '../i18n'
import type { SessionKind } from './types'

/**
 * **行形态自述表**(方向 A §1.1 的 `ROW_KIND_SPECS`)。
 *
 * 一行 = 一种形态**自己说**它在列表上长什么样、在层级里站哪一层。
 * 渲染层、模型层、键盘层都只**读表**,不许出现 `kind === 'room'` 这种分支
 * —— 「加一种行形态 = 加一行 + `SessionKind` 加一格 + `kindOf` 一句」
 * (设计 §6 陌生能力演练的第二条)。
 *
 * ── 为什么 glyph 是一个「档」而不是一个图标组件 ────────────────────────────
 * 这一层是**纯数据**(不认识 React、不 import lucide),而且行首那一列画的东西
 * 本来就不都是图标:私聊画的是**名字首字**(一枚合成头像),普通聊天画的是
 * **空**(列宽照旧预留,标题永远从同一条竖线起笔,§1.1 裁决 6)。
 * 所以这里给的是「画哪一档」,`SessionRow` 那一头拿它查一张 档→元素 的表。
 */
export type RowGlyph = 'none' | 'initial' | 'room' | 'swap' | 'work' | 'agent'

export interface RowKindSpec {
  kind: SessionKind
  /** 行首那一列画什么档;`'none'` = 留空(列宽照旧占着)。 */
  glyph: RowGlyph
  /** 悬停 / 读屏用的全称(kind.chat / kind.room / …)。 */
  labelKey: MessageKey
  /** 一个字的形态徽(Quick Look 与旧卡在用;行上不画徽,§1.1)。 */
  badgeKey: MessageKey
  /**
   * 这一档是**房间**吗 —— 它能带子行、能展开、`aria-expanded` 画在它身上。
   * 三档:群房 / 人机私聊 / agent 私聊。
   */
  container: boolean
  /**
   * 这一档是**房间的子行**吗 —— 它不占顶层,靠 `roomId` 挂到父房间下
   * (父不在集合里时回顶层,见 list-model.attachChildren)。
   */
  child: boolean
}

/**
 * 六档,一格不多一格不少(`Record` 让漏一档在 tsc 就红)。
 *
 * `swap`(agent ⇄ agent 私聊)与 `dm` 分开成两行而不是「dm + 成员数」:
 * 成员数是**投影**该判的事(`projection.sessionKindOf`),表这一层只认形态名
 * —— 判据留在两处的话,屏幕上的图标与键盘上的层级迟早各说各的。
 */
export const ROW_KIND_SPECS: Readonly<Record<SessionKind, RowKindSpec>> = {
  chat: {
    kind: 'chat',
    glyph: 'none',
    labelKey: 'kind.chat',
    badgeKey: 'kind.chatBadge',
    container: false,
    child: false,
  },
  room: {
    kind: 'room',
    glyph: 'room',
    labelKey: 'kind.room',
    badgeKey: 'kind.roomBadge',
    container: true,
    child: false,
  },
  dm: {
    kind: 'dm',
    glyph: 'initial',
    labelKey: 'kind.dm',
    badgeKey: 'kind.dmBadge',
    container: true,
    child: false,
  },
  swap: {
    kind: 'swap',
    glyph: 'swap',
    labelKey: 'kind.swap',
    badgeKey: 'kind.swapBadge',
    container: true,
    child: false,
  },
  work: {
    kind: 'work',
    glyph: 'work',
    labelKey: 'kind.work',
    badgeKey: 'kind.workBadge',
    container: false,
    child: true,
  },
  agent: {
    kind: 'agent',
    glyph: 'agent',
    labelKey: 'kind.agent',
    badgeKey: 'kind.agentBadge',
    container: false,
    child: true,
  },
}

/** 全表,按声明序 —— 要遍历形态的地方(测试、将来的图例)读它。 */
export const ROW_KIND_LIST: readonly RowKindSpec[] = Object.values(ROW_KIND_SPECS)

export function rowKindOf(kind: SessionKind): RowKindSpec {
  return ROW_KIND_SPECS[kind]
}

/** 这一档是房间(能带子行、能展开)。判据只此一处。 */
export function isRoomKind(kind: SessionKind): boolean {
  return ROW_KIND_SPECS[kind].container
}

/** 这一档是房间的子行(work / agent)。判据只此一处。 */
export function isRoomChildKind(kind: SessionKind): boolean {
  return ROW_KIND_SPECS[kind].child
}
