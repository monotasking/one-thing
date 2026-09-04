import { describe, it, expect } from 'vitest'
import {
  closeQuickLook,
  collapseRoom,
  enterSession,
  escape,
  expandRoom,
  focusGrid,
  initialExposeState,
  isRoomExpanded,
  listModelOf,
  moveFocus,
  open,
  openQuickLook,
  quickLookNeighbors,
  quickLookNext,
  activateRow,
  collapseSection,
  expandSection,
  isSectionCollapsed,
  quickLookPrev,
  relativeTime,
  rowIdsOf,
  sessionRowIdsOf,
  toggleSection,
  sessionMatchesQuery,
  sessionsRemoved,
  setQuery,
  setScope,
  splitHighlight,
  splitHighlightRanges,
  toggleRoom,
  treeKey,
  type ListFacts,
} from './transitions'
import { findSession } from './projection'
import { projectScope } from './scopes'
import { FACTS, NOW, ONETHING_DIR, SESSIONS, TRANSREADER_DIR } from '../data/__fixtures__/sessions'
import type { ExposeState } from './types'

/** 当前会话在这些用例里就是夹具里的第一条 —— 开场焦点该落在它身上。 */
const CURRENT = SESSIONS[0].id

const base: ExposeState = { ...initialExposeState, currentSessionId: CURRENT }
const overview = open(base, FACTS)
/** 焦点序列(**含节头**)—— 方向键 / Home / End 走的就是它。 */
const seq = rowIdsOf(base, FACTS)
/**
 * 只有会话的那一半。09-04 分节可折叠之后节头进了 `seq`,而「翻下一条会话」
 * (Quick Look)与「焦点没处落时落哪儿」问的都是这一条。
 */
const sseq = sessionRowIdsOf(base, FACTS)

/** 名册换一份的那种用例:摘掉几条会话之后的那份事实。 */
const without = (ids: string[]): ListFacts => ({
  sessions: SESSIONS.filter((s) => !ids.includes(s.id)),
  now: NOW,
})
const EMPTY: ListFacts = { sessions: [], now: NOW }

