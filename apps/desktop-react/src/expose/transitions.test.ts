import { describe, it, expect } from 'vitest'
import {
  CARD_COLS,
  backToOverview,
  columnsFromTemplate,
  closeQuickLook,
  enterList,
  enterSession,
  escape,
  focusGrid,
  initialExposeState,
  isCollapsed,
  moveFocus,
  open,
  openQuickLook,
  quickLookNext,
  quickLookPrev,
  filterGroups,
  groupMatchesQuery,
  quickLookNeighbors,
  relativeTime,
  sessionMatchesQuery,
  sessionsRemoved,
  setColumns,
  setQuery,
  splitHighlight,
  splitHighlightRanges,
  timeBucket,
  toggleGroupCollapsed,
  visibleCardIds,
} from './transitions'
import { findGroup, findSession, sessionsOfGroup } from './projection'
import {
  GROUPS,
  NOW,
  ONETHING_DIR,
  SESSIONS,
} from '../data/__fixtures__/sessions'
import { buildGroups, buildProjects } from './projection'
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
    const deep = setQuery(openQuickLook(overview, 'os-expose'), 'provider', GROUPS)
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

  /*
   * 08-30 用户报:窄成钉边架子时网格只剩一列,而 ↑↓ 仍固执地跳三张(旧代码里
   * 列数是常量 CARD_COLS)。列数改成状态里的一格之后,「走一整行」就等于
   * 「走 state.columns 张」—— 这三条把那个等式钉死,一列 / 两列 / 三列各一条。
   */
  it('↓ 走的是 state.columns 张 —— 一列时就走一张', () => {
    const oneCol: ExposeState = { ...overview, columns: 1 }
    expect(moveFocus(oneCol, 'down', GROUPS).focusId).toBe(seq[1])
    const twoCols: ExposeState = { ...overview, columns: 2 }
    expect(moveFocus(twoCols, 'down', GROUPS).focusId).toBe(seq[2])
  })

  it('↑ 同理,反向走 state.columns 张', () => {
    const twoCols: ExposeState = { ...overview, columns: 2, focusId: seq[4], focusVisible: true }
    expect(moveFocus(twoCols, 'up', GROUPS).focusId).toBe(seq[2])
  })

  it('列数是脏值时按一列算,不会因为一次量错就跳飞', () => {
    const broken: ExposeState = { ...overview, columns: 0 }
    expect(moveFocus(broken, 'down', GROUPS).focusId).toBe(seq[1])
  })
})

/**
 * 列数的产地是 CSS 的计算值 —— 这里只钉「怎么读那串字」与「读不出来怎么办」。
 * 读不出来一律 null = 不动状态:jsdom 与「还没解析的 repeat()」都走这条路,
 * 免得环境噪声把一个假列数写进状态机。
 */
describe('columnsFromTemplate / setColumns', () => {
  it('计算值是解析过的轨道表,数轨道就是数列', () => {
    expect(columnsFromTemplate('286.93px 286.93px 286.93px')).toBe(3)
    expect(columnsFromTemplate('  300px   300px  ')).toBe(2)
    expect(columnsFromTemplate('187px')).toBe(1)
  })

  it('读不出来一律 null:空串 / none / 还没解析的 repeat()', () => {
    expect(columnsFromTemplate('')).toBeNull()
    expect(columnsFromTemplate(null)).toBeNull()
    expect(columnsFromTemplate(undefined)).toBeNull()
    expect(columnsFromTemplate('none')).toBeNull()
    expect(columnsFromTemplate('repeat(auto-fill, minmax(260px, 1fr))')).toBeNull()
  })

  it('setColumns 钳到 ≥1,值没变时是恒等变换(不触发重渲染)', () => {
    expect(setColumns(overview, 2).columns).toBe(2)
    expect(setColumns(overview, 0).columns).toBe(1)
    expect(setColumns(overview, -3).columns).toBe(1)
    expect(setColumns(overview, Number.NaN).columns).toBe(CARD_COLS)
    expect(setColumns(overview, CARD_COLS)).toBe(overview)
  })
})

