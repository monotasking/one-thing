import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useStageStore } from '../../stage/store'
import { NOW, SESSION_META, seedSessionsSource } from '../../data/__fixtures__/sessions'
import { configureSessionsPort } from '../../data/sessions-port'
import { sessionMutation } from '../../data/sessions-source'
import { focusTree } from '../../focus/registry'
import { liveRegionText, resetLiveRegions } from '../../ui/a11y/live-region'
import { ConfirmHost, useConfirmHub } from '../../ui/Dialog'
import { useExposeStore } from '../store'
import { openSessionIds } from './__fixtures__/open-sessions'
import { useWorkbenchStore } from '../../workbench/store'
import { initialExposeState } from '../transitions'
import { togglePinAndAnnounce } from './pin-announce'
import { FocusDispatchHarness } from '../../test/focus-harness'
import { SESSION_PREFETCH_HOVER_MS } from '../../components/motion'
import { chatSources } from '../../data/chat-source'
import { resetChatPrefetch } from '../../data/chat-prefetch'
import { ExposeView } from './ExposeView'
import { pinMacUserAgent } from '../../test/mac-ua'

/*
 * 数「行的渲染体跑了几次」的那把尺子(判词在下面那条用例上)。`rowKindOf` 是
 * `SessionRowView` 渲染体里**无条件**的一句,所以它的调用次数就是行的渲染次数;
 * 真实现原样转发 —— 这不是一个假模块,只是一个计数器。
 */
const rowKindCalls: string[] = []
vi.mock('../row-kinds', async (importOriginal) => {
  const real = await importOriginal<typeof import('../row-kinds')>()
  return {
    ...real,
    rowKindOf: (kind: Parameters<typeof real.rowKindOf>[0]) => {
      rowKindCalls.push(String(kind))
      return real.rowKindOf(kind)
    },
  }
})

/**
 * 列表这张树:角色 / 层级 / 展开、`aria-activedescendant`、四条结构键、
 * 置顶后活动行跟着搬。整块面一起渲染(键盘挂在作用域根上,单渲染 SessionTree
 * 会把委托那一半测没)。
 */
beforeEach(() => {
  /* T1-fix:这一组拿 mac 的词写(⌘…),而 jsdom 的 UA 不是 mac ——
   * 判词整段在 `src/test/mac-ua.ts` 上。 */
  pinMacUserAgent()
  // 夹具的 NOW 与真店的「现在」差好几天,不钉住的话所有行都塌进月桶。
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  useStageStore.setState({ locale: 'zh', placements: {} })
  seedSessionsSource()
  useExposeStore.setState({ ...initialExposeState, view: { mode: 'overview' } })
  // W5-b:「进了哪条会话」落在树上,所以每条用例都从一棵干净的树起步。
  useWorkbenchStore.getState().reset()
})

afterEach(() => {
  // 单槽 confirm hub 是进程级的:不结掉会把一个悬着的 promise 漏进下一条用例
  // (包在 act 里 —— 结掉它会让还挂着的 ConfirmHost 重渲一次)。
  act(() => useConfirmHub.getState().settle(false))
  // 悬停预取那只表与它捂热的机器都是进程级的,不收就会漏进下一条用例。
  resetChatPrefetch()
  chatSources.resetAll()
  sessionMutation.reset()
  resetLiveRegions()
  vi.restoreAllMocks()
})

const tree = () => screen.getByTestId('expose-tree')
/**
 * 屏幕上的**会话行**(不含节头)。09-04 分节可折叠之后节头也是 `treeitem`,
 * 所以「有哪几条会话」这一问改按 `[data-session-id]` 取件。
 */
const rows = () =>
  [...tree().querySelectorAll<HTMLElement>('[data-session-id]')].map((el) =>
    el.getAttribute('data-session-id'),
  )
/** 树上全部可聚焦的项(节头 + 会话行),按屏幕顺序 —— 焦点序列那一半。 */
const nodes = () => [...tree().querySelectorAll<HTMLElement>('[role="treeitem"]')]
const head = (id: string) => screen.getByTestId(`expose-section-${id}`)
const key = (k: string) => fireEvent.keyDown(tree(), { key: k })
const lightUp = (id: string) => act(() => useExposeStore.setState({ focusId: id, focusVisible: true }))

/**
 * 一份**会认账**的端口:置顶那一发成功,重拉回来的那份带着新的 isPinned。
 * 缺了它,settle 的重拉会拿 `src/test/setup.ts` 的出厂假端口(空列表)把屏幕清掉 ——
 * 那样测出来的不是「行搬没搬家」,是「列表还在不在」。
 */
