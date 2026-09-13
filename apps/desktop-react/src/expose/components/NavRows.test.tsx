import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useStageStore } from '../../stage/store'
import { NOW, SESSIONS, SESSION_META, seedSessionsSource } from '../../data/__fixtures__/sessions'
import { configureSessionsPort } from '../../data/sessions-port'
import { sessionMutation } from '../../data/sessions-source'
import { useExposeStore } from '../store'
import { openSessionIds } from './__fixtures__/open-sessions'
import { useWorkbenchStore } from '../../workbench/store'
import { initialExposeState } from '../transitions'
import { FocusDispatchHarness } from '../../test/focus-harness'
import { focusTree } from '../../focus/registry'
import { ExposeView } from './ExposeView'

/**
 * 三行导航(09-12 方向 A,替掉 `Toolbar`)—— 搜索行开合、范围菜单、
 * 新会话的单飞闸,以及落点那三档。
 * 「搜索是过滤器不是第四种形态」那一组在 Overview.test 里(它问的是屏幕的形)。
 */
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  useStageStore.setState({ locale: 'zh', placements: {} })
  seedSessionsSource()
  useExposeStore.setState({ ...initialExposeState, view: { mode: 'overview' } })
  // W5-b:「进了哪条会话」落在树上,所以每条用例都从一棵干净的树起步。
  useWorkbenchStore.getState().reset()
})

afterEach(() => {
  sessionMutation.reset()
  vi.restoreAllMocks()
})

/** 「摆出来」是 stage store 里的事实(AutoFocusSearch 叶子自己去问)。 */
const placeSessions = () =>
  useStageStore.setState((s) => ({
    placements: { ...s.placements, sessions: { kind: 'edge', side: 'right' } },
  }))

const searchRow = () => screen.getByTestId('expose-search-row')
const searchBox = () => screen.getByLabelText('筛选会话') as HTMLInputElement
/** 点开搜索行 —— 从「一行字」换成「一只输入框」。 */
const openSearch = () => act(() => void fireEvent.click(searchRow()))

/**
 * Esc **不是**这块面自己挂的监听:全壳只有一个派发器(`focus/dispatch.ts` 的
 * window 捕获),平时由 AppShell 挂。所以按 Esc 的用例要摆两样东西 ——
 * 那个派发器(`FocusDispatchHarness`)与活动路径(把这块面送上去);
 * 少一样等于「在一台没有外壳的机器上按键」,谁都不会响。
 */
function renderWithDispatcher() {
  const out = render(
    <>
      <FocusDispatchHarness />
      <ExposeView />
    </>,
  )
  act(() => void focusTree.activateScope('expose'))
  return out
}

const esc = () => !fireEvent.keyDown(window, { key: 'Escape' })

describe('三行导航吃的是基础件,不是裸 button / 裸 input', () => {
  it('三行都是 ui/ButtonBase(带 data-ui-base 记号),不是裸 button', () => {
    render(<ExposeView />)
    expect(screen.getByTestId('expose-nav')).toBeTruthy()
    for (const id of ['expose-new-session', 'expose-search-row', 'expose-scope-row']) {
      const el = screen.getByTestId(id)
      expect(el.tagName, id).toBe('BUTTON')
      // `ui/ButtonBase` 唯一的痕迹就是这一格记号(它一个像素都不画)。
      expect(el.hasAttribute('data-ui-base'), id).toBe(true)
    }
  })

  it('搜索开着那一档是 ui/Input(有 prefix 槽、有 aria-label)', () => {
    render(<ExposeView />)
    openSearch()
    // ui/Input 把 <input> 包在一层 .field 里,prefix 槽是 aria-hidden 的兄弟。
    expect(searchBox().parentElement?.querySelector('[aria-hidden="true"]')).toBeTruthy()
  })

  it('顶上**没有常驻输入框**:静息态整块面里一个 input 都没有', () => {
    const { container } = render(<ExposeView />)
    expect(container.querySelector('input')).toBeNull()
    expect(screen.queryByLabelText('筛选会话')).toBeNull()
  })
})