/**
 * 搜索框把键盘交给网格(08-30 键盘死区的修法):**只点亮,不移动**。
 * 开场归位已经把锚点放好了,交接那一下要让用户看见锚点在哪 ——
 * 顺手再走一步的话,他看见的是一个自己从没选过的位置。
 */
describe('focusGrid', () => {
  it('锚点还在序列里:只点亮环,焦点一格不动', () => {
    const dark: ExposeState = { ...overview, focusId: seq[2], focusVisible: false }
    const lit = focusGrid(dark, GROUPS)
    expect(lit.focusId).toBe(seq[2])
    expect(lit.focusVisible).toBe(true)
  })

  it('环已经亮着时是恒等变换', () => {
    const lit: ExposeState = { ...overview, focusId: seq[2], focusVisible: true }
    expect(focusGrid(lit, GROUPS)).toBe(lit)
  })

  it('锚点被过滤 / 折叠藏起来了就落到序列首', () => {
    const stale: ExposeState = { ...overview, focusId: 'not-on-screen', focusVisible: false }
    expect(focusGrid(stale, GROUPS).focusId).toBe(seq[0])
    const nofocus: ExposeState = { ...overview, focusId: null }
    expect(focusGrid(nofocus, GROUPS).focusId).toBe(seq[0])
  })

  it('一条卡都没有时是恒等变换', () => {
    expect(focusGrid(overview, [])).toBe(overview)
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

describe('搜索 = 过滤器,不是第四种形态', () => {
  /*
   * F 批的裁定:输入搜索词之后屏幕仍是「项目头 + 卡网格」。所以搜索的**全部**
   * 就是 filterGroups —— 一个分组事实 + 一个词 → 另一个分组事实。
   * 这一批用例钉的正是那几种命中组合(卡命中 / 项目命中 / 两者并集 / 都不中)。
   */
  const onething = GROUPS.find((g) => g.id === ONETHING_DIR)!
  const idsOf = (groups: typeof GROUPS) =>
    groups.map((g) => [g.id, g.sessions.map((s) => s.id)] as const)

  it('空词是恒等变换,而且原样返回同一个数组引用(不搜时零分配)', () => {
    expect(filterGroups(GROUPS, '')).toBe(GROUPS)
    expect(filterGroups(GROUPS, '   ')).toBe(GROUPS)
  })

  it('按标题命中:留下的只有那一张卡,它所在的组只剩它,别的组整个消失', () => {
    expect(idsOf(filterGroups(GROUPS, 'Exposé'))).toEqual([[ONETHING_DIR, ['os-expose']]])
  })

  it('预览(第一条用户消息)也算命中 —— 搜的格与卡上画的格是同一批', () => {
    expect(idsOf(filterGroups(GROUPS, '端口'))).toEqual([
      ['/Users/dev/code/transreader', ['tr-flask']],
    ])
  })

  it('命中项目名(路径末段)时该组**整组保留**:组里每一条都在,一条不少', () => {
    const kept = filterGroups(GROUPS, 'start-electron')
    expect(kept.map((g) => g.id)).toEqual([ONETHING_DIR])
    expect(kept[0].sessions.map((s) => s.id)).toEqual(onething.sessions.map((s) => s.id))
  })

  it('项目命中与卡命中取并集:整组的那一组 + 别的组里逐张命中的卡', () => {
    // 'e' 同时出现在 start-electron(项目名)与 transreader 的两条标题/预览里,
    // 所以并集 = onething 整组 + transreader 的命中卡。
    const kept = filterGroups(GROUPS, 'transreader')
    expect(kept.map((g) => g.id)).toEqual(['/Users/dev/code/transreader'])

    const both = filterGroups(GROUPS, 'flask')
    expect(idsOf(both)).toEqual([['/Users/dev/code/transreader', ['tr-flask']]])
  })

  it('组名命中不看**路径**:绝对路径里那截公共前缀会让过滤器等于没有', () => {
    expect(groupMatchesQuery(onething, 'start-electron')).toBe(true)
    expect(groupMatchesQuery(onething, '/Users/dev')).toBe(false)
    expect(filterGroups(GROUPS, 'Users')).toEqual([])
  })

  it('合成组(协作 / 独立)不按组名命中 —— 那名字是界面文案,会随语言变', () => {
    const collab = GROUPS.find((g) => g.id === 'collab')!
    expect(collab.name).toBeUndefined()
    expect(groupMatchesQuery(collab, '协作')).toBe(false)
    // 但它组里的卡照常按标题 / 预览命中。
    expect(idsOf(filterGroups(GROUPS, '发版房'))).toEqual([['collab', ['rm-release']]])
  })

  it('一条都不中时是空表(而不是全量)', () => {
    expect(filterGroups(GROUPS, '这个词哪儿都没有')).toEqual([])
  })

  it('大小写不敏感', () => {
    expect(sessionMatchesQuery(SESSIONS[0], 'PROVIDER')).toBe(
      sessionMatchesQuery(SESSIONS[0], 'provider'),
    )
    expect(idsOf(filterGroups(GROUPS, 'START-ELECTRON'))).toEqual(
      idsOf(filterGroups(GROUPS, 'start-electron')),
    )
  })

  it('空词时 sessionMatchesQuery 一律为真 —— 「没在搜」不等于「都不中」', () => {
    expect(SESSIONS.every((s) => sessionMatchesQuery(s, ''))).toBe(true)
  })

  it('焦点序列跟着过滤走:搜索之后方向键只在命中的卡之间移动', () => {
    const searched = setQuery(overview, 'Exposé', GROUPS)
    expect(visibleCardIds(searched, GROUPS)).toEqual(['os-expose'])
    // 焦点原本在 os-provider 上,被过滤掉了 → 退到新序列首。
    expect(searched.focusId).toBe('os-expose')
  })

  it('搜到一条都没有时焦点是 null,而不是指向一张不在屏幕上的卡', () => {
    const searched = setQuery(overview, '这个词哪儿都没有', GROUPS)
    expect(visibleCardIds(searched, GROUPS)).toEqual([])
    expect(searched.focusId).toBeNull()
  })

  it('焦点还在命中集里时不动它 —— 打字不该把光标从我正看的那张卡上弹开', () => {
    const searched = setQuery(overview, 'provider', GROUPS)
    expect(searched.focusId).toBe(CURRENT)
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

/**
 * 命中区间由**别人**判好递进来的那个入口(09-02 正文检索:后端给 `matchRanges`)。
 *
 * 入参当作不可信 —— 它跨了一个进程,而「今天只给一段、一定不越界」不是一条能
 * 依赖的性质。所以这一组里大半是边界:越界、乱序、重叠、空段。
 */
describe('splitHighlightRanges(区间由产地给定)', () => {
  const text = '重构 provider 抽象'
  /** 每一组都要成立的那条不变量:片段拼起来 === 原文,一个字符不多不少。 */
  const joined = (ranges: { start: number; end: number }[]) =>
    splitHighlightRanges(text, ranges).map((p) => p.text).join('')

  it('照区间切,命中段就是那一截', () => {
    const parts = splitHighlightRanges(text, [{ start: 3, end: 11 }])
    expect(parts.filter((p) => p.hit).map((p) => p.text)).toEqual(['provider'])
    expect(parts.map((p) => p.text).join('')).toBe(text)
  })

  it('多段:各切各的,次序按位置', () => {
    const parts = splitHighlightRanges('aXbXc', [
      { start: 1, end: 2 },
      { start: 3, end: 4 },
    ])
    expect(parts.filter((p) => p.hit).length).toBe(2)
    expect(parts.map((p) => p.text).join('')).toBe('aXbXc')
  })

  it('空表 = 不高亮,原样一片(不去拿词再算一遍)', () => {
    expect(splitHighlightRanges(text, [])).toEqual([{ text, hit: false }])
  })

  it('越界的区间被夹进文本 —— 不交出一串错位的片', () => {
    expect(joined([{ start: -5, end: 999 }])).toBe(text)
    expect(splitHighlightRanges(text, [{ start: -5, end: 999 }]).every((p) => p.hit)).toBe(true)
  })

  it('乱序进来照样按位置切', () => {
    const parts = splitHighlightRanges('aXbXc', [
      { start: 3, end: 4 },
      { start: 1, end: 2 },
    ])
    expect(parts.map((p) => p.text).join('')).toBe('aXbXc')
    expect(parts.filter((p) => p.hit).length).toBe(2)
  })

  it('重叠 / 被吞掉的区间不会把文本切重', () => {
    expect(joined([{ start: 0, end: 6 }, { start: 3, end: 11 }])).toBe(text)
    expect(joined([{ start: 0, end: 11 }, { start: 3, end: 6 }])).toBe(text)
  })

  it('空段(start === end,或反着来)直接丢掉', () => {
    expect(splitHighlightRanges(text, [{ start: 4, end: 4 }])).toEqual([{ text, hit: false }])
    expect(splitHighlightRanges(text, [{ start: 8, end: 3 }])).toEqual([{ text, hit: false }])
  })
})

describe('Quick Look 的换会话序列(‹ › 与 ← → 同一个判据)', () => {
  it('两头是 null,不回卷 —— 与 quickLookPrev / Next 的「到头就停」同一条口径', () => {
    const first = openQuickLook(overview, seq[0])
    expect(quickLookNeighbors(first, GROUPS).prev).toBeNull()
    expect(quickLookNeighbors(first, GROUPS).next).toBe(seq[1])

    const last = openQuickLook(overview, seq[seq.length - 1])
    expect(quickLookNeighbors(last, GROUPS).next).toBeNull()
    expect(quickLookNeighbors(last, GROUPS).prev).toBe(seq[seq.length - 2])

    // 禁用的那一侧,键盘按下去也确实原地不动。
    expect(quickLookPrev(first, GROUPS)).toBe(first)
    expect(quickLookNext(last, GROUPS)).toBe(last)
  })

  it('中间两边都有邻居', () => {
    const mid = openQuickLook(overview, seq[1])
    expect(quickLookNeighbors(mid, GROUPS)).toEqual({ prev: seq[0], next: seq[2] })
  })

  it('序列是**搜索过滤之后**的那一条,不是全量', () => {
    const searched = setQuery(overview, 'transreader', GROUPS)
    const visible = visibleCardIds(searched, GROUPS)
    expect(visible.length).toBeGreaterThan(1)
    // 这一条在全量序列里**不是头一个**(它前面还有 onething 那四条),
    // 所以「过滤没生效」的话 prev 会是那四条里的最后一条,而不是 null。
    expect(seq.indexOf(visible[0])).toBeGreaterThan(0)

    const st = openQuickLook(searched, visible[0])
    expect(quickLookNeighbors(st, GROUPS)).toEqual({ prev: null, next: visible[1] })
    // 同一条会话,不搜时的邻居是全量序列里的前一张。
    const unfiltered = openQuickLook(overview, visible[0])
    expect(quickLookNeighbors(unfiltered, GROUPS).prev).toBe(seq[seq.indexOf(visible[0]) - 1])
  })

  it('不在 quicklook 层时两边都是 null', () => {
    expect(quickLookNeighbors(overview, GROUPS)).toEqual({ prev: null, next: null })
  })
})

describe('enterSession / 时间', () => {
  it('进入 = 换当前会话 + 内容回到起点(收回 Dock 是 store 壳的事,不在纯函数里)', () => {
    const next = enterSession(setQuery(overview, 'x', GROUPS), 'tr-menubar')
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


/**
 * H 批:摘要(`digest`,产地 `SessionMeta.lastMessagePreview`)进搜索判据。
 * 理由是 F 批那条口径的直接推论 —— 搜的格与卡上画的格必须是同一批,
 * 否则会出现「卡上明明标着那个词却搜不出来」。
 */
describe('搜索判据含摘要行', () => {
  const provider = SESSIONS.find((s) => s.id === 'os-provider')!

  it('只出现在摘要里的词也算命中', () => {
    // '判定函数' 只在 lastMessagePreview 里,标题与 previewText 都没有它。
    expect(provider.title.includes('判定函数')).toBe(false)
    expect(provider.preview.includes('判定函数')).toBe(false)
    expect(sessionMatchesQuery(provider, '判定函数')).toBe(true)
    expect(filterGroups(GROUPS, '判定函数').flatMap((g) => g.sessions.map((s) => s.id))).toEqual([
      'os-provider',
    ])
  })

  it('摘要缺席(存量老会话)不影响判定,更不会当成空串命中一切', () => {
    const old = SESSIONS.find((s) => s.id === 'lo-notes')!
    expect(old.digest).toBeNull()
    expect(sessionMatchesQuery(old, '判定函数')).toBe(false)
    expect(sessionMatchesQuery(old, '随手记')).toBe(true)
  })
})

/**
 * H 批:有会话被删掉了。这个纯函数只做**夹持** —— 被删的那条留下的指针要收回来,
 * 还站得住的指针一格不动(见函数自己的注释里那四条)。
 */
describe('sessionsRemoved —— 会话没了之后的形态夹持', () => {
  /** 摘除之后的分组事实。函数拿到的一律是这一份(数据源先改列表再叫它)。 */
  const without = (ids: string[]) => {
    const left = SESSIONS.filter((s) => !ids.includes(s.id))
    return buildGroups(buildProjects(left), left)
  }

  it('删的是别人时是恒等变换 —— 返回同一个 state 引用,这块面不重渲染', () => {
    const st = openQuickLook(overview, 'os-expose')
    expect(sessionsRemoved(st, ['lo-notes'], without(['lo-notes']))).toBe(st)
    expect(sessionsRemoved(st, [], GROUPS)).toBe(st)
  })

  it('Quick Look 正开着被删的那条 → 退回总览(否则状态机停在一个画不出来的档)', () => {
    const st = openQuickLook(overview, 'os-expose')
    const next = sessionsRemoved(st, ['os-expose'], without(['os-expose']))
    expect(next.view).toEqual({ mode: 'overview' })
  })

  it('当前会话被删 → 回空态,而不是自动挑一条顶上', () => {
    const st = enterSession(overview, 'os-compact')
    const next = sessionsRemoved(st, ['os-compact'], without(['os-compact']))
    expect(next.currentSessionId).toBe('')
    // 「挑一条顶上」是替用户做决定 —— 序列首那条一个字都没被写进去。
    expect(next.currentSessionId).not.toBe('os-provider')
  })

  it('焦点落在已经不在的卡上 → 退到新序列首(与折叠 / 改搜索词同一句话)', () => {
    const st = { ...overview, focusId: 'os-expose' }
    const groups = without(['os-expose'])
    const next = sessionsRemoved(st, ['os-expose'], groups)
    expect(next.focusId).toBe(visibleCardIds(next, groups)[0])
    expect(next.focusId).not.toBe('os-expose')
  })

  it('一条不剩时焦点诚实地回到 null,而不是指着一张不存在的卡', () => {
    const allIds = SESSIONS.map((s) => s.id)
    const next = sessionsRemoved({ ...overview, focusId: 'os-provider' }, allIds, [])
    expect(next.focusId).toBeNull()
  })

  it('组列表停在一个空掉之后消失了的组 → 退回总览', () => {
    // 独立会话组只有 lo-notes 一条,删掉它这个组就从分组事实里消失。
    const st = enterList(overview, 'loose')
    const groups = without(['lo-notes'])
    expect(groups.some((g) => g.id === 'loose')).toBe(false)
    expect(sessionsRemoved(st, ['lo-notes'], groups).view).toEqual({ mode: 'overview' })
  })

  it('组还在(只是少了一条)就不退层 —— 还站得住的指针一格不动', () => {
    const st = enterList(overview, ONETHING_DIR)
    const next = sessionsRemoved(st, ['os-expose'], without(['os-expose']))
    expect(next.view).toEqual({ mode: 'list', groupId: ONETHING_DIR })
  })

  it('级联删除:名单里的每一条都算数(删一间房连着删掉它的子会话)', () => {
    const st = { ...enterSession(overview, 'rm-release'), view: { mode: 'quicklook' as const, sessionId: 'dm-ying' } }
    const next = sessionsRemoved(st, ['rm-release', 'dm-ying'], without(['rm-release', 'dm-ying']))
    expect(next.currentSessionId).toBe('')
    expect(next.view).toEqual({ mode: 'overview' })
  })
})
