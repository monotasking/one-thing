import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useStageStore } from '../../stage/store'
import { NOW, SESSION_META, seedSessionsSource } from '../../data/__fixtures__/sessions'
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
const searchBox = () => screen.getByLabelText('搜索会话') as HTMLInputElement
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
    expect(screen.queryByLabelText('搜索会话')).toBeNull()
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
