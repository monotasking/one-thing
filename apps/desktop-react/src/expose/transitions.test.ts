import { describe, it, expect } from 'vitest'
import {
  CARD_COLS,
  backToOverview,
  closeQuickLook,
  enterList,
  enterSession,
  escape,
  initialExposeState,
  isCollapsed,
  moveFocus,
  open,
  openQuickLook,
  quickLookNext,
  quickLookPrev,
  relativeTime,
  searchSessions,
  setQuery,
  splitHighlight,
  timeBucket,
  toggleGroupCollapsed,
  visibleCardIds,
} from './transitions'
import { findGroup, findSession, sessionsOfGroup } from './projection'
import {
  CHAPTERS,
  GROUPS,
  NOW,
  SESSIONS,
} from '../data/__fixtures__/sessions'
import type { ExposeState } from './types'

/** 当前会话在这些用例里就是列表里的第一条 —— 开场焦点该落在它身上。 */
const CURRENT = SESSIONS[0].id

const base: ExposeState = { ...initialExposeState, currentSessionId: CURRENT }
const overview = open(base, GROUPS)
const seq = visibleCardIds(base, GROUPS)

describe('open(开场归位)', () => {
  it('开场落在 overview,焦点落在当前会话', () => {
    expect(overview.view).toEqual({ mode: 'overview' })
    expect(overview.focusId).toBe(CURRENT)
  })

  it('当前会话被折叠藏起来时,焦点退到序列首', () => {
    const hidden: ExposeState = { ...base, collapsedGroups: [GROUPS[0].id] }
    const next = open(hidden, GROUPS)
    expect(next.focusId).toBe(visibleCardIds(hidden, GROUPS)[0])
    expect(next.focusId).not.toBe(CURRENT)
  })

  it('一条会话都没有时焦点是 null,而不是指向空气', () => {
    expect(open(base, []).focusId).toBeNull()
  })

  it('开场是**无条件**归位:停在 quicklook、带着搜索词,再开一次都回到总览', () => {
    const deep = setQuery(openQuickLook(overview, 'os-expose'), 'provider')
    const reopened = open(deep, GROUPS)
    expect(reopened.view).toEqual({ mode: 'overview' })
    expect(reopened.query).toBe('')
  })

  it('三层视图就是全部:没有第四层「关着」—— 面在不在场由 Placement 说了算', () => {
    const modes = [overview, enterList(overview, GROUPS[0].id), openQuickLook(overview, 'os-expose')]
    expect(modes.map((st) => st.view.mode)).toEqual(['overview', 'list', 'quicklook'])
    // 状态机自己关不掉自己:总览上的 Esc 是恒等变换,那一下留给宿主。
    expect(escape(overview)).toBe(overview)
  })

  it('是纯函数:不改原对象', () => {
    const before = JSON.parse(JSON.stringify(base))
    open(base, GROUPS)
    moveFocus(overview, 'right', GROUPS)
    expect(JSON.parse(JSON.stringify(base))).toEqual(before)
  })
})

describe('Esc 逐层', () => {
  it('quicklook → overview;到了总览这一层就退不动了(让位给宿主关面板)', () => {
    const ql = openQuickLook(overview, 'os-expose')
    const back = escape(ql)
    expect(back.view).toEqual({ mode: 'overview' })
    expect(escape(back)).toBe(back)
  })

  it('quicklook 退回总览时焦点留在刚看的那张卡上', () => {
    const ql = openQuickLook(overview, 'lo-notes')
    expect(escape(ql).focusId).toBe('lo-notes')
  })

  it('list 也退回 overview,而不是直接关', () => {
    const list = enterList(overview, 'collab')
    expect(escape(list).view).toEqual({ mode: 'overview' })
  })

  it('初始态(总览)上 Esc 是恒等变换', () => {
    expect(escape(base)).toBe(base)
  })

  it('closeQuickLook 只对 quicklook 生效', () => {
    expect(closeQuickLook(overview)).toBe(overview)
    expect(closeQuickLook(openQuickLook(overview, 'os-compact')).view).toEqual({ mode: 'overview' })
  })
})