describe('搜索行:一行字 ⇄ 一只输入框(同一行的两种形)', () => {
  it('点它 → 输入框在场、那一行字不在场;焦点落进输入框', () => {
    placeSessions()
    render(<ExposeView />)
    openSearch()
    expect(useExposeStore.getState().searching).toBe(true)
    expect(screen.queryByTestId('expose-search-row')).toBeNull()
    expect(document.activeElement).toBe(searchBox())
  })

  it('Esc 有词:清词 + 收回成行 + 焦点回那一行(Esc 的第 0 层)', () => {
    placeSessions()
    renderWithDispatcher()
    openSearch()
    fireEvent.change(searchBox(), { target: { value: 'Exposé' } })
    expect(useExposeStore.getState().query).toBe('Exposé')
    act(() => void esc())
    expect(useExposeStore.getState().query).toBe('')
    expect(useExposeStore.getState().searching).toBe(false)
    expect(document.activeElement).toBe(searchRow())
  })

  /*
   * **这一条是与正本 §5 那句话的出入,所以它自己一条用例**(判词在
   * ExposeView 的 `onEscape` 上):正本写「没词时走既有 onEscape」,而
   * 一只刚点开、还没打字的输入框在方向 A 之后是一个**真状态** ——
   * 拿「没词」判它会让这一下越过它把整块面收回 Dock(退了两层)。
   */
  it('Esc 没词但开着:也只收回成行(不越过这一层去收整块面)', () => {
    placeSessions()
    renderWithDispatcher()
    openSearch()
    let consumed = false
    act(() => {
      consumed = esc()
    })
    expect(consumed).toBe(true)
    expect(useExposeStore.getState().searching).toBe(false)
  })

  it('搜索行是一行字的时候,Esc **不拦** —— 让宿主那一层去收这块面', () => {
    placeSessions()
    renderWithDispatcher()
    // 消费掉 = preventDefault;这一下必须没有,宿主那一层才轮得到。
    expect(esc()).toBe(false)
  })

  it('进一条会话之后搜索行收回成一行字(「回到起点」多的那一格)', () => {
    placeSessions()
    render(<ExposeView />)
    openSearch()
    fireEvent.change(searchBox(), { target: { value: 'Exposé' } })
    act(() => void useExposeStore.getState().enterSession('os-expose'))
    expect(useExposeStore.getState().searching).toBe(false)
    expect(screen.getByTestId('expose-search-row')).toBeTruthy()
  })
})

describe('落点三档(restingTarget)', () => {
  it('摆出来的那一刻落在**搜索行那颗钮**上(第三档);没摆出来就不抢', () => {
    render(<ExposeView />)
    expect(document.activeElement).not.toBe(searchRow())
    act(() => placeSessions())
    expect(document.activeElement).toBe(searchRow())
  })

  it('键盘位亮着 → 落点是树(第一档),即便输入框开着也一样', () => {
    placeSessions()
    render(<ExposeView />)
    openSearch()
    fireEvent.keyDown(searchBox(), { key: 'ArrowDown' })
    expect(useExposeStore.getState().focusVisible).toBe(true)
    expect(document.activeElement).toBe(screen.getByTestId('expose-tree'))
  })
})