function stubPort(
  over: {
    updatePin?: () => Promise<{ success: boolean; error?: string }>
    /* A2:改名与删除各一格覆写口 —— 「后端说不行」那两条用例靠它。 */
    rename?: (sessionId: string, newName: string) => Promise<{ success: boolean; error?: string }>
    remove?: (sessionId: string) => Promise<{ success: boolean; error?: string }>
  } = {},
) {
  const pinned = new Set<string>()
  /*
   * A2:这份假端口的账本再长两格 —— 改过的名字与删掉的 id。
   * 它们与 `pinned` 是同一条理由(见这只函数头上那段):重拉回来的那一份要
   * **认账**,不然测出来的不是「行换了字 / 行没了」,是「列表还在不在」。
   */
  const names = new Map<string, string>()
  const gone = new Set<string>()
  configureSessionsPort({
    ready: async () => undefined,
    listMeta: async () => ({
      success: true,
      sessions: SESSION_META.filter((m) => !gone.has(m.id)).map((m) => ({
        ...m,
        ...(pinned.has(m.id) ? { isPinned: true } : {}),
        ...(names.has(m.id) ? { name: names.get(m.id) } : {}),
      })),
    }),
    getSegments: async () => ({ success: true, segments: [] }),
    getMessagesPage: async () => ({ success: true, messages: [] }),
    getUserMarkers: async () => ({ success: true, markers: [] }),
    create: async () => ({ success: false, error: 'not stubbed' }),
    updateWorkingDirectory: async () => ({ success: true }),
    updatePin:
      over.updatePin ??
      (async (sessionId: string, isPinned: boolean) => {
        if (isPinned) pinned.add(sessionId)
        else pinned.delete(sessionId)
        return { success: true }
      }),
    rename:
      over.rename ??
      (async (sessionId: string, newName: string) => {
        names.set(sessionId, newName)
        return { success: true }
      }),
    delete:
      over.remove ??
      (async (sessionId: string) => {
        gone.add(sessionId)
        return { success: true }
      }),
    onSessionEvent: () => () => undefined,
    onSessionLifecycle: () => () => undefined,
  })
}

describe('树的角色与结构', () => {
  it('容器是 tree、有名字、是**唯一**那个 Tab 位;行谁都不可聚焦', () => {
    render(<ExposeView />)
    expect(tree().getAttribute('role')).toBe('tree')
    expect(tree().getAttribute('aria-label')).toBe('会话总览')
    expect(tree().tabIndex).toBe(0)
    const focusable = [...tree().querySelectorAll<HTMLElement>('[role="treeitem"]')].filter(
      (el) => el.tabIndex >= 0,
    )
    expect(focusable).toEqual([])
  })

  it('分节:节头是 aria-level=1 的 treeitem,行装在它后面那只 role="group" 里', () => {
    render(<ExposeView />)
    const groups = [...tree().querySelectorAll('[role="group"]')]
    expect(groups.length).toBeGreaterThan(1)
    for (const group of groups) {
      const id = group.getAttribute('aria-labelledby')!
      const el = document.getElementById(id)!
      // 名字从节头取,而节头**自己就是树的一项**(09-04 起可折叠)。
      expect(el.getAttribute('role')).toBe('treeitem')
      expect(el.getAttribute('aria-level')).toBe('1')
      expect(el.hasAttribute('aria-expanded')).toBe(true)
      // group 是**兄弟**不是孩子:嵌进去的话 accname 会把整片行文本算进节头的名字。
      expect(el.contains(group)).toBe(false)
    }
    /*
     * **不带计数**(08-30 禁令):节头的文字就是那个桶的名字,一个字不多。
     * 逐条对表比「不许出现数字」硬 —— 月桶的名字本来就带数字(「8 月」),
     * 那条粗判据会把一条合法的标题判红。
     */
    expect([...tree().querySelectorAll('[data-section-id]')].map((el) => el.textContent)).toEqual([
      '置顶',
      '今天',
      '昨天',
      '本周',
      '8 月',
    ])
  })

  it('置顶那一节排在最前,且置顶的会话**只在这一节出现一次**', () => {
    render(<ExposeView />)
    const heads = [...tree().querySelectorAll('[data-section-id]')].map((el) => el.textContent)
    expect(heads[0]).toBe('置顶')
    expect(rows().filter((id) => id === 'os-toolkit').length).toBe(1)
    expect(rows()[0]).toBe('os-toolkit')
    // 焦点序列的第一格是那个节头,第二格才是那条会话。
    expect(nodes()[0]).toBe(head('pinned'))
    expect(nodes()[1].getAttribute('data-session-id')).toBe('os-toolkit')
  })

  it('房间的子行挂在房间下(展开才出),孤儿子会话**回顶层**不静默丢', () => {
    render(<ExposeView />)
    expect(rows()).not.toContain('wk-verify')
    // 孤儿(父房间 rm-gone 不在集合里)在顶层。09-04:节头占第 1 级,顶层会话是第 2 级。
    const orphan = screen.getByTestId('session-row-wk-orphan')
    expect(orphan.getAttribute('aria-level')).toBe('2')
    expect(orphan.getAttribute('data-depth')).toBe('0')

    act(() => useExposeStore.getState().toggleRoom('rm-release'))
    const after = rows()
    expect(after.indexOf('wk-verify')).toBe(after.indexOf('rm-release') + 1)
    expect(screen.getByTestId('session-row-wk-verify').getAttribute('aria-level')).toBe('3')
  })
})