describe('list 进出(drill 的目标是组,不是项目)', () => {
  it('enterList 记住目标组,backToOverview 回去', () => {
    const list = enterList(overview, GROUPS[0].id)
    expect(list.view).toEqual({ mode: 'list', groupId: GROUPS[0].id })
    expect(backToOverview(list).view).toEqual({ mode: 'overview' })
  })

  /*
   * 协作组和独立组都没有 projectId,旧口径下两者都是 null → 点哪个都进同一个列表。
   * 现在各进各的。
   */
  it('协作组与独立组各进各的,不再挤在同一个 null 里', () => {
    expect(enterList(overview, 'collab').view).toEqual({ mode: 'list', groupId: 'collab' })
    expect(enterList(overview, 'loose').view).toEqual({ mode: 'list', groupId: 'loose' })
    expect(sessionsOfGroup(GROUPS, 'collab').map((s) => s.id)).toEqual(['rm-release', 'dm-ying'])
    expect(sessionsOfGroup(GROUPS, 'loose').map((s) => s.id)).toEqual(['lo-notes'])
  })

  it('sessionsOfGroup 取的就是组自己带的那份,未知组回空表', () => {
    expect(sessionsOfGroup(GROUPS, GROUPS[0].id).map((s) => s.id)).toEqual(
      findGroup(GROUPS, GROUPS[0].id)?.sessions.map((s) => s.id),
    )
    expect(sessionsOfGroup(GROUPS, 'nope')).toEqual([])
  })

  it('已经在 overview 时 backToOverview 是恒等变换', () => {
    expect(backToOverview(overview)).toBe(overview)
  })
})

describe('moveFocus', () => {
  it('→ 走一格,← 走回来', () => {
    const right = moveFocus(overview, 'right', GROUPS)
    expect(right.focusId).toBe(seq[1])
    expect(moveFocus(right, 'left', GROUPS).focusId).toBe(seq[0])
  })

  it('↓ 走一整行(CARD_COLS 步)', () => {
    expect(moveFocus(overview, 'down', GROUPS).focusId).toBe(seq[CARD_COLS])
  })

  it('序列是展开组拼接的:方向键能从第一个项目组一路走到协作组', () => {
    let st = overview
    for (let i = 0; i < 6; i += 1) st = moveFocus(st, 'right', GROUPS)
    expect(st.focusId).toBe('rm-release')
  })

  it('到头就停,不回绕(环已亮时撞边是恒等变换)', () => {
    // 第一下撞边会点亮 focusVisible,所以恒等性在环亮之后测。
    const lit = moveFocus(overview, 'left', GROUPS)
    expect(lit.focusId).toBe(overview.focusId)
    expect(moveFocus(lit, 'left', GROUPS)).toBe(lit)
    expect(moveFocus(lit, 'up', GROUPS)).toBe(lit)
    let st = overview
    for (let i = 0; i < 20; i += 1) st = moveFocus(st, 'right', GROUPS)
    expect(st.focusId).toBe(seq[seq.length - 1])
  })

  it('还没落焦时任何方向键都先把焦点放到序列首', () => {
    const nofocus: ExposeState = { ...overview, focusId: null }
    expect(moveFocus(nofocus, 'up', GROUPS).focusId).toBe(seq[0])
  })

  it('一条卡都没有时是恒等变换(空态里按方向键什么都不该发生)', () => {
    expect(moveFocus(overview, 'right', [])).toBe(overview)
  })
})

describe('quickLookPrev / Next', () => {
  it('← → 在 quicklook 内换会话,面板不关', () => {
    const ql = openQuickLook(overview, seq[1])
    const next = quickLookNext(ql, GROUPS)
    expect(next.view).toEqual({ mode: 'quicklook', sessionId: seq[2] })
    expect(quickLookPrev(next, GROUPS).view).toEqual({ mode: 'quicklook', sessionId: seq[1] })
  })

  it('换会话时焦点跟着走', () => {
    const ql = quickLookNext(openQuickLook(overview, seq[0]), GROUPS)
    expect(ql.focusId).toBe(seq[1])
  })

  it('到头就停', () => {
    const first = openQuickLook(overview, seq[0])
    expect(quickLookPrev(first, GROUPS)).toBe(first)
    const last = openQuickLook(overview, seq[seq.length - 1])
    expect(quickLookNext(last, GROUPS)).toBe(last)
  })

  it('不在 quicklook 里时是恒等变换', () => {
    expect(quickLookNext(overview, GROUPS)).toBe(overview)
  })
})

describe('toggleGroupCollapsed', () => {
  it('起步一个组都不折叠 —— 「默认折叠」在真事实里没有产地', () => {
    expect(initialExposeState.collapsedGroups).toEqual([])
    for (const group of GROUPS) expect(isCollapsed(base, group.id)).toBe(false)
  })

  it('折叠一个组,它的卡离开序列;再切回来又进序列', () => {
    const collapsed = toggleGroupCollapsed(base, 'collab', GROUPS)
    expect(visibleCardIds(collapsed, GROUPS)).not.toContain('rm-release')
    const reopened = toggleGroupCollapsed(collapsed, 'collab', GROUPS)
    expect(visibleCardIds(reopened, GROUPS)).toContain('rm-release')
  })

  it('折叠掉焦点所在的组时,焦点退到新序列首', () => {
    const next = toggleGroupCollapsed(overview, GROUPS[0].id, GROUPS)
    expect(visibleCardIds(next, GROUPS)).not.toContain(CURRENT)
    expect(next.focusId).toBe(visibleCardIds(next, GROUPS)[0])
  })

  it('折叠别的组不动焦点', () => {
    expect(toggleGroupCollapsed(overview, 'loose', GROUPS).focusId).toBe(CURRENT)
  })
})