describe('搜索条的键盘交接(四条,逐字沿用卡片时代的口径)', () => {
  it('↓:焦点交给树,搜索词原样留着,活动行只点亮不走步', () => {
    placeSessions()
    render(<ExposeView />)
    openSearch()
    fireEvent.change(searchBox(), { target: { value: 'Exposé' } })
    fireEvent.keyDown(searchBox(), { key: 'ArrowDown' })
    expect(useExposeStore.getState().query).toBe('Exposé')
    expect(useExposeStore.getState().focusVisible).toBe(true)
    expect(useExposeStore.getState().focusId).toBe('os-expose')
    // 交接之后焦点落在**树容器**上(落点第一档),不是掉到 body 上。
    expect(document.activeElement).toBe(screen.getByTestId('expose-tree'))
  })

  it('↑ 同理:交接那一下只点亮锚点,不顺手再走一步', () => {
    placeSessions()
    render(<ExposeView />)
    openSearch()
    // 摆锚点要在**归位之后**(open() 会把锚点放在当前会话上)。
    act(() => useExposeStore.setState({ focusId: 'os-toolkit', focusVisible: false }))
    fireEvent.keyDown(searchBox(), { key: 'ArrowUp' })
    expect(useExposeStore.getState().focusVisible).toBe(true)
    expect(useExposeStore.getState().focusId).toBe('os-toolkit')
  })

  it('↵:进屏幕上**第一行**(过滤后的阅读次序,不是第二套命中排序)', () => {
    placeSessions()
    render(<ExposeView />)
    openSearch()
    /*
     * 09-04 口径变化,如实记在这里:搜索**不再命中项目名**。方向 A 把分组换成
     * 按时间的分节,项目成了范围筛选器 —— 于是「按项目找」是点范围行里那一项,
     * 不是往搜索框里打项目名。`sessionMatchesQuery` 只判标题 / 预览 / 摘要。
     */
    fireEvent.change(searchBox(), { target: { value: '菜单栏' } })
    fireEvent.keyDown(searchBox(), { key: 'Enter' })
    // W5-b:「进了哪条会话」看的是树(`currentSessionId` 成了投影)。
    expect(openSessionIds()).toContain('tr-menubar')
  })

  it('←→ 不接:焦点留在输入框里给光标用,状态机一格不动', () => {
    placeSessions()
    render(<ExposeView />)
    openSearch()
    const before = useExposeStore.getState()
    for (const key of ['ArrowLeft', 'ArrowRight']) {
      // fireEvent 返回 false 表示被 preventDefault 了 —— 这两个键必须没有。
      expect(fireEvent.keyDown(searchBox(), { key })).toBe(true)
    }
    expect(document.activeElement).toBe(searchBox())
    expect(useExposeStore.getState().focusVisible).toBe(before.focusVisible)
    expect(useExposeStore.getState().focusId).toBe(before.focusId)
  })
})

describe('范围行:一张表,选中项打勾', () => {
  const scopeRow = () => screen.getByTestId('expose-scope-row')

  it('rest 显当前范围名;`aria-haspopup=menu`,开着时 aria-expanded 翻真', () => {
    render(<ExposeView />)
    expect(scopeRow().getAttribute('aria-haspopup')).toBe('menu')
    expect(scopeRow().getAttribute('aria-expanded')).toBe('false')
    expect(scopeRow().textContent).toContain('全部')
    act(() => void fireEvent.click(scopeRow()))
    expect(scopeRow().getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('[role="menu"]')).toBeTruthy()
  })

  it('点开 → 菜单里的选项与侧栏**同一张表**,当前那一档打勾', () => {
    render(<ExposeView />)
    const railLabels = [...screen.getByTestId('expose-rail').querySelectorAll('[role="option"]')]
      .map((el) => el.textContent)
    fireEvent.click(scopeRow())
    const items = [...document.querySelectorAll('[role="menu"] [role="menuitemradio"]')]
    expect(items.map((el) => el.textContent)).toEqual(railLabels)
    // 打勾的恰好一格,而且就是当前那一档。
    const checked = items.filter((el) => el.getAttribute('aria-checked') === 'true')
    expect(checked.map((el) => el.textContent)).toEqual(['全部'])
  })

  it('选一个项目 → 范围换掉、行上的字换成项目名、菜单关掉', () => {
    render(<ExposeView />)
    fireEvent.click(scopeRow())
    const hit = [...document.querySelectorAll('[role="menu"] [role="menuitemradio"]')].find(
      (el) => el.textContent === 'transreader',
    )!
    act(() => void fireEvent.click(hit))
    expect(useExposeStore.getState().scope).toEqual({
      kind: 'project',
      projectId: '/Users/dev/code/transreader',
    })
    expect(scopeRow().textContent).toContain('transreader')
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })
})

