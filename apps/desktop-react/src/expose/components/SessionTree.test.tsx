import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useStageStore } from '../../stage/store'
import { NOW, SESSION_META, seedSessionsSource } from '../../data/__fixtures__/sessions'
import { configureSessionsPort } from '../../data/sessions-port'
import { sessionMutation } from '../../data/sessions-source'
import { focusTree } from '../../focus/registry'
import { liveRegionText, resetLiveRegions } from '../../ui/a11y/live-region'
import { useExposeStore } from '../store'
import { openSessionIds } from './__fixtures__/open-sessions'
import { useWorkbenchStore } from '../../workbench/store'
import { initialExposeState } from '../transitions'
import { FocusDispatchHarness } from '../../test/focus-harness'
import { SESSION_PREFETCH_HOVER_MS } from '../../components/motion'
import { chatSources } from '../../data/chat-source'
import { resetChatPrefetch } from '../../data/chat-prefetch'
import { ExposeView } from './ExposeView'

/**
 * 列表这张树:角色 / 层级 / 展开、`aria-activedescendant`、四条结构键、
 * 置顶后活动行跟着搬。整块面一起渲染(键盘挂在作用域根上,单渲染 SessionTree
 * 会把委托那一半测没)。
 */
beforeEach(() => {
  // 夹具的 NOW 与真店的「现在」差好几天,不钉住的话所有行都塌进月桶。
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  useStageStore.setState({ locale: 'zh', placements: {} })
  seedSessionsSource()
  useExposeStore.setState({ ...initialExposeState, view: { mode: 'overview' } })
  // W5-b:「进了哪条会话」落在树上,所以每条用例都从一棵干净的树起步。
  useWorkbenchStore.getState().reset()
})

afterEach(() => {
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
function stubPort(over: { updatePin?: () => Promise<{ success: boolean; error?: string }> } = {}) {
  const pinned = new Set<string>()
  configureSessionsPort({
    ready: async () => undefined,
    listMeta: async () => ({
      success: true,
      sessions: SESSION_META.map((m) => (pinned.has(m.id) ? { ...m, isPinned: true } : m)),
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

describe('置顶:行当场搬家,活动行跟着搬', () => {
  it('按下图钉 → 那一行立刻进「置顶」节,focusId 一格不动(就地更新,律①)', async () => {
    stubPort()
    render(<ExposeView />)
    lightUp('os-provider')
    expect(rows().indexOf('os-provider')).toBeGreaterThan(0)

    await act(async () => {
      fireEvent.click(screen.getByTestId('session-row-pin-os-provider'))
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
      fireEvent.click(screen.getByTestId('session-row-pin-os-provider'))
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
