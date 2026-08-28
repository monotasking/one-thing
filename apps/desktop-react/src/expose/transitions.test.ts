import { describe, it, expect } from 'vitest'
import {
  CARD_COLS,
  backToOverview,
  close,
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
  searchSessions,
  setQuery,
  splitHighlight,
  timeBucket,
  toggle,
  toggleGroupCollapsed,
  visibleCardIds,
} from './transitions'
import {
  CURRENT_SESSION_ID,
  DEFAULT_COLLAPSED_GROUP_IDS,
  GROUPS,
  SESSIONS,
  sessionsOfGroup,
} from './data'
import type { ExposeState } from './types'

const base: ExposeState = initialExposeState
const overview = open(base)

describe('open / close / toggle', () => {
  it('从关着的态打开 → overview,焦点落在当前会话', () => {
    expect(overview.view).toEqual({ mode: 'overview' })
    expect(overview.focusId).toBe(CURRENT_SESSION_ID)
  })

  it('当前会话被折叠藏起来时,焦点退到序列首', () => {
    const hidden: ExposeState = { ...base, collapsedGroups: [...base.collapsedGroups, 'onething'] }
    const next = open(hidden)
    expect(next.focusId).toBe(visibleCardIds(hidden)[0])
    expect(next.focusId).not.toBe(CURRENT_SESSION_ID)
  })

  it('已经开着时 open 是恒等变换', () => {
    expect(open(overview)).toBe(overview)
  })

  it('toggle 开→关、关→开;关闭时清掉搜索词', () => {
    const searching = setQuery(overview, 'provider')
    const closed = toggle(searching)
    expect(closed.view).toEqual({ mode: 'closed' })
    expect(closed.query).toBe('')
    expect(toggle(closed).view).toEqual({ mode: 'overview' })
  })

  it('是纯函数:不改原对象', () => {
    const before = JSON.parse(JSON.stringify(base))
    open(base)
    moveFocus(overview, 'right')
    expect(JSON.parse(JSON.stringify(base))).toEqual(before)
  })
})

describe('Esc 逐层', () => {
  it('quicklook → overview → closed', () => {
    const ql = openQuickLook(overview, 'os-expose')
    const back = escape(ql)
    expect(back.view).toEqual({ mode: 'overview' })
    expect(escape(back).view).toEqual({ mode: 'closed' })
  })

  it('quicklook 退回总览时焦点留在刚看的那张卡上', () => {
    const ql = openQuickLook(overview, 'lo-notes')
    expect(escape(ql).focusId).toBe('lo-notes')
  })

  it('list 也退回 overview,而不是直接关', () => {
    const list = enterList(overview, 'transreader')
    expect(escape(list).view).toEqual({ mode: 'overview' })
  })

  it('closed 上再 Esc 是恒等变换', () => {
    expect(escape(base)).toBe(base)
  })

  it('closeQuickLook 只对 quicklook 生效', () => {
    expect(closeQuickLook(overview)).toBe(overview)
    expect(closeQuickLook(openQuickLook(overview, 'os-compact')).view).toEqual({ mode: 'overview' })
  })
})

describe('list 进出(drill 的目标是组,不是项目)', () => {
  it('enterList 记住目标组,backToOverview 回去', () => {
    const list = enterList(overview, 'onething')
    expect(list.view).toEqual({ mode: 'list', groupId: 'onething' })
    expect(backToOverview(list).view).toEqual({ mode: 'overview' })
  })

  /*
   * 这一条就是这次改造的理由:协作组和独立组都没有 projectId,
   * 旧口径下两者都是 null → 点哪个都进同一个列表。现在各进各的。
   */
  it('协作组与独立组各进各的,不再挤在同一个 null 里', () => {
    expect(enterList(overview, 'collab').view).toEqual({ mode: 'list', groupId: 'collab' })
    expect(enterList(overview, 'loose').view).toEqual({ mode: 'list', groupId: 'loose' })
    expect(sessionsOfGroup('collab').map((s) => s.id)).toEqual(['rm-release', 'dm-ying'])
    expect(sessionsOfGroup('loose').map((s) => s.id)).toEqual(['lo-notes'])
    const collab = new Set(sessionsOfGroup('collab').map((s) => s.id))
    expect(sessionsOfGroup('loose').some((s) => collab.has(s.id))).toBe(false)
  })

  it('sessionsOfGroup 取的就是组自己带的那份,未知组回空表', () => {
    expect(sessionsOfGroup('onething').map((s) => s.id)).toEqual(
      GROUPS.find((g) => g.id === 'onething')?.sessions.map((s) => s.id),
    )
    expect(sessionsOfGroup('nope')).toEqual([])
  })

  it('已经在 overview 时 backToOverview 是恒等变换', () => {
    expect(backToOverview(overview)).toBe(overview)
  })
})