/**
 * **范围菜单封顶那一批**(A6,§9 拍板 1 / 2;报障:真店 24 个项目,菜单无限长)。
 *
 * 封顶本身是库件的事(`ui/Menu` 的用例钉结构,`gate:sessions` ⑨ 在真机上量高度),
 * 这里钉的是**这块面接了它之后**的形:多少个项目才出筛选框、打词滤谁不滤谁、
 * 「更早」折起来的那一行、以及关掉再开是一张干净的表。
 */
describe('范围菜单:项目多时的筛选框与折叠(A6)', () => {
  const scopeRow = () => screen.getByTestId('expose-scope-row')
  const menuItems = () =>
    [...document.querySelectorAll('[role="menu"] [role="menuitemradio"]')].map(
      (el) => el.textContent,
    )
  const filterBox = () => document.querySelector('[data-expose-scope-filter]') as HTMLInputElement

  /**
   * n 个项目的一屏。**每个项目一条会话** —— `buildProjects` 按会话的
   * `workingDirectory` 现造名册,所以「有几个项目」= 「有几个不同的工作目录」。
   * `agoMs` 让那几条落到 7 天线的两侧。
   */
  const seedProjects = (n: number, agoOf: (i: number) => number = () => 0) => {
    const base = SESSIONS[0]
    seedSessionsSource({
      sessions: Array.from({ length: n }, (_, i) => ({
        ...base,
        id: `proj-${i}`,
        title: `会话 ${i}`,
        projectId: `/Users/dev/code/pj${i}`,
        workingDirectory: `/Users/dev/code/pj${i}`,
        updatedAt: NOW - agoOf(i),
      })),
    })
  }

  it('项目不多(≤8)时顶上没有筛选框', () => {
    seedProjects(8)
    render(<ExposeView />)
    act(() => void fireEvent.click(scopeRow()))
    expect(filterBox()).toBeNull()
  })

  it('项目多起来(>8)才画那一格', () => {
    seedProjects(9)
    render(<ExposeView />)
    act(() => void fireEvent.click(scopeRow()))
    expect(filterBox()).toBeTruthy()
  })

  it('打字即过滤,而**固定三档钉在最上面不参与**', () => {
    seedProjects(12)
    render(<ExposeView />)
    act(() => void fireEvent.click(scopeRow()))
    act(() => void fireEvent.change(filterBox(), { target: { value: 'pj1' } }))
    const labels = menuItems()
    // 固定档一格不少(这一屏每条会话都有项目,所以可见的固定档只有「全部」)。
    expect(labels[0]).toBe('全部')
    // 项目只剩命中的那几个(pj1 / pj10 / pj11)。
    expect(labels.slice(1)).toEqual(['pj1', 'pj10', 'pj11'])
  })

  it('大小写不敏感;一个都不命中时固定档照样点得到(不把人困在筛空的表里)', () => {
    seedProjects(12)
    render(<ExposeView />)
    act(() => void fireEvent.click(scopeRow()))
    act(() => void fireEvent.change(filterBox(), { target: { value: 'PJ3' } }))
    expect(menuItems().slice(1)).toEqual(['pj3'])
    act(() => void fireEvent.change(filterBox(), { target: { value: '哪儿都没有' } }))
    expect(menuItems()).toEqual(['全部'])
  })

  it('近 7 天没动过的折成一行「更早 · N 个」,点开才展;有词时全展', () => {
    // 前 9 个刚动过,后 3 个是两周前的。
    seedProjects(12, (i) => (i < 9 ? i * 1000 : 14 * 24 * 60 * 60 * 1000))
    render(<ExposeView />)
    act(() => void fireEvent.click(scopeRow()))
    const older = () => screen.queryByRole('menuitem', { name: '更早 · 3 个' })
    expect(older()).toBeTruthy()
    expect(menuItems()).not.toContain('pj11')

    act(() => void fireEvent.click(older()!))
    expect(menuItems()).toContain('pj11')
    // 那一行还在 —— 它是开关,不是标题。
    expect(older()).toBeTruthy()

    act(() => void fireEvent.click(older()!))
    expect(menuItems()).not.toContain('pj11')
    // 有词 = 全表参与匹配(搜不到与不存在没区别)。
    act(() => void fireEvent.change(filterBox(), { target: { value: 'pj11' } }))
    expect(menuItems()).toContain('pj11')
    expect(older()).toBeNull()
  })

  it('关掉再开是一张干净的表(词与折叠都不活过这一次打开)', () => {
    seedProjects(12, (i) => (i < 9 ? i * 1000 : 14 * 24 * 60 * 60 * 1000))
    render(<ExposeView />)
    act(() => void fireEvent.click(scopeRow()))
    act(() => void fireEvent.change(filterBox(), { target: { value: 'pj1' } }))
    act(() => void fireEvent.click(screen.getByRole('menuitemradio', { name: 'pj1' })))
    expect(document.querySelector('[role="menu"]')).toBeNull()

    act(() => void fireEvent.click(scopeRow()))
    expect(filterBox().value).toBe('')
    expect(screen.queryByRole('menuitem', { name: '更早 · 3 个' })).toBeTruthy()
  })
})