describe('搜索', () => {
  it('标题命中', () => {
    expect(searchSessions('Exposé', SESSIONS).map((h) => h.session.id)).toEqual(['os-expose'])
  })

  it('预览(第一条用户消息)也算命中,归到会话行上', () => {
    const hits = searchSessions('端口', SESSIONS)
    expect(hits.map((h) => h.session.id)).toEqual(['tr-flask'])
  })

  it('章节只在**已经拉到手**的那份缓存里找 —— 没拉过的会话不会凭空命中', () => {
    expect(searchSessions('读取点', SESSIONS)).toEqual([])
    const hits = searchSessions('读取点', SESSIONS, CHAPTERS)
    expect(hits.map((h) => h.session.id)).toEqual(['os-provider'])
    expect(hits[0].chapters.map((c) => c.id)).toEqual(['seg-1'])
  })

  it('空词返回空,不返回全量', () => {
    expect(searchSessions('   ', SESSIONS)).toEqual([])
  })

  it('大小写不敏感', () => {
    expect(searchSessions('PROVIDER', SESSIONS).length).toBe(
      searchSessions('provider', SESSIONS).length,
    )
  })

  it('splitHighlight 把命中段切出来', () => {
    const parts = splitHighlight('重构 provider 抽象', 'provider')
    expect(parts.map((p) => p.text).join('')).toBe('重构 provider 抽象')
    expect(parts.filter((p) => p.hit).map((p) => p.text)).toEqual(['provider'])
  })

  it('splitHighlight 空词时原样返回一片', () => {
    expect(splitHighlight('abc', '')).toEqual([{ text: 'abc', hit: false }])
  })
})

describe('enterSession / 时间', () => {
  it('进入 = 换当前会话 + 内容回到起点(收回 Dock 是 store 壳的事,不在纯函数里)', () => {
    const next = enterSession(setQuery(overview, 'x'), 'tr-menubar')
    expect(next.currentSessionId).toBe('tr-menubar')
    expect(next.view).toEqual({ mode: 'overview' })
    expect(next.query).toBe('')
  })

  it('再开场不动折叠状态与当前会话', () => {
    const st = enterSession(overview, 'lo-notes')
    expect(open(st, GROUPS).currentSessionId).toBe('lo-notes')
    expect(open(st, GROUPS).collapsedGroups).toEqual(base.collapsedGroups)
  })

  it('timeBucket 认的是真时间戳:一周之内本周,再早更早', () => {
    expect(timeBucket(NOW, NOW)).toBe('thisWeek')
    expect(timeBucket(NOW - 6 * 24 * 3600_000, NOW)).toBe('thisWeek')
    expect(timeBucket(NOW - 8 * 24 * 3600_000, NOW)).toBe('earlier')
  })

  it('relativeTime 回的是标识不是文案(换语言不该改状态机)', () => {
    expect(relativeTime(NOW - 60_000, NOW)).toEqual({ kind: 'clock', hh: '14', mm: '29' })
    expect(relativeTime(NOW - 24 * 3600_000, NOW)).toEqual({ kind: 'yesterday' })
    // 三天前 = 8月26日,周三
    expect(relativeTime(NOW - 3 * 24 * 3600_000, NOW)).toEqual({ kind: 'weekday', weekday: 3 })
    expect(relativeTime(NOW - 20 * 24 * 3600_000, NOW)).toEqual({ kind: 'date', month: 8, day: 9 })
  })

  it('findSession 认得空 id(还没有当前会话时不许炸)', () => {
    expect(findSession(SESSIONS, '')).toBeUndefined()
    expect(findSession(SESSIONS, 'os-compact')?.title).toBe('上下文压缩早触发排查')
  })
})

describe('焦点环点亮时机(focusVisible)', () => {
  it('打开总览只设锚点不亮环:focusId 有值、focusVisible 为 false', () => {
    const st = open(base, GROUPS)
    expect(st.focusId).not.toBeNull()
    expect(st.focusVisible).toBe(false)
  })

  it('按方向键才点亮;撞边不动位置也点亮', () => {
    expect(moveFocus(open(base, GROUPS), 'right', GROUPS).focusVisible).toBe(true)
    const edge = moveFocus({ ...open(base, GROUPS), focusId: null }, 'left', GROUPS)
    expect(edge.focusVisible).toBe(true)
  })

  it('再开一次环回到熄灭(残留环就是 08-28 用户看见的"莫名阴影")', () => {
    const lit = moveFocus(open(base, GROUPS), 'right', GROUPS)
    expect(open(lit, GROUPS).focusVisible).toBe(false)
  })
})