describe('moveFocus', () => {
  const seq = visibleCardIds(base)

  it('→ 走一格,← 走回来', () => {
    const right = moveFocus(overview, 'right')
    expect(right.focusId).toBe(seq[1])
    expect(moveFocus(right, 'left').focusId).toBe(seq[0])
  })

  it('↓ 走一整行(CARD_COLS 步),会跨组', () => {
    const down = moveFocus(overview, 'down')
    expect(down.focusId).toBe(seq[CARD_COLS])
    // 序列首在 onething 组,走一行之后已经落到别的组里了
    expect(SESSIONS.find((s) => s.id === down.focusId)?.projectId).not.toBe('onething')
  })

  it('序列是展开组拼接的:方向键能从 onething 一路走到协作组', () => {
    let st = overview
    for (let i = 0; i < 4; i += 1) st = moveFocus(st, 'right')
    expect(st.focusId).toBe('rm-release')
  })

  it('到头就停,不回绕(环已亮时撞边是恒等变换)', () => {
    // 第一下撞边会点亮 focusVisible(见「焦点环点亮时机」),所以恒等性在环亮之后测。
    const lit = moveFocus(overview, 'left')
    expect(lit.focusId).toBe(overview.focusId)
    expect(moveFocus(lit, 'left')).toBe(lit)
    expect(moveFocus(lit, 'up')).toBe(lit)
    let st = overview
    for (let i = 0; i < 20; i += 1) st = moveFocus(st, 'right')
    expect(st.focusId).toBe(seq[seq.length - 1])
  })

  it('还没落焦时任何方向键都先把焦点放到序列首', () => {
    const nofocus: ExposeState = { ...overview, focusId: null }
    expect(moveFocus(nofocus, 'up').focusId).toBe(seq[0])
  })
})

describe('quickLookPrev / Next', () => {
  const seq = visibleCardIds(base)

  it('← → 在 quicklook 内换会话,面板不关', () => {
    const ql = openQuickLook(overview, seq[1])
    const next = quickLookNext(ql)
    expect(next.view).toEqual({ mode: 'quicklook', sessionId: seq[2] })
    expect(quickLookPrev(next).view).toEqual({ mode: 'quicklook', sessionId: seq[1] })
  })

  it('换会话时焦点跟着走,收回面板后落在最后看的那张', () => {
    const ql = quickLookNext(openQuickLook(overview, seq[0]))
    expect(ql.focusId).toBe(seq[1])
  })

  it('到头就停', () => {
    const first = openQuickLook(overview, seq[0])
    expect(quickLookPrev(first)).toBe(first)
    const last = openQuickLook(overview, seq[seq.length - 1])
    expect(quickLookNext(last)).toBe(last)
  })

  it('不在 quicklook 里时是恒等变换', () => {
    expect(quickLookNext(overview)).toBe(overview)
  })
})

describe('toggleGroupCollapsed', () => {
  it('不活跃项目默认折叠,活跃的默认展开', () => {
    expect(DEFAULT_COLLAPSED_GROUP_IDS.length).toBe(4)
    expect(isCollapsed(base, 'personal-site')).toBe(true)
    expect(isCollapsed(base, 'onething')).toBe(false)
  })

  it('切开一个折叠组,它的卡进入序列', () => {
    const opened = toggleGroupCollapsed(base, 'personal-site')
    expect(isCollapsed(opened, 'personal-site')).toBe(false)
    expect(visibleCardIds(opened)).toContain('ps-deploy')
  })

  it('折叠掉焦点所在的组时,焦点退到新序列首', () => {
    const next = toggleGroupCollapsed(overview, 'onething')
    expect(visibleCardIds(next)).not.toContain(CURRENT_SESSION_ID)
    expect(next.focusId).toBe(visibleCardIds(next)[0])
  })

  it('折叠别的组不动焦点', () => {
    expect(toggleGroupCollapsed(overview, 'loose').focusId).toBe(CURRENT_SESSION_ID)
  })

  it('折叠状态是唯一跨会话记住的东西,和 view 无关', () => {
    const next = toggleGroupCollapsed(base, 'memory-wiki')
    expect(next.view).toEqual({ mode: 'closed' })
    expect(next.collapsedGroups).not.toContain('memory-wiki')
  })
})