/**
 * **带词收回那一档**(A6 §9 拍板 4)。收形不收词,而一个看不见的过滤器是
 * 09-04 立法禁掉的东西 —— 所以那一行必须自己把词说出来,并给一颗清得掉的 ×。
 */
describe('筛选行:带词收回的那一形', () => {
  const retract = () => act(() => void useExposeStore.getState().leaveExpose())

  it('没词离开 = 与没点过一样', () => {
    render(<ExposeView />)
    openSearch()
    retract()
    expect(screen.getByTestId('expose-search-row').textContent).toBe('筛选')
    expect(screen.queryByTestId('expose-filter-clear')).toBeNull()
  })

  it('有词离开 → 行上写着词 + 一颗 ×;列表**还在过滤**', () => {
    render(<ExposeView />)
    openSearch()
    fireEvent.change(searchBox(), { target: { value: 'Exposé' } })
    retract()
    expect(screen.getByTestId('expose-search-row').textContent).toContain('Exposé')
    expect(screen.getByTestId('expose-filter-clear')).toBeTruthy()
    expect(useExposeStore.getState().query).toBe('Exposé')
  })

  it('× 只清词、**不展开**那一行;它不进 Tab 序(键盘那条路是 Esc)', () => {
    render(<ExposeView />)
    openSearch()
    fireEvent.change(searchBox(), { target: { value: 'Exposé' } })
    retract()
    const clear = screen.getByTestId('expose-filter-clear')
    expect(clear.tabIndex).toBe(-1)
    act(() => void fireEvent.click(clear))
    expect(useExposeStore.getState().query).toBe('')
    expect(useExposeStore.getState().searching).toBe(false)
    expect(screen.getByTestId('expose-search-row').textContent).toBe('筛选')
  })

  it('点那一行重新展开,**词还在框里**', () => {
    render(<ExposeView />)
    openSearch()
    fireEvent.change(searchBox(), { target: { value: 'Exposé' } })
    retract()
    act(() => void fireEvent.click(screen.getByTestId('expose-search-row')))
    expect(searchBox().value).toBe('Exposé')
  })

  it('× 是 ui/IconButton(不是裸 button),提示关着 —— 旁边就写着那个词', () => {
    render(<ExposeView />)
    openSearch()
    fireEvent.change(searchBox(), { target: { value: 'Exposé' } })
    retract()
    const clear = screen.getByTestId('expose-filter-clear')
    expect(clear.hasAttribute('data-ui-base')).toBe(true)
    expect(clear.getAttribute('aria-label')).toBe('清除筛选')
    expect(clear.hasAttribute('title')).toBe(false)
  })
})

/**
 * 新会话的进行中反馈 —— 逐格 `aria-busy`、二次闸、**不用 disabled**。
 * 从卡片时代的组头 `+` 到工具栏那颗钮到今天这一行,语义一个字没变。
 */