describe('展开箭头:同一个 DOM 节点上翻,零重挂', () => {
  it('连点 N 次 = 精确切换 N 次,而且节点身份一格不变(四律第 4 条)', () => {
    render(<ExposeView />)
    const before = screen.getByTestId('session-row-rm-release')
    expect(before.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(screen.getByTestId('session-row-caret-rm-release'))
    expect(screen.getByTestId('session-row-rm-release')).toBe(before)
    expect(before.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(screen.getByTestId('session-row-caret-rm-release'))
    expect(screen.getByTestId('session-row-rm-release')).toBe(before)
    expect(before.getAttribute('aria-expanded')).toBe('false')
  })
})

/**
 * ── 分节折叠(09-04 用户真机报「分组没法收」)────────────────────────────
 * 与展开箭头那一组同一条纪律:**原地形变**,节头是同一个 DOM 节点。
 */
describe('分节收 / 展:同一个节头节点上翻,零重挂', () => {
  it('点节头 = 收起这一节:行消失、aria-expanded 翻面、**节点身份一格不变**', () => {
    render(<ExposeView />)
    const before = head('today')
    expect(before.getAttribute('aria-expanded')).toBe('true')
    expect(rows()).toContain('os-provider')

    fireEvent.click(before)
    expect(head('today')).toBe(before)
    expect(before.getAttribute('aria-expanded')).toBe('false')
    expect(rows()).not.toContain('os-provider')
    // 别的节一格没动。
    expect(rows()).toContain('os-toolkit')
    // 收起来的节**没有** group(不留一只空壳),节头照旧在焦点序列里。
    expect(tree().querySelector('[aria-labelledby="expose-section-today"]')).toBeNull()
    expect(nodes()).toContain(before)

    fireEvent.click(head('today'))
    expect(head('today')).toBe(before)
    expect(before.getAttribute('aria-expanded')).toBe('true')
    expect(rows()).toContain('os-provider')
  })

  it('→ / ← 在节头上收展;收起时焦点正在这一节的行上就退到节头', () => {
    render(<ExposeView />)
    lightUp('os-provider')
    // ← 从行回到节头,再一下 ← 把这一节收起来。
    key('ArrowLeft')
    expect(useExposeStore.getState().focusId).toBe('section:today')
    key('ArrowLeft')
    expect(head('today').getAttribute('aria-expanded')).toBe('false')
    expect(rows()).not.toContain('os-provider')
    // 活动项仍是那个节头(aria-activedescendant 指得着,不是指着空气)。
    expect(tree().getAttribute('aria-activedescendant')).toBe('expose-section-today')
    expect(document.getElementById('expose-section-today')).toBeTruthy()
    // → 展回去。
    key('ArrowRight')
    expect(head('today').getAttribute('aria-expanded')).toBe('true')
    expect(rows()).toContain('os-provider')
  })

  it('收起来的节里有命中时**搜索强制张开**,清了词又收回去', () => {
    render(<ExposeView />)
    fireEvent.click(head('thisWeek'))
    expect(rows()).not.toContain('tr-menubar')
    act(() => useExposeStore.getState().setQuery('菜单栏'))
    expect(rows()).toContain('tr-menubar')
    act(() => useExposeStore.getState().setQuery(''))
    expect(rows()).not.toContain('tr-menubar')
  })

  it('节头有活动环(与行同一条 data-active 配方),而且不可聚焦', () => {
    render(<ExposeView />)
    act(() => useExposeStore.setState({ focusId: 'section:today', focusVisible: true }))
    expect(head('today').getAttribute('data-active')).toBe('true')
    expect(head('today').tabIndex).toBeLessThan(0)
  })
})

describe('活动行:aria-activedescendant 只在键盘会话里指人', () => {
  it('focusVisible 为假时**谁都不指**(焦点环只在键盘会话亮)', () => {
    render(<ExposeView />)
    // 有锚点、但键盘位没显形 —— 这一档读屏也不该被拽到某一行上。
    act(() => useExposeStore.setState({ focusId: 'os-provider', focusVisible: false }))
    expect(tree().hasAttribute('aria-activedescendant')).toBe(false)
    expect(screen.getByTestId('session-row-os-provider').hasAttribute('data-active')).toBe(false)
  })

  it('点亮之后指着那一行,行上同时挂 data-active', () => {
    render(<ExposeView />)
    lightUp('os-provider')
    expect(tree().getAttribute('aria-activedescendant')).toBe('expose-row-os-provider')
    expect(screen.getByTestId('session-row-os-provider').getAttribute('data-active')).toBe('true')
  })

  /*
   * hover ≠ active(09-01 用户裁定)。这块面的键盘位是 store 的 focusId;
   * 鼠标扫过一行一个字都不许写 —— 二次污染那条链(↑↓ → scrollIntoView →
   * 指针没动却换了脚下的行 → 浏览器补一发 mouseenter)在行距更小的列表上更难被
   * 看成是自己按错了。
   */
  it('mouseenter / mouseover / pointerover 不改锚点:鼠标扫过整屏,键盘位一格不动', () => {
    render(<ExposeView />)
    lightUp('os-toolkit')
    const all = [...tree().querySelectorAll<HTMLElement>('[role="treeitem"]')]
    expect(all.length).toBeGreaterThan(1)
    for (const el of all) {
      fireEvent.mouseEnter(el)
      fireEvent.mouseOver(el)
      // `pointerover` 是第 6 单新接的那一条(悬停预取的委托口)。它进这个循环
      // 不是顺手 —— 新长出来的指针路径正是这条法最容易被重新违反的地方。
      fireEvent.pointerOver(el)
    }
    expect(useExposeStore.getState().focusId).toBe('os-toolkit')
  })

  /*
   * 悬停预取的**委托口**(第 6 单):停满读认窗口之后,那条会话的数据机器活起来。
   * 这一条测的是 `SessionTree` 那一半 —— 从事件目标 `closest('[data-session-id]')`
   * 认出是哪一行、行与行之间的空当算「离开」;窗口、速率闸与预热在
   * `data/chat-prefetch.test.ts` 里各有各的判据。
   */
  it('指针在一行上停满读认窗口 → 那条会话的机器活起来;停在空当上不算', async () => {
    render(<ExposeView />)
    const row = screen.getByTestId('session-row-os-provider')
    fireEvent.pointerOver(row)
    // 还没停满:一台机器都没有。
    expect(chatSources.get('os-provider')).toBeUndefined()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, SESSION_PREFETCH_HOVER_MS + 20))
    })
    expect(chatSources.get('os-provider')).toBeDefined()

    // 走到行与行之间的空当(树自己):`closest` 认不出行 = 一次「离开」,表被掐掉。
    fireEvent.pointerOver(tree())
    fireEvent.pointerOver(screen.getByTestId('session-row-os-toolkit'))
    fireEvent.pointerOver(tree())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, SESSION_PREFETCH_HOVER_MS + 20))
    })
    expect(chatSources.get('os-toolkit')).toBeUndefined()
  })

  /*
   * 「键盘走到视口外的行时把它带回来」—— 09-04 这条 effect 从**每一行**上移到
   * 树上一条(冷开预算:400 行里恒有 399 条只是「我不是活动行」;病历在
   * SessionRow 文件头第 ③ 笔)。搬家的反证就是这一条:它按 `activeId` 从 DOM 上
   * 取那一行,所以断言必须落在**那一行自己的**节点上,而不是「有人被滚过」。
   * 拆掉树上那条 effect → 这条当场红。
   */
  it('活动行换人时,新的那一行被滚进视野(effect 在树上,不在行上)', () => {
    const original = Element.prototype.scrollIntoView
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    try {
      render(<ExposeView />)
      scrollIntoView.mockClear()
      lightUp('os-provider')
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
      expect(scrollIntoView.mock.instances[0]).toBe(screen.getByTestId('session-row-os-provider'))
    } finally {
      Element.prototype.scrollIntoView = original
    }
  })
})