describe('open(开场归位)', () => {
  it('开场落在 overview,焦点落在当前会话', () => {
    expect(overview.view).toEqual({ mode: 'overview' })
    expect(overview.focusId).toBe(CURRENT)
  })

  it('当前会话被范围滤掉时,焦点退到序列首', () => {
    const elsewhere: ExposeState = { ...base, scope: projectScope(TRANSREADER_DIR) }
    const next = open(elsewhere, FACTS)
    // 锚点落**第一条会话**,不是序列首(那是节头)—— 理由见 transitions.anchorOf。
    expect(next.focusId).toBe(sessionRowIdsOf(elsewhere, FACTS)[0])
    expect(next.focusId).not.toBe(CURRENT)
  })

  it('一条会话都没有时焦点是 null,而不是指向空气', () => {
    expect(open(base, EMPTY).focusId).toBeNull()
  })

  it('开场是**无条件**归位:停在 quicklook、带着搜索词,再开一次都回到总览', () => {
    const deep = setQuery(openQuickLook(overview, 'os-expose'), 'provider', FACTS)
    const reopened = open(deep, FACTS)
    expect(reopened.view).toEqual({ mode: 'overview' })
    expect(reopened.query).toBe('')
  })

  it('**范围核一次**:记着的那一格站不住了就退回「全部」,而不是开出一张空表', () => {
    const stale: ExposeState = { ...base, scope: projectScope('/已经没有了') }
    expect(open(stale, FACTS).scope).toEqual({ kind: 'all' })
    // 还站得住的那一格原样留着 —— 核不是「每次都重置」。
    const live: ExposeState = { ...base, scope: projectScope(ONETHING_DIR) }
    expect(open(live, FACTS).scope).toEqual(projectScope(ONETHING_DIR))
  })

  it('两层视图就是全部:list 那一层 09-04 退役,总览上的 Esc 是恒等变换', () => {
    const modes = [overview, openQuickLook(overview, 'os-expose')]
    expect(modes.map((st) => st.view.mode)).toEqual(['overview', 'quicklook'])
    expect(escape(overview)).toBe(overview)
  })

  it('是纯函数:不改原对象', () => {
    const before = JSON.parse(JSON.stringify(base))
    open(base, FACTS)
    moveFocus(overview, 'down', FACTS)
    treeKey(overview, 'expand', FACTS)
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

  it('quicklook 退回总览时焦点留在刚看的那一行上', () => {
    const ql = openQuickLook(overview, 'lo-notes')
    expect(escape(ql).focusId).toBe('lo-notes')
  })

  it('初始态(总览)上 Esc 是恒等变换', () => {
    expect(escape(base)).toBe(base)
  })

  it('closeQuickLook 只对 quicklook 生效', () => {
    expect(closeQuickLook(overview)).toBe(overview)
    expect(closeQuickLook(openQuickLook(overview, 'os-compact')).view).toEqual({ mode: 'overview' })
  })
})

describe('moveFocus(一维:↑↓)', () => {
  it('↓ 走一行,↑ 走回来', () => {
    const down = moveFocus(overview, 'down', FACTS)
    expect(down.focusId).toBe(seq[seq.indexOf(CURRENT) + 1])
    expect(moveFocus(down, 'up', FACTS).focusId).toBe(CURRENT)
  })

  it('序列是**整张表**拼起来的:一路按下去能从置顶节走到最后一个月桶', () => {
    let st: ExposeState = { ...overview, focusId: seq[0] }
    for (let i = 0; i < seq.length + 5; i += 1) st = moveFocus(st, 'down', FACTS)
    expect(st.focusId).toBe(seq[seq.length - 1])
  })

  it('到头就停,不回绕(环已亮时撞边是恒等变换)', () => {
    const top: ExposeState = { ...overview, focusId: seq[0] }
    const lit = moveFocus(top, 'up', FACTS)
    expect(lit.focusId).toBe(seq[0])
    expect(moveFocus(lit, 'up', FACTS)).toBe(lit)
  })

  it('还没落焦时任何方向键都先把焦点放到序列首', () => {
    const nofocus: ExposeState = { ...overview, focusId: null }
    expect(moveFocus(nofocus, 'up', FACTS).focusId).toBe(seq[0])
    expect(moveFocus(nofocus, 'down', FACTS).focusId).toBe(seq[0])
  })

  it('一行都没有时是恒等变换(空态里按方向键什么都不该发生)', () => {
    expect(moveFocus(overview, 'down', EMPTY)).toBe(overview)
  })
})

/**
 * §3.2 那张表的「焦点在树」那一列。←→ 在树上是**层级**不是走位,
 * 所以它有自己的入口(`treeKey`),不与 `moveFocus` 共用一个方向联合。
 */
describe('treeKey(树语义的 ←→ 与 Home / End)', () => {
  const onRoom: ExposeState = { ...overview, focusId: 'rm-release', focusVisible: true }

  it('→ 在收着的房间上 = 展开;再按一下 = 进第一个子行', () => {
    const opened = treeKey(onRoom, 'expand', FACTS)
    expect(isRoomExpanded(opened, 'rm-release')).toBe(true)
    expect(opened.focusId).toBe('rm-release')
    expect(treeKey(opened, 'expand', FACTS).focusId).toBe('wk-verify')
  })

  it('← 在子行上 = 回父;在展开的房间上 = 收起', () => {
    const opened = treeKey(onRoom, 'expand', FACTS)
    const onChild = treeKey(opened, 'expand', FACTS)
    const backToParent = treeKey(onChild, 'collapse', FACTS)
    expect(backToParent.focusId).toBe('rm-release')
    expect(isRoomExpanded(backToParent, 'rm-release')).toBe(true)
    const closed = treeKey(backToParent, 'collapse', FACTS)
    expect(isRoomExpanded(closed, 'rm-release')).toBe(false)
  })

  it('非房间的行上 → 无动作(只点亮环,位置与展开态一格不动)', () => {
    const onChat: ExposeState = { ...overview, focusId: CURRENT, focusVisible: true }
    expect(treeKey(onChat, 'expand', FACTS)).toBe(onChat)
  })

  /*
   * 09-04:顶层会话行上的 ← 从「什么都不做」变成「回到它的节头」——
   * APG tree 的 ← 就是「没有可收的东西时回父项」,而在这之前一条顶层行**没有**父。
   */
  it('顶层会话行上的 ← = 回它的节头(节头就是这一层的父项)', () => {
    const onChat: ExposeState = { ...overview, focusId: CURRENT, focusVisible: true }
    // CURRENT(os-provider)落在「今天」那一节。
    expect(treeKey(onChat, 'collapse', FACTS).focusId).toBe('section:today')
  })

  it('没有子行的房间:→ 也不展开(表上它 expandable 是 false)', () => {
    const onSwap: ExposeState = { ...overview, focusId: 'sw-pair', focusVisible: true }
    expect(treeKey(onSwap, 'expand', FACTS)).toBe(onSwap)
    expect(isRoomExpanded(treeKey(onSwap, 'expand', FACTS), 'sw-pair')).toBe(false)
  })

  it('Home / End 落首行末行', () => {
    expect(treeKey(overview, 'home', FACTS).focusId).toBe(seq[0])
    expect(treeKey(overview, 'end', FACTS).focusId).toBe(seq[seq.length - 1])
  })

  it('还没落焦时先落序列首;一行都没有时是恒等变换', () => {
    const nofocus: ExposeState = { ...overview, focusId: null }
    expect(treeKey(nofocus, 'expand', FACTS).focusId).toBe(sseq[0])
    expect(treeKey(overview, 'home', EMPTY)).toBe(overview)
  })
})

describe('房间展开 / 收起', () => {
  it('toggleRoom 来回切;expandRoom 幂等', () => {
    const opened = toggleRoom(overview, 'rm-release', FACTS)
    expect(rowIdsOf(opened, FACTS)).toContain('wk-verify')
    expect(expandRoom(opened, 'rm-release')).toBe(opened)
    expect(rowIdsOf(toggleRoom(opened, 'rm-release', FACTS), FACTS)).not.toContain('wk-verify')
  })

  it('收起时焦点正在子行上 → **退到房间那一行**,不是弹回列表开头', () => {
    const opened = expandRoom(overview, 'rm-release')
    const onChild: ExposeState = { ...opened, focusId: 'ag-xiaoli' }
    expect(collapseRoom(onChild, 'rm-release', FACTS).focusId).toBe('rm-release')
  })

  it('收起别处的房间不动焦点', () => {
    const opened = expandRoom({ ...overview, focusId: CURRENT }, 'rm-release')
    expect(collapseRoom(opened, 'rm-release', FACTS).focusId).toBe(CURRENT)
  })

  it('收一间本来就没展开的房是恒等变换', () => {
    expect(collapseRoom(overview, 'rm-release', FACTS)).toBe(overview)
  })
})

/**
 * ── 分节折叠(09-04 用户真机报「分组没法收」)────────────────────────────
 * 与房间那一组是同一套语法的另一层:收 / 展、焦点往上退一层、搜索强制全开。
 */
describe('分节收 / 展', () => {
  it('toggleSection 来回切;expandSection 对一个本来就开着的节是恒等变换', () => {
    const folded = toggleSection(overview, 'today', FACTS)
    expect(isSectionCollapsed(folded, 'today')).toBe(true)
    expect(sessionRowIdsOf(folded, FACTS)).not.toContain('os-provider')
    const back = toggleSection(folded, 'today', FACTS)
    expect(isSectionCollapsed(back, 'today')).toBe(false)
    expect(expandSection(back, 'today')).toBe(back)
    expect(collapseSection(folded, 'today', FACTS)).toBe(folded)
  })

  it('收起时焦点正在这一节的行上 → **退到节头**,不是弹回列表开头', () => {
    const onRow: ExposeState = { ...overview, focusId: CURRENT, focusVisible: true }
    const folded = collapseSection(onRow, 'today', FACTS)
    expect(folded.focusId).toBe('section:today')
    expect(rowIdsOf(folded, FACTS)).toContain('section:today')
  })

  it('收起别的节不动焦点', () => {
    const onRow: ExposeState = { ...overview, focusId: CURRENT, focusVisible: true }
    expect(collapseSection(onRow, 'thisWeek', FACTS).focusId).toBe(CURRENT)
  })

  it('→ 在收着的节上 = 展开;再一下 = 进这一节第一行', () => {
    const folded = collapseSection(overview, 'today', FACTS)
    const onHead: ExposeState = { ...folded, focusId: 'section:today', focusVisible: true }
    const opened = treeKey(onHead, 'expand', FACTS)
    expect(isSectionCollapsed(opened, 'today')).toBe(false)
    expect(opened.focusId).toBe('section:today')
    expect(treeKey(opened, 'expand', FACTS).focusId).toBe('os-provider')
  })

  it('← 在展开的节头上 = 收起;已经收着了就没有更上一层可退', () => {
    const onHead: ExposeState = { ...overview, focusId: 'section:today', focusVisible: true }
    const folded = treeKey(onHead, 'collapse', FACTS)
    expect(isSectionCollapsed(folded, 'today')).toBe(true)
    // 收着的节头上再按一下 ← :位置与折叠态都不动(节头就是第一级)。
    const again = treeKey(folded, 'collapse', FACTS)
    expect(again.focusId).toBe('section:today')
    expect(isSectionCollapsed(again, 'today')).toBe(true)
  })

  it('↵ 落在节头上 = 收 / 展这一节,**不是**进会话;落在行上才是进会话', () => {
    const onHead: ExposeState = { ...overview, focusId: 'section:today', focusVisible: true }
    const first = activateRow(onHead, FACTS)
    expect(first.enterSessionId).toBeNull()
    expect(isSectionCollapsed(first.state, 'today')).toBe(true)
    // 再一下把它展回去(同一口,两态)。
    expect(isSectionCollapsed(activateRow(first.state, FACTS).state, 'today')).toBe(false)

    const onRow: ExposeState = { ...overview, focusId: CURRENT, focusVisible: true }
    const entered = activateRow(onRow, FACTS)
    expect(entered.enterSessionId).toBe(CURRENT)
    expect(entered.state).toBe(onRow)
    // 没有活动行时这一下什么都不是。
    expect(activateRow({ ...overview, focusId: null }, FACTS).enterSessionId).toBeNull()
  })

  it('搜索时**强制全开**,清了词还收着(强制展开是派生态,不落库)', () => {
    const folded = collapseSection(overview, 'thisWeek', FACTS)
    const searched = setQuery(folded, '菜单栏', FACTS)
    expect(sessionRowIdsOf(searched, FACTS)).toEqual(['tr-menubar'])
    expect(isSectionCollapsed(searched, 'thisWeek')).toBe(true)
    expect(sessionRowIdsOf(setQuery(searched, '', FACTS), FACTS)).not.toContain('tr-menubar')
  })

  it('收起的节 id 与会话无关,所以级联删会话不会把它清掉(无害的死键同房间)', () => {
    const folded = collapseSection(overview, 'today', FACTS)
    const next = sessionsRemoved(folded, ['os-provider'], without(['os-provider']))
    expect(next.collapsedSections).toEqual(['today'])
  })
})

describe('setScope(侧栏换范围)', () => {
  it('换过去只剩这一档的行;搜索词**留着**(换个范围继续用同一个词)', () => {
    const scoped = setScope({ ...overview, query: 'flask' }, projectScope(TRANSREADER_DIR), FACTS)
    expect(scoped.query).toBe('flask')
    expect(sessionRowIdsOf(scoped, FACTS)).toEqual(['tr-flask'])
  })

  it('焦点被换掉的范围滤掉时退到新序列首', () => {
    const scoped = setScope(overview, projectScope(TRANSREADER_DIR), FACTS)
    expect(scoped.focusId).toBe(sessionRowIdsOf(scoped, FACTS)[0])
    expect(scoped.focusId).not.toBe(CURRENT)
  })
})

/**
 * 搜索框把键盘交给列表(08-30 键盘死区的修法):**只点亮,不移动**。
 */
describe('focusGrid', () => {
  it('锚点还在序列里:只点亮环,焦点一格不动', () => {
    const dark: ExposeState = { ...overview, focusId: seq[2], focusVisible: false }
    const litted = focusGrid(dark, FACTS)
    expect(litted.focusId).toBe(seq[2])
    expect(litted.focusVisible).toBe(true)
  })

  it('环已经亮着时是恒等变换', () => {
    const litted: ExposeState = { ...overview, focusId: seq[2], focusVisible: true }
    expect(focusGrid(litted, FACTS)).toBe(litted)
  })

  it('锚点被过滤掉了就落到序列首', () => {
    const stale: ExposeState = { ...overview, focusId: 'not-on-screen', focusVisible: false }
    expect(focusGrid(stale, FACTS).focusId).toBe(sseq[0])
    const nofocus: ExposeState = { ...overview, focusId: null }
    expect(focusGrid(nofocus, FACTS).focusId).toBe(sseq[0])
  })

  it('一行都没有时是恒等变换', () => {
    expect(focusGrid(overview, EMPTY)).toBe(overview)
  })
})

describe('quickLookPrev / Next', () => {
  it('← → 在 quicklook 内换会话,面板不关', () => {
    const ql = openQuickLook(overview, sseq[1])
    const next = quickLookNext(ql, FACTS)
    expect(next.view).toEqual({ mode: 'quicklook', sessionId: sseq[2] })
    expect(quickLookPrev(next, FACTS).view).toEqual({ mode: 'quicklook', sessionId: sseq[1] })
  })

  it('换会话时焦点跟着走', () => {
    const ql = quickLookNext(openQuickLook(overview, sseq[0]), FACTS)
    expect(ql.focusId).toBe(sseq[1])
  })

  it('到头就停', () => {
    const first = openQuickLook(overview, sseq[0])
    expect(quickLookPrev(first, FACTS)).toBe(first)
    const last = openQuickLook(overview, sseq[sseq.length - 1])
    expect(quickLookNext(last, FACTS)).toBe(last)
  })

  /*
   * 09-04:节头也在焦点序列里,但它**不是可以预览的东西**。
   * 翻页只在会话之间走 —— 否则「下一条」会翻出一屏空白。
   */
  it('翻页跳过节头:两条会话之间隔着一个节头也照样一步翻过去', () => {
    // sseq 里相邻、seq 里中间夹着节头的那一对(今天最后一条 → 昨天第一条)。
    const from = 'dm-ying'
    const to = 'os-expose'
    expect(seq[seq.indexOf(from) + 1]).toBe('section:yesterday')
    expect(quickLookNext(openQuickLook(overview, from), FACTS).view).toEqual({
      mode: 'quicklook',
      sessionId: to,
    })
  })

  it('Space 落在节头上是恒等变换(一个分组没有可以预览的正文)', () => {
    expect(openQuickLook(overview, 'section:today')).toBe(overview)
  })

  it('不在 quicklook 里时是恒等变换', () => {
    expect(quickLookNext(overview, FACTS)).toBe(overview)
  })
})

describe('搜索 = 过滤器,不是另一层视图', () => {
  it('焦点序列跟着过滤走:搜索之后方向键只在命中的行之间移动', () => {
    const searched = setQuery(overview, 'Exposé', FACTS)
    expect(sessionRowIdsOf(searched, FACTS)).toEqual(['os-expose'])
    expect(searched.focusId).toBe('os-expose')
  })

  it('搜到一行都没有时焦点是 null,而不是指着一行不在屏幕上的行', () => {
    const searched = setQuery(overview, '这个词哪儿都没有', FACTS)
    expect(rowIdsOf(searched, FACTS)).toEqual([])
    expect(searched.focusId).toBeNull()
  })

  it('焦点还在命中集里时不动它 —— 打字不该把光标从我正看的那一行上弹开', () => {
    expect(setQuery(overview, 'provider', FACTS).focusId).toBe(CURRENT)
  })

  it('子行命中:父作为通路进序列,子行跟在后面(展开是派生态,没落库)', () => {
    const searched = setQuery(overview, '全链路验收', FACTS)
    expect(sessionRowIdsOf(searched, FACTS)).toEqual(['rm-release', 'wk-verify'])
    expect(searched.expandedRooms).toEqual([])
  })

  it('空词时 sessionMatchesQuery 一律为真 —— 「没在搜」不等于「都不中」', () => {
    expect(SESSIONS.every((s) => sessionMatchesQuery(s, ''))).toBe(true)
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
 * 入参当作不可信 —— 所以这一组里大半是边界:越界、乱序、重叠、空段。
 */
describe('splitHighlightRanges(区间由产地给定)', () => {
  const text = '重构 provider 抽象'
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
    const first = openQuickLook(overview, sseq[0])
    expect(quickLookNeighbors(first, FACTS).prev).toBeNull()
    expect(quickLookNeighbors(first, FACTS).next).toBe(sseq[1])

    const last = openQuickLook(overview, sseq[sseq.length - 1])
    expect(quickLookNeighbors(last, FACTS).next).toBeNull()
    expect(quickLookNeighbors(last, FACTS).prev).toBe(sseq[sseq.length - 2])
  })

  it('中间两边都有邻居', () => {
    const mid = openQuickLook(overview, sseq[1])
    expect(quickLookNeighbors(mid, FACTS)).toEqual({ prev: sseq[0], next: sseq[2] })
  })

  it('序列是**过滤之后**的那一条,不是全量', () => {
    // 「房」命中两条:发版房(标题)与孤儿派工(预览「房间已经没了」)——
    // 两条都**不是**全量序列的第一行,所以过滤没生效的话 prev 不会是 null。
    const searched = setQuery(overview, '房', FACTS)
    const visible = sessionRowIdsOf(searched, FACTS)
    expect(visible.length).toBeGreaterThan(1)
    expect(sseq.indexOf(visible[0])).toBeGreaterThan(0)

    const st = openQuickLook(searched, visible[0])
    expect(quickLookNeighbors(st, FACTS)).toEqual({ prev: null, next: visible[1] })
    const unfiltered = openQuickLook(overview, visible[0])
    expect(quickLookNeighbors(unfiltered, FACTS).prev).toBe(sseq[sseq.indexOf(visible[0]) - 1])
  })

  it('不在 quicklook 层时两边都是 null', () => {
    expect(quickLookNeighbors(overview, FACTS)).toEqual({ prev: null, next: null })
  })
})

describe('enterSession / 时间', () => {
  it('进入 = 换当前会话 + 内容回到起点(收回 Dock 是 store 壳的事,不在纯函数里)', () => {
    const next = enterSession(setQuery(overview, 'x', FACTS), 'tr-menubar')
    expect(next.currentSessionId).toBe('tr-menubar')
    expect(next.view).toEqual({ mode: 'overview' })
    expect(next.query).toBe('')
  })

  it('再开场不动那两格家具与当前会话', () => {
    const st = expandRoom(enterSession(overview, 'lo-notes'), 'rm-release')
    expect(open(st, FACTS).currentSessionId).toBe('lo-notes')
    expect(open(st, FACTS).expandedRooms).toEqual(['rm-release'])
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
    const st = open(base, FACTS)
    expect(st.focusId).not.toBeNull()
    expect(st.focusVisible).toBe(false)
  })

  it('按方向键才点亮;撞边不动位置也点亮', () => {
    expect(moveFocus(open(base, FACTS), 'down', FACTS).focusVisible).toBe(true)
    const edge = moveFocus({ ...open(base, FACTS), focusId: null }, 'up', FACTS)
    expect(edge.focusVisible).toBe(true)
  })

  it('再开一次环回到熄灭(残留环就是 08-28 用户看见的"莫名阴影")', () => {
    const litted = moveFocus(open(base, FACTS), 'down', FACTS)
    expect(open(litted, FACTS).focusVisible).toBe(false)
  })
})

/**
 * H 批:有会话被删掉了。这个纯函数只做**夹持** —— 被删的那条留下的指针要收回来,
 * 还站得住的指针一格不动。
 */
describe('sessionsRemoved —— 会话没了之后的形态夹持', () => {
  it('删的是别人时是恒等变换 —— 返回同一个 state 引用,这块面不重渲染', () => {
    const st = openQuickLook(overview, 'os-expose')
    expect(sessionsRemoved(st, ['lo-notes'], without(['lo-notes']))).toBe(st)
    expect(sessionsRemoved(st, [], FACTS)).toBe(st)
  })

  it('Quick Look 正开着被删的那条 → 退回总览(否则状态机停在一个画不出来的档)', () => {
    const st = openQuickLook(overview, 'os-expose')
    expect(sessionsRemoved(st, ['os-expose'], without(['os-expose'])).view).toEqual({
      mode: 'overview',
    })
  })

  it('当前会话被删 → 回空态,而不是自动挑一条顶上', () => {
    const st = enterSession(overview, 'os-compact')
    const next = sessionsRemoved(st, ['os-compact'], without(['os-compact']))
    expect(next.currentSessionId).toBe('')
    expect(next.currentSessionId).not.toBe('os-provider')
  })

  it('焦点落在已经不在的行上 → 退到新序列首', () => {
    const st = { ...overview, focusId: 'os-expose' }
    const facts = without(['os-expose'])
    const next = sessionsRemoved(st, ['os-expose'], facts)
    expect(next.focusId).toBe(sessionRowIdsOf(next, facts)[0])
    expect(next.focusId).not.toBe('os-expose')
  })

  it('一条不剩时焦点诚实地回到 null,而不是指着一行不存在的行', () => {
    const allIds = SESSIONS.map((s) => s.id)
    expect(sessionsRemoved({ ...overview, focusId: 'os-provider' }, allIds, EMPTY).focusId).toBeNull()
  })

  it('级联删除:名单里的每一条都算数(删一间房连着删掉它的子会话)', () => {
    const st = {
      ...enterSession(overview, 'rm-release'),
      view: { mode: 'quicklook' as const, sessionId: 'wk-verify' },
    }
    const next = sessionsRemoved(st, ['rm-release', 'wk-verify'], without(['rm-release', 'wk-verify']))
    expect(next.currentSessionId).toBe('')
    expect(next.view).toEqual({ mode: 'overview' })
  })

  it('删掉一间房之后,它留在展开表里那格死键不影响任何序列', () => {
    const st = expandRoom(overview, 'rm-release')
    const facts = without(['rm-release', 'wk-verify', 'ag-xiaoli'])
    const next = sessionsRemoved(st, ['rm-release', 'wk-verify', 'ag-xiaoli'], facts)
    expect(next.expandedRooms).toEqual(['rm-release'])
    expect(rowIdsOf(next, facts)).not.toContain('rm-release')
  })
})

describe('listModelOf —— 画面与键盘吃的是同一份模型', () => {
  it('rowIds 与 sections 平铺出来的次序逐字相同', () => {
    const model = listModelOf(overview, FACTS)
    expect(model.rowIds).toEqual(
      model.sections.flatMap((s) => [s.head.id, ...s.rows.map((r) => r.id)]),
    )
    expect(model.rowIds).toEqual(rowIdsOf(overview, FACTS))
    expect(model.sessionRowIds).toEqual(sessionRowIdsOf(overview, FACTS))
  })
})