describe('新会话:aria-busy + 单飞闸', () => {
  /** 可控的一发建会话:拿住「正在飞」那一刻,拿计时器去撞是碰运气。 */
  function flyCreate(): { land: () => void; done: Promise<unknown> } {
    let release!: () => void
    const gate = new Promise<void>((res) => {
      release = res
    })
    configureSessionsPort({
      ready: async () => undefined,
      listMeta: async () => ({ success: true, sessions: SESSION_META }),
      getSegments: async () => ({ success: true, segments: [] }),
      getMessagesPage: async () => ({ success: true, messages: [] }),
      getUserMarkers: async () => ({ success: true, markers: [] }),
      create: async () => {
        await gate
        return {
          success: true,
          session: { id: 'new-1', name: 'New Chat', messages: [], createdAt: 0, updatedAt: 0 },
        }
      },
      updateWorkingDirectory: async () => ({ success: true }),
      updatePin: async () => ({ success: true }),
      rename: async () => ({ success: true }),
      delete: async () => ({ success: true }),
      onSessionEvent: () => () => undefined,
      onSessionLifecycle: () => () => undefined,
    })
    return { land: release, done: sessionMutation.run({ kind: 'create', projectId: null }) }
  }

  const plus = () => screen.getByTestId('expose-new-session')

  it('在飞时那一行上 aria-busy —— 逐格,不是整面禁灰', async () => {
    render(<ExposeView />)
    expect(plus().getAttribute('aria-busy')).toBeNull()

    let flight!: ReturnType<typeof flyCreate>
    await act(async () => {
      flight = flyCreate()
      await Promise.resolve()
    })
    expect(plus().getAttribute('aria-busy')).toBe('true')

    await act(async () => {
      flight.land()
      await flight.done
    })
    expect(plus().getAttribute('aria-busy')).toBeNull()
  })

  it('二次闸:飞着的时候再点几下,一发都不发出去', async () => {
    render(<ExposeView />)
    const calls: (string | null)[] = []
    const before = useExposeStore.getState().newSession
    useExposeStore.setState({ newSession: async (projectId) => void calls.push(projectId) })
    try {
      let flight!: ReturnType<typeof flyCreate>
      await act(async () => {
        flight = flyCreate()
        await Promise.resolve()
      })
      fireEvent.click(plus())
      fireEvent.click(plus())
      expect(calls).toEqual([])

      await act(async () => {
        flight.land()
        await flight.done
      })
      // 落地之后那一行照常工作 —— 闸是「在飞时」而不是「按过一次就废」。
      fireEvent.click(plus())
      expect(calls).toEqual([null])
    } finally {
      useExposeStore.setState({ newSession: before })
    }
  })

  it('**不用 disabled**:在飞时那一行仍在焦点序里', async () => {
    render(<ExposeView />)
    let flight!: ReturnType<typeof flyCreate>
    await act(async () => {
      flight = flyCreate()
      await Promise.resolve()
    })
    expect(plus().hasAttribute('disabled')).toBe(false)
    await act(async () => {
      flight.land()
      await flight.done
    })
  })

  it('project 范围里建到该项目,其余范围建无项目会话', () => {
    const calls: (string | null)[] = []
    const before = useExposeStore.getState().newSession
    useExposeStore.setState({ newSession: async (projectId) => void calls.push(projectId) })
    try {
      render(<ExposeView />)
      fireEvent.click(screen.getByTestId('expose-scope-project:/Users/dev/code/start-electron'))
      fireEvent.click(plus())
      fireEvent.click(screen.getByTestId('expose-scope-collab'))
      fireEvent.click(plus())
      expect(calls).toEqual(['/Users/dev/code/start-electron', null])
    } finally {
      useExposeStore.setState({ newSession: before })
    }
  })
})

/*
 * ── 样式表那一头(jsdom 不排版,所以判的是规则本身;真的几何由 gate:sessions
 *    与 gate:squeeze 判)。读源文本的门先剥注释 —— 病历里写着这些数。
 */