describe('树的结构键(设计 §3.2 那张表的右半列)', () => {
  /** 焦点序列 = 树上全部的项(节头 + 会话行),按屏幕顺序。 */
  const order = () =>
    nodes().map((el) => el.getAttribute('data-session-id') ?? `section:${el.getAttribute('data-section-id')}`)

  it('↓ / ↑ 走行,到头不回绕;**节头也在序列里**(走得到才收得动)', () => {
    render(<ExposeView />)
    const seq = order()
    expect(seq[0]).toBe('section:pinned')
    lightUp(seq[0]!)
    key('ArrowUp')
    expect(useExposeStore.getState().focusId).toBe(seq[0])
    key('ArrowDown')
    expect(useExposeStore.getState().focusId).toBe(seq[1])
  })

  it('Home / End 落首项 / 末项', () => {
    render(<ExposeView />)
    const seq = order()
    lightUp(seq[2]!)
    key('End')
    expect(useExposeStore.getState().focusId).toBe(seq[seq.length - 1])
    key('Home')
    expect(useExposeStore.getState().focusId).toBe(seq[0])
  })

  it('→ 未展开的房间 → 展开;再一下 → 进第一个子行', () => {
    render(<ExposeView />)
    lightUp('rm-release')
    key('ArrowRight')
    expect(useExposeStore.getState().expandedRooms).toContain('rm-release')
    expect(useExposeStore.getState().focusId).toBe('rm-release')
    key('ArrowRight')
    expect(useExposeStore.getState().focusId).toBe('wk-verify')
  })

  it('← 子行 → 回父;父上再一下 → 收起', () => {
    render(<ExposeView />)
    act(() => useExposeStore.getState().expandRoom('rm-release'))
    lightUp('wk-verify')
    key('ArrowLeft')
    expect(useExposeStore.getState().focusId).toBe('rm-release')
    key('ArrowLeft')
    expect(useExposeStore.getState().expandedRooms).not.toContain('rm-release')
  })

  it('非房间行上的 → 什么都不做;← 回它的节头(树的 ← = 回父项)', () => {
    render(<ExposeView />)
    lightUp('os-provider')
    key('ArrowRight')
    expect(useExposeStore.getState().focusId).toBe('os-provider')
    key('ArrowLeft')
    expect(useExposeStore.getState().focusId).toBe('section:today')
    expect(useExposeStore.getState().expandedRooms).toEqual([])
  })

  it('Space = Quick Look 活动行(与 APG tree 的 Space=选择刻意偏离,理由见设计 §3.2)', () => {
    render(<ExposeView />)
    lightUp('os-provider')
    key(' ')
    expect(useExposeStore.getState().view).toEqual({ mode: 'quicklook', sessionId: 'os-provider' })
  })

  it('↵ = 进活动行的会话', () => {
    render(<ExposeView />)
    lightUp('os-compact')
    key('Enter')
    // W5-b:「进了哪条会话」看的是树(判词与夹具在 `__fixtures__/open-sessions`)。
    expect(openSessionIds()).toContain('os-compact')
  })

  it('↵ 落在**节头**上 = 收 / 展这一节,而不是进某条会话', () => {
    render(<ExposeView />)
    lightUp('section:today')
    key('Enter')
    expect(head('today').getAttribute('aria-expanded')).toBe('false')
    expect(openSessionIds()).toEqual([])
    key('Enter')
    expect(head('today').getAttribute('aria-expanded')).toBe('true')
    expect(openSessionIds()).toEqual([])
  })

  it('Space 落在节头上什么都不做(一个分组没有可以预览的正文)', () => {
    render(<ExposeView />)
    lightUp('section:today')
    key(' ')
    expect(useExposeStore.getState().view).toEqual({ mode: 'overview' })
  })
})