describe('搜索', () => {
  it('三层都能命中:标题 / 章节 / 消息', () => {
    const hits = searchSessions('估算器')
    expect(hits.length).toBeGreaterThan(0)
    const compact = hits.find((h) => h.session.id === 'os-compact')
    expect(compact?.segments.length).toBeGreaterThan(0)
    expect(compact?.turns.length).toBeGreaterThan(0)
  })

  it('只命中标题时也算一条命中(章节 / 消息可以为空)', () => {
    const hits = searchSessions('Exposé')
    expect(hits.map((h) => h.session.id)).toContain('os-expose')
  })

  it('空词返回空,不返回全量', () => {
    expect(searchSessions('   ')).toEqual([])
  })

  it('大小写不敏感', () => {
    expect(searchSessions('PROVIDER').length).toBe(searchSessions('provider').length)
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

describe('enterSession / timeBucket / 数据自洽', () => {
  it('进入 = 换当前会话 + 关总览', () => {
    const next = enterSession(setQuery(overview, 'x'), 'tr-menubar')
    expect(next.currentSessionId).toBe('tr-menubar')
    expect(next.view).toEqual({ mode: 'closed' })
    expect(next.query).toBe('')
  })

  it('close 不动折叠状态与当前会话', () => {
    const st = enterSession(overview, 'lo-notes')
    expect(close(st).currentSessionId).toBe('lo-notes')
    expect(close(st).collapsedGroups).toEqual(base.collapsedGroups)
  })

  it('timeBucket 认得钟点 / 昨天 / 周几 = 本周,其余更早(回的是标识,不是文案)', () => {
    expect(timeBucket('14:22')).toBe('thisWeek')
    expect(timeBucket('刚刚')).toBe('thisWeek')
    expect(timeBucket('周一')).toBe('thisWeek')
    expect(timeBucket('上周')).toBe('earlier')
    expect(timeBucket('8月12日')).toBe('earlier')
  })

  it('每个会话都有 summary / 3 段 / 至少 6 条 userTurns', () => {
    for (const s of SESSIONS) {
      expect(s.summary.length).toBeGreaterThan(0)
      expect(s.segments.length).toBe(3)
      expect(s.userTurns.length).toBeGreaterThanOrEqual(6)
      expect(s.userTurns.length).toBeLessThanOrEqual(10)
    }
  })

  it('组覆盖了全部会话,一条不漏也不重', () => {
    const ids = GROUPS.flatMap((g) => g.sessions.map((s) => s.id))
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.sort()).toEqual(SESSIONS.map((s) => s.id).sort())
  })
})

describe('焦点环点亮时机(focusVisible)', () => {
  it('打开总览只设锚点不亮环:focusId 有值、focusVisible 为 false', () => {
    const st = open(base)
    expect(st.focusId).not.toBeNull()
    expect(st.focusVisible).toBe(false)
  })

  it('按方向键才点亮;撞边不动位置也点亮', () => {
    const st = moveFocus(open(base), 'right')
    expect(st.focusVisible).toBe(true)
    // 锚点在序列首时按 ← 撞边:位置不动,环也要亮
    const edge = moveFocus({ ...open(base), focusId: null }, 'left')
    expect(edge.focusVisible).toBe(true)
  })

  it('关掉再开,环回到熄灭(残留环就是 08-28 用户看见的"莫名阴影")', () => {
    const lit = moveFocus(open(base), 'right')
    const reopened = open(close(lit))
    expect(reopened.focusVisible).toBe(false)
  })
})