describe('导航行的量:token 纪律与那条对齐线', () => {
  const css = (rel: string) =>
    readFileSync(resolve(__dirname, rel), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '')

  it('左缘读 --content-lead-left:导航、列表、错误行三处同一条线(拍板 2)', () => {
    expect(css('NavRows.module.css')).toMatch(/padding:[^;]*var\(--content-lead-left\)/)
    expect(css('SessionTree.module.css')).toMatch(/padding:[^;]*var\(--content-lead-left\)/)
    expect(css('Overview.module.css')).toMatch(/padding:[^;]*var\(--content-lead-left\)/)
  })

  /*
   * ── 09-13 对齐律 §8 第 5 条:盒子**对称**探出 ──────────────────────────────
   * 从前左是那条 calc(6)、右是 --sp-2(8),于是悬停 / 选中那块底色左探 6、
   * 右探 8 —— 240px 的架子上那 2px 是看得出来的歪。三块面的左右内边距从今天起
   * 是**同一个表达式**(不是两个恰好相等的数:红灯一挪两边一起走)。
   * 侧栏形那一档才有这条线;总览形(≥761)回 --expose-pad,本条不管它。
   */
  it('左右内边距是同一个表达式:三块面的盒子对称探出(§8 第 5 条)', () => {
    const LEAD = 'calc(var(--content-lead-left) - var(--expose-glyph-w) / 2 - var(--sp-2))'
    /* `padding` 的四格简写要按**括号深度**切:calc() 里面也全是空格,
       拿 `split(/\s+/)` 切会把一个表达式切成七片。 */
    const splitTop = (decl: string): string[] => {
      const out: string[] = []
      let depth = 0
      let cur = ''
      for (const ch of decl) {
        if (ch === '(') depth += 1
        if (ch === ')') depth -= 1
        if (depth === 0 && /\s/.test(ch)) {
          if (cur) out.push(cur)
          cur = ''
          continue
        }
        cur += ch
      }
      if (cur) out.push(cur)
      return out
    }
    for (const rel of ['NavRows.module.css', 'SessionTree.module.css', 'Overview.module.css']) {
      const decl = /padding:\s*([^;]*);/.exec(css(rel))?.[1] ?? ''
      // `padding: <上> <右> <下> <左>` —— 四格里第二格与第四格必须逐字相同。
      const sides = splitTop(decl.trim())
      expect(sides.length, `${rel} 的 padding 不是四格简写`).toBe(4)
      expect(sides[1], rel).toBe(LEAD)
      expect(sides[3], rel).toBe(LEAD)
    }
  })

  it('滚动槽只留右边(`stable`,不是 `both-edges`)—— 09-12 那条报障的修法', () => {
    const scroll = css('SessionTree.module.css')
    expect(scroll).toMatch(/scrollbar-gutter:\s*stable;/)
    expect(scroll).not.toMatch(/both-edges/)
  })

  it('导航行高与 ui/Input 的 md 档同源,而它又与会话行同高(拍板 1 的对账)', () => {
    const tokens = css('../../styles/tokens.css')
    expect(tokens).toMatch(/--expose-nav-row-h:\s*var\(--btn-md\)/)
    const btnMd = /--btn-md:\s*([0-9.]+)px/.exec(tokens)?.[1]
    const rowH = /--expose-row-h:\s*([0-9.]+)px/.exec(tokens)?.[1]
    expect(btnMd, '--btn-md 不见了').toBeDefined()
    expect(rowH, '--expose-row-h 不见了').toBeDefined()
    // 「与会话行同形同高」是一条**对账**:两个数分了叉,换形那一拍就会跳一格。
    expect(rowH).toBe(btnMd)
  })

  it('组件文件零字面色值 / px(容器查询的阈值除外 —— 那里不能写 var())', () => {
    for (const file of ['NavRows.module.css', 'SessionRow.module.css', 'SectionHead.module.css']) {
      const rules = css(file).replace(/@container[^{]*\{/g, '{')
      expect(rules, file).not.toMatch(/:\s*#[0-9a-f]{3,8}\b/i)
      expect(rules, file).not.toMatch(/:\s*\d+px/)
    }
  })
})