/*
 * ── 09-12:行上那颗图钉退役了,这一组改叫那一口 ────────────────────────────
 * 拍板 3 把悬停动作收成一颗 ⋯,图钉与眼睛退役成菜单里的行 —— 而「置顶」那一行
 * 归 A2。所以此刻置顶的入口只有 ⌘⇧P(与它背后那只 `togglePinAndAnnounce`)。
 *
 * 这一组要证的东西**一个字没变**:乐观那一笔就地搬家、focusId 不动、播报一句、
 * 后端拒了翻回去。变的只有**谁按下它** —— 从「点那颗钮」换成「叫那一口」。
 * 下面第三条(⌘⇧P)本来就是走键盘那条路的,它现在是这一组里唯一还带着
 * 「真有人按了一下」的用例;等 A2 把「置顶」那一行接进菜单,这里该补一条
 * 「点菜单里那一行」。**这处覆盖缺口记在 A1 的交卷报留账里。**
 */
describe('置顶:行当场搬家,活动行跟着搬', () => {
  it('叫那一口 → 那一行立刻进「置顶」节,focusId 一格不动(就地更新,律①)', async () => {
    stubPort()
    render(<ExposeView />)
    lightUp('os-provider')
    expect(rows().indexOf('os-provider')).toBeGreaterThan(0)

    await act(async () => {
      togglePinAndAnnounce('os-provider')
      await Promise.resolve()
    })

    const after = rows()
    // 置顶节在最前,而 os-provider 现在排在 os-toolkit 之后(两条都置顶,按时间倒序)。
    expect(after.slice(0, 2)).toEqual(['os-provider', 'os-toolkit'])
    expect(useExposeStore.getState().focusId).toBe('os-provider')
    expect(tree().getAttribute('aria-activedescendant')).toBe('expose-row-os-provider')

    // 播报一句(polite),**零 Toast**:结果全在屏幕上,读屏用户缺的只是那句话。
    await act(async () => {
      vi.useFakeTimers()
      vi.advanceTimersByTime(1)
      vi.useRealTimers()
    })
    expect(liveRegionText('polite')).toBe('已置顶 重构 provider 抽象')
  })

  it('⌘⇧P 走的是作用域局部键那条路,作用在活动行上', async () => {
    stubPort()
    /*
     * ⌘⇧P 是**面域局部键**:声明在 `FOCUS_SCOPES.expose.keys`,由全壳唯一那个
     * 派发器(`focus/dispatch.ts` 的 window 捕获)沿活动路径派下来。所以这一条
     * 要摆两样东西:派发器(单渲染 ExposeView 时它不在场,平时由 AppShell 挂)
     * 与活动路径(把这块面送上去)。
     */
    render(
      <>
        <FocusDispatchHarness />
        <ExposeView />
      </>,
    )
    act(() => void focusTree.activateScope('expose'))
    lightUp('os-compact')
    await act(async () => {
      fireEvent.keyDown(window, { key: 'p', metaKey: true, shiftKey: true })
      await Promise.resolve()
    })
    expect(rows()[0]).toBe('os-compact')
  })

  it('后端说不行 → 乐观那一笔翻回去,行退回原来的节', async () => {
    // 写没成 = 一次重拉都不发(settle 直接返回),所以屏幕上留下的只可能是
    // 乐观那一笔 —— 这一条因此真的能判「翻没翻回去」。
    stubPort({ updatePin: async () => ({ success: false, error: '这条会话不在' }) })
    render(<ExposeView />)
    await act(async () => {
      togglePinAndAnnounce('os-provider')
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(rows()[0]).toBe('os-toolkit')
    expect(rows().indexOf('os-provider')).toBeGreaterThan(0)
    // 写没成就**不播报** —— 屏幕上什么都没发生,说一句「已置顶」就是在说谎。
    await act(async () => {
      vi.useFakeTimers()
      vi.advanceTimersByTime(1)
      vi.useRealTimers()
    })
    expect(liveRegionText('polite')).toBe('')
  })
})

/*
 * ── A2:动作面接上之后的三条真路 ───────────────────────────────────────────
 * 上面那一组是「叫那一口会发生什么」;这一组是**真有人点了一下**,而且走的是
 * 屏幕上那条链:右键一行 → 那张表 → 那一行。A1 的留账 1(「菜单里没有置顶,
 * 这处覆盖缺口留给 A2」)在第一条里结清。
 *
 * 菜单本身逐行的形与在场归 `SessionActionsMenu.test.tsx`;这里判的是**贯通**:
 * 行上的字真的换了 / 那条会话真的没了 / 那一行真的进了置顶节。
 */
describe('A2 动作面:右键那张表 → 真的落地', () => {
  const openRowMenu = (id: string) =>
    fireEvent.contextMenu(screen.getByTestId(`session-row-${id}`), { clientX: 10, clientY: 10 })
  const menuRow = (name: string) => screen.getByRole('menuitem', { name })
  /*
   * 等那一句播报真的落进 live region。
   *
   * **不用上面那一组的 `useFakeTimers + advanceTimersByTime(1)`**:`announce`
   * 的那一发 `setTimeout(…, 0)` 是在**真定时器**下排的(播报发生在写路那条
   * promise 链的末尾),而 `vi.useFakeTimers()` 管不着一个已经排好的真定时器 ——
   * 那一手在这一组里是**看运气**(整套跑时这一条真的红过一次:读到空串)。
   * 让一个真的 0ms 宏任务跑完是这件事唯一诚实的等法。
   */
  const flushAnnounce = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

  it('菜单里点「置顶」→ 那一行进置顶节(A1 留账 1 结清:与 ⌘⇧P 同一口)', async () => {
    stubPort()
    render(<ExposeView />)
    expect(rows().indexOf('os-provider')).toBeGreaterThan(0)

    openRowMenu('os-provider')
    await act(async () => {
      fireEvent.click(menuRow('置顶'))
      await Promise.resolve()
    })

    expect(rows().slice(0, 2)).toEqual(['os-provider', 'os-toolkit'])
    // 与键盘那条路共用播报那一个产地,所以这一句话在两条路上逐字相同。
    await flushAnnounce()
    expect(liveRegionText('polite')).toBe('已置顶 重构 provider 抽象')
  })

  it('「重命名…」→ 那一行的标题**原地**换成输入框,↵ 落定之后行上的字换了', async () => {
    stubPort()
    render(<ExposeView />)

    openRowMenu('os-provider')
    fireEvent.click(menuRow('重命名…'))

    const box = screen.getByTestId('session-row-rename-os-provider') as HTMLInputElement
    // 原地:那只框长在**那一行里面**(不是弹一个对话框)。
    expect(screen.getByTestId('session-row-os-provider').contains(box)).toBe(true)
    // 初值 = 屏幕上那个标题,而且一进来就全选(库件 `ui/inline-edit` 那一发)。
    expect(box.value).toBe('重构 provider 抽象')

    await act(async () => {
      fireEvent.change(box, { target: { value: 'provider 聚合根' } })
      fireEvent.keyDown(box, { key: 'Enter' })
      await Promise.resolve()
      await Promise.resolve()
    })

    // 框收回、字换了(就地更新,律①:不等那一次往返)。
    expect(screen.queryByTestId('session-row-rename-os-provider')).toBeNull()
    expect(useExposeStore.getState().renamingId).toBeNull()
    expect(screen.getByTestId('session-row-os-provider').textContent).toContain('provider 聚合根')
  })

  it('改名时 Esc = 收回,**一个字都不写**(取消不是提交)', async () => {
    stubPort()
    render(<ExposeView />)
    openRowMenu('os-provider')
    fireEvent.click(menuRow('重命名…'))

    const box = screen.getByTestId('session-row-rename-os-provider') as HTMLInputElement
    await act(async () => {
      fireEvent.change(box, { target: { value: '改了一半' } })
      fireEvent.keyDown(box, { key: 'Escape' })
      await Promise.resolve()
    })

    expect(screen.queryByTestId('session-row-rename-os-provider')).toBeNull()
    expect(screen.getByTestId('session-row-os-provider').textContent).toContain('重构 provider 抽象')
  })

  it('改名那只框里点一下 / 按一下,**不会进那条会话、也不会开始拖它**', () => {
    stubPort()
    render(<ExposeView />)
    openRowMenu('os-provider')
    fireEvent.click(menuRow('重命名…'))

    const box = screen.getByTestId('session-row-rename-os-provider')
    fireEvent.click(box)
    fireEvent.pointerDown(box)
    // 行的 onClick 是 `enterSession`(它会把这块面收回 Dock 并装树)——
    // 截不住的话点一下输入框那只框当场卸载,人连一个字都打不进去。
    expect(openSessionIds()).toEqual([])
    expect(useExposeStore.getState().renamingId).toBe('os-provider')
  })

  it('后端拒了改名 → 行上的字翻回原名,并播报**后端原话**', async () => {
    stubPort({ rename: async () => ({ success: false, error: '这条会话不在' }) })
    render(<ExposeView />)
    openRowMenu('os-provider')
    fireEvent.click(menuRow('重命名…'))

    const box = screen.getByTestId('session-row-rename-os-provider')
    await act(async () => {
      fireEvent.change(box, { target: { value: '改不成' } })
      fireEvent.keyDown(box, { key: 'Enter' })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByTestId('session-row-os-provider').textContent).toContain('重构 provider 抽象')
    await flushAnnounce()
    expect(liveRegionText('polite')).toBe('改名没成:这条会话不在')
  })

  it('「删除…」→ 确认框 → 确定:那一行没了(先摘格子,再删账本)', async () => {
    stubPort()
    render(
      <>
        <ExposeView />
        <ConfirmHost />
      </>,
    )
    // 先把它开进树里 —— 「先摘格子」那一半要有对象才判得出来。
    await act(async () => {
      useExposeStore.getState().enterSession('os-provider')
      await Promise.resolve()
    })
    expect(openSessionIds()).toContain('os-provider')

    openRowMenu('os-provider')
    await act(async () => {
      fireEvent.click(menuRow('删除…'))
      await Promise.resolve()
    })
    expect(screen.getByRole('dialog').textContent).toContain('重构 provider 抽象')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '删除' }))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(rows()).not.toContain('os-provider')
    expect(openSessionIds()).not.toContain('os-provider')
  })

  it('确认框里按「取消」→ 那一行一个字没动(确认不是形式)', async () => {
    stubPort()
    render(
      <>
        <ExposeView />
        <ConfirmHost />
      </>,
    )
    openRowMenu('os-provider')
    await act(async () => {
      fireEvent.click(menuRow('删除…'))
      await Promise.resolve()
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '取消' }))
      await Promise.resolve()
    })
    expect(rows()).toContain('os-provider')
  })

  it('后端拒了删除 → 那一行留在屏上,并播报后端原话', async () => {
    stubPort({ remove: async () => ({ success: false, error: '这条会话不在' }) })
    render(
      <>
        <ExposeView />
        <ConfirmHost />
      </>,
    )
    openRowMenu('os-provider')
    await act(async () => {
      fireEvent.click(menuRow('删除…'))
      await Promise.resolve()
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '删除' }))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(rows()).toContain('os-provider')
    await flushAnnounce()
    expect(liveRegionText('polite')).toBe('删除没成:这条会话不在')
  })

  it('「关闭」只摘格子,**账本一个字不动**(拍板 5:关闭 ≠ 删除)', async () => {
    stubPort()
    render(<ExposeView />)
    await act(async () => {
      useExposeStore.getState().enterSession('os-provider')
      await Promise.resolve()
    })
    expect(openSessionIds()).toContain('os-provider')

    openRowMenu('os-provider')
    // 开着才有这一行 —— 它的在场判据与行尾那颗点同一只纯函数。
    await act(async () => {
      fireEvent.click(menuRow('关闭'))
      await Promise.resolve()
    })

    expect(openSessionIds()).not.toContain('os-provider')
    // 行还在:这一下没碰数据。
    expect(rows()).toContain('os-provider')
  })

  /**
   * **拼贴树动一下,400 行一个都不该重渲**(SessionRow 文件头那段 47.9ms 病历的
   * 前提:递给行的每一格 prop 都稳得住)。
   *
   * A2 自审时真踩过一次:`onMenu` 为了读「这一条开着没有」而闭包住了那只带三格
   * 树依赖的记忆体(`regions` / `hidden` / `panelPath`),于是**开关一格标签就让
   * 400 行的 memo 全部作废**。行的 memo 还在,只是永远比不过 —— 没有任何一道门
   * 看得见(冷开读数不变,而「切一格标签重渲多少行」不在任何预算里)。
   *
   * 判据是**行的渲染体跑了几次**,不是 props 的身份:后者要从 fiber 上读,而
   * `__reactFiber$` 指的是**挂载那一刻**那个 fiber —— React 每次提交把
   * current / alternate 对调,所以隔一次渲染读到的是**上一版** props。
   * 第一稿就是这么写的,反证当场空过(拆掉修法照样绿)。所以这里数的是
   * `rowKindOf` 的调用次数:它在 `SessionRowView` 的渲染体里**无条件**跑一次,
   * memo 挡住了就一次都不跑。
   */
  it('拼贴树变了 → 会话行一次都不重渲(400 行 memo 的前提)', async () => {
    stubPort()
    render(<ExposeView />)
    const rowsOnScreen = rows().length
    expect(rowsOnScreen).toBeGreaterThan(3)

    rowKindCalls.length = 0
    // 拼贴树动一下(开一格会话 = regions / focusLeafId 都换了引用)。
    const before = useWorkbenchStore.getState().regions
    await act(async () => {
      useExposeStore.getState().enterSession('os-toolkit')
      await Promise.resolve()
    })
    expect(useWorkbenchStore.getState().regions, '树没动,这一条就什么都没证').not.toBe(before)

    /*
     * 只许**那两条真的换了状态的行**重渲(`os-toolkit` 成了当前会话 + 它多了
     * 一颗开着点;原来那条当前会话翻回去)。其余一行都不许跑。
     */
    expect(rowKindCalls.length).toBeLessThanOrEqual(2)
  })

  it('没开着的那一条,菜单里**没有**「关闭」这一行', () => {
    stubPort()
    render(<ExposeView />)
    openRowMenu('os-provider')
    expect(screen.queryByRole('menuitem', { name: '关闭' })).toBeNull()
  })
})
