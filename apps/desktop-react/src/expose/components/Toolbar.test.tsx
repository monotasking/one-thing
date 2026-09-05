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
import { ExposeView } from './ExposeView'

/**
 * 工具栏 —— 搜索交接、新会话的单飞闸、窄档选择器。
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

const search = () => screen.getByLabelText('搜索会话') as HTMLInputElement

describe('工具栏吃的是基础件,不是裸 input', () => {
  it('搜索条是 ui/Input(有 prefix 槽、有 aria-label),新会话是 ui/Button', () => {
    render(<ExposeView />)
    expect(screen.getByTestId('expose-toolbar')).toBeTruthy()
    // ui/Input 把 <input> 包在一层 .field 里,prefix 槽是 aria-hidden 的兄弟。
    expect(search().parentElement?.querySelector('[aria-hidden="true"]')).toBeTruthy()
    expect(screen.getByTestId('expose-new-session').tagName).toBe('BUTTON')
  })

  it('窄档那只项目选择器常驻 DOM,选项与侧栏是同一张表', () => {
    render(<ExposeView />)
    const combo = screen.getByRole('combobox', { name: '项目' })
    expect(combo.textContent).toBe('全部')
    const railLabels = [...screen.getByTestId('expose-rail').querySelectorAll('[role="option"]')]
      .map((el) => el.textContent)
    fireEvent.click(combo)
    // 面板 portal 出去了,按 aria-controls 取它自己那一份(侧栏也是 listbox,不能混)。
    const panel = document.getElementById(combo.getAttribute('aria-controls')!)!
    const menuLabels = [...panel.querySelectorAll('[role="option"]')].map((el) => el.textContent)
    expect(menuLabels).toEqual(railLabels)
  })
})

describe('搜索条的键盘交接(四条,逐字沿用卡片时代的口径)', () => {
  it('↓:焦点交给树,搜索词原样留着,活动行只点亮不走步', () => {
    placeSessions()
    render(<ExposeView />)
    fireEvent.change(search(), { target: { value: 'Exposé' } })
    fireEvent.keyDown(search(), { key: 'ArrowDown' })
    expect(useExposeStore.getState().query).toBe('Exposé')
    expect(useExposeStore.getState().focusVisible).toBe(true)
    expect(useExposeStore.getState().focusId).toBe('os-expose')
    // 交接之后焦点落在**树容器**上(落点第二档),不是掉到 body 上。
    expect(document.activeElement).toBe(screen.getByTestId('expose-tree'))
  })

  it('↑ 同理:交接那一下只点亮锚点,不顺手再走一步', () => {
    placeSessions()
    render(<ExposeView />)
    // 摆锚点要在**归位之后**(open() 会把锚点放在当前会话上)。
    act(() => useExposeStore.setState({ focusId: 'os-toolkit', focusVisible: false }))
    fireEvent.keyDown(search(), { key: 'ArrowUp' })
    expect(useExposeStore.getState().focusVisible).toBe(true)
    expect(useExposeStore.getState().focusId).toBe('os-toolkit')
  })

  it('↵:进屏幕上**第一行**(过滤后的阅读次序,不是第二套命中排序)', () => {
    placeSessions()
    render(<ExposeView />)
    /*
     * 09-04 口径变化,如实记在这里:搜索**不再命中项目名**。卡片时代
     * `filterGroups` 有「词命中组名 → 整组保留」那一路,方向 A 把分组换成了
     * 按时间的分节,项目成了侧栏的筛选器 —— 于是「按项目找」是点侧栏那一项,
     * 不是往搜索框里打项目名。`sessionMatchesQuery` 只判标题 / 预览 / 摘要。
     */
    fireEvent.change(search(), { target: { value: '菜单栏' } })
    fireEvent.keyDown(search(), { key: 'Enter' })
    // W5-b:「进了哪条会话」看的是树(`currentSessionId` 成了投影,写者是
    // `content/session-projection.ts` —— 这组用例不接那条订阅)。
    expect(openSessionIds()).toContain('tr-menubar')
  })

  it('←→ 不接:焦点留在输入框里给光标用,状态机一格不动', () => {
    placeSessions()
    render(<ExposeView />)
    const before = useExposeStore.getState()
    for (const key of ['ArrowLeft', 'ArrowRight']) {
      // fireEvent 返回 false 表示被 preventDefault 了 —— 这两个键必须没有。
      expect(fireEvent.keyDown(search(), { key })).toBe(true)
    }
    expect(document.activeElement).toBe(search())
    expect(useExposeStore.getState().focusVisible).toBe(before.focusVisible)
    expect(useExposeStore.getState().focusId).toBe(before.focusId)
  })

  it('摆出来的那一刻焦点落进搜索条;没摆出来就不抢', () => {
    render(<ExposeView />)
    expect(document.activeElement).not.toBe(search())
    // 换一份摆出来的
    act(() => placeSessions())
    expect(document.activeElement).toBe(search())
  })
})

/**
 * 新会话的进行中反馈 —— 卡片时代长在组头那颗 `+` 上,搬到工具栏之后语义一个字不变:
 * 逐格 `aria-busy`、二次闸、**不用 disabled**。
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
      onSessionEvent: () => () => undefined,
      onSessionLifecycle: () => () => undefined,
    })
    return { land: release, done: sessionMutation.run({ kind: 'create', projectId: null }) }
  }

  const plus = () => screen.getByTestId('expose-new-session')

  it('在飞时那颗钮上 aria-busy —— 逐格,不是整面禁灰', async () => {
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
      // 落地之后那颗钮照常工作 —— 闸是「在飞时」而不是「按过一次就废」。
      fireEvent.click(plus())
      expect(calls).toEqual([null])
    } finally {
      useExposeStore.setState({ newSession: before })
    }
  })

  it('**不用 disabled**:在飞时那颗钮仍在焦点序里', async () => {
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
