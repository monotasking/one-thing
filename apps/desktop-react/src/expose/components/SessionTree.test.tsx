import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useStageStore } from '../../stage/store'
import { NOW, SESSION_META, seedSessionsSource } from '../../data/__fixtures__/sessions'
import { configureSessionsPort } from '../../data/sessions-port'
import { sessionMutation } from '../../data/sessions-source'
import { focusTree } from '../../focus/registry'
import { liveRegionText, resetLiveRegions } from '../../ui/a11y/live-region'
import { useExposeStore } from '../store'
import { initialExposeState } from '../transitions'
import { FocusDispatchHarness } from '../../test/focus-harness'
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
})

afterEach(() => {
  sessionMutation.reset()
  resetLiveRegions()
  vi.restoreAllMocks()
})

const tree = () => screen.getByTestId('expose-tree')
const rows = () =>
  [...tree().querySelectorAll<HTMLElement>('[role="treeitem"]')].map((el) =>
    el.getAttribute('data-session-id'),
  )
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

  it('分节是 role="group",由节头那个 <h3> 命名;节头不带计数', () => {
    render(<ExposeView />)
    const groups = [...tree().querySelectorAll('[role="group"]')]
    expect(groups.length).toBeGreaterThan(1)
    for (const group of groups) {
      const id = group.getAttribute('aria-labelledby')!
      expect(document.getElementById(id)!.tagName).toBe('H3')
    }
    /*
     * **不带计数**(08-30 禁令):节头的文字就是那个桶的名字,一个字不多。
     * 逐条对表比「不许出现数字」硬 —— 月桶的名字本来就带数字(「8 月」),
     * 那条粗判据会把一条合法的标题判红。
     */
    expect([...tree().querySelectorAll('h3')].map((el) => el.textContent)).toEqual([
      '置顶',
      '今天',
      '昨天',
      '本周',
      '8 月',
    ])
  })

  it('置顶那一节排在最前,且置顶的会话**只在这一节出现一次**', () => {
    render(<ExposeView />)
    const heads = [...tree().querySelectorAll('h3')].map((el) => el.textContent)
    expect(heads[0]).toBe('置顶')
    expect(rows().filter((id) => id === 'os-toolkit').length).toBe(1)
    expect(rows()[0]).toBe('os-toolkit')
  })

  it('房间的子行挂在房间下(展开才出),孤儿子会话**回顶层**不静默丢', () => {
    render(<ExposeView />)
    expect(rows()).not.toContain('wk-verify')
    // 孤儿(父房间 rm-gone 不在集合里)在顶层、level 1。
    const orphan = screen.getByTestId('session-row-wk-orphan')
    expect(orphan.getAttribute('aria-level')).toBe('1')
    expect(orphan.getAttribute('data-depth')).toBe('0')

    act(() => useExposeStore.getState().toggleRoom('rm-release'))
    const after = rows()
    expect(after.indexOf('wk-verify')).toBe(after.indexOf('rm-release') + 1)
    expect(screen.getByTestId('session-row-wk-verify').getAttribute('aria-level')).toBe('2')
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
  it('mouseenter / mouseover 不改锚点:鼠标扫过整屏,键盘位一格不动', () => {
    render(<ExposeView />)
    lightUp('os-toolkit')
    const all = [...tree().querySelectorAll<HTMLElement>('[role="treeitem"]')]
    expect(all.length).toBeGreaterThan(1)
    for (const el of all) {
      fireEvent.mouseEnter(el)
      fireEvent.mouseOver(el)
    }
    expect(useExposeStore.getState().focusId).toBe('os-toolkit')
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
  it('↓ / ↑ 走行,到头不回绕', () => {
    render(<ExposeView />)
    const order = rows()
    lightUp(order[0]!)
    key('ArrowUp')
    expect(useExposeStore.getState().focusId).toBe(order[0])
    key('ArrowDown')
    expect(useExposeStore.getState().focusId).toBe(order[1])
  })

  it('Home / End 落首行 / 末行', () => {
    render(<ExposeView />)
    const order = rows()
    lightUp(order[2]!)
    key('End')
    expect(useExposeStore.getState().focusId).toBe(order[order.length - 1])
    key('Home')
    expect(useExposeStore.getState().focusId).toBe(order[0])
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

  it('非房间行上的 →/← 什么都不做(不是「无声地走一步」)', () => {
    render(<ExposeView />)
    lightUp('os-provider')
    key('ArrowRight')
    key('ArrowLeft')
    expect(useExposeStore.getState().focusId).toBe('os-provider')
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
    expect(useExposeStore.getState().currentSessionId).toBe('os-compact')
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
