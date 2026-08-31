import { StrictMode } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { AppShell } from '../../components/AppShell'
import { SESSIONS_ITEM_ID } from '../../stage/items'
import { useStageStore } from '../../stage/store'
import { initialStageState } from '../../stage/transitions'
import { useKeymapStore } from '../../keymap/store'
import { initialKeymapState } from '../../keymap/transitions'
import { useSessionsSource } from '../../data/sessions-source'
import { GROUPS, SESSIONS, seedSessionsSource } from '../../data/__fixtures__/sessions'
import { useExposeStore } from '../store'
import { findSession } from '../projection'
import { initialExposeState, visibleCardIds } from '../transitions'

/**
 * 会话总览去接管化(08-29 拍板)之后要钉住的四件事:
 * 它按 Placement 开(不再是盖满一屏的覆盖层)、两个入口是同一条路、
 * 开场永远从总览起步,以及 **Esc 的让位契约**:
 * 内层(quicklook / list)先消费,消费不了才轮到宿主关这块面。
 */
beforeEach(() => {
  // 打开档默认即浮窗(08-30 拍板:点开统一浮窗;舞台=浮窗的放大目标)
  useStageStore.setState({ ...initialStageState, locale: 'zh' })
  // 数据先在场,再挂壳 —— 会话侧从此吃真数据源(D1),没有 mock 兜底。
  seedSessionsSource()
  useExposeStore.setState({ ...initialExposeState, currentSessionId: SESSIONS[0].id })
  useKeymapStore.setState({ ...initialKeymapState })
})

const placementOfSessions = () => useStageStore.getState().placements[SESSIONS_ITEM_ID]
const esc = () => act(() => void fireEvent.keyDown(document.body, { key: 'Escape' }))
const cmdE = () => act(() => void fireEvent.keyDown(document.body, { key: 'e', metaKey: true }))

/** 展开组里第二张卡:既看得见,又不是当前会话 —— 「进入」要能真的换一个。 */
const other = SESSIONS.find((s) => s.id === visibleCardIds(initialExposeState, GROUPS)[1])!

describe('会话总览是一块普通的面', () => {
  it('⌘E 按打开方式把它开出来 —— 打开统一是浮窗(08-30 拍板),内容住在面里', () => {
    render(<AppShell />)
    cmdE()
    expect(placementOfSessions()).toEqual({ kind: 'float' })
    expect(screen.getByLabelText('搜索会话')).toBeTruthy()
  })

  it('顶栏标题与 Dock 那块瓦是同一条路:点它 = 按它的打开方式开', () => {
    render(<AppShell />)
    const current = findSession(
      useSessionsSource.getState().sessions,
      useExposeStore.getState().currentSessionId,
    )!
    fireEvent.click(screen.getByText(current.title))
    expect(placementOfSessions()).toEqual({ kind: 'float' })
  })

  it('开场归位:上次停在 Quick Look,再开还是从总览起步', () => {
    render(<AppShell />)
    cmdE()
    act(() => useExposeStore.getState().openQuickLook(other.id))
    cmdE()
    cmdE()
    expect(useExposeStore.getState().view).toEqual({ mode: 'overview' })
  })

  it('进入会话 = 换当前会话,并顺手把这块面收回 Dock', () => {
    render(<AppShell />)
    cmdE()
    fireEvent.click(screen.getByText(other.title))
    expect(useExposeStore.getState().currentSessionId).toBe(other.id)
    expect(SESSIONS_ITEM_ID in useStageStore.getState().placements).toBe(false)
  })
})

describe('Esc 的让位契约', () => {
  // 舞台不再是打开落点,但仍是浮窗的放大目标 —— 宿主(StageOverlay)的 Esc 契约照钉,
  // 入口从「按打开方式」改成显式放大(openAs stage)。
  const openOnStage = () => act(() => useStageStore.getState().openAs(SESSIONS_ITEM_ID, { kind: 'stage' }))

  it('内层先消费:Quick Look 上的 Esc 退回总览,面板一动不动', () => {
    render(<AppShell />)
    openOnStage()
    act(() => useExposeStore.getState().openQuickLook(other.id))
    esc()
    expect(useExposeStore.getState().view).toEqual({ mode: 'overview' })
    expect(placementOfSessions()).toEqual({ kind: 'stage' })
  })

  it('组列表同理:先退回总览,不是直接关面板', () => {
    render(<AppShell />)
    openOnStage()
    act(() => useExposeStore.getState().enterList(GROUPS[0].id))
    esc()
    expect(useExposeStore.getState().view).toEqual({ mode: 'overview' })
    expect(placementOfSessions()).toEqual({ kind: 'stage' })
  })

  it('内层消费不了才轮到宿主:总览上的 Esc 关掉这块面(宿主同步判定,不欠一拍)', () => {
    render(<AppShell />)
    openOnStage()
    esc()
    expect(SESSIONS_ITEM_ID in useStageStore.getState().placements).toBe(false)
  })

  /**
   * ── 让位靠相位,不靠注册序 ────────────────────────────────────────────────
   * 08-30 真机回归:QuickLook 开着按 Esc,整块面板被关。
   *
   * 病根有两层,两层都在这一条用例的射程里:
   *  ① 内容层与宿主都听 window 的**同一个相位**,于是谁先消费由 addEventListener
   *     的先后决定;React StrictMode 的开发期双挂载会把 ExposeView 的监听器卸了
   *     再挂,最终排到 StageOverlay 之后。
   *  ② 上一版修复让宿主 queueMicrotask 推迟判定,以为微任务落在整轮派发之后 ——
   *     真事件由原生派发,每个监听器回调返回时 JS 栈就空了,微任务检查点当场跑,
   *     于是宿主的判定落在内容层**之前**。jsdom 里的 fireEvent 是从 JS 派发的
   *     (整轮派发都在一层 JS 栈上),微任务只好等到最后 —— 所以那版修复的单测
   *     是绿的、真机是红的。这条教训的落点就是下面这个断言:**不测时序,测相位**。
   *
   * 测法:在渲染之前先挂一个冒泡相位的探针。它比任何组件都先注册,
   * 所以「同相位 + 注册序」的旧写法下它必然先跑、看到的是 defaultPrevented=false;
   * 只有内容层真的在**捕获相位**消费,它才看得见 true。
   */
  it('相位契约:先注册的冒泡监听器也能看见内层已消费(捕获相位在前)', () => {
    const seen: boolean[] = []
    const probe = (e: KeyboardEvent) => {
      if (e.key === 'Escape') seen.push(e.defaultPrevented)
    }
    window.addEventListener('keydown', probe)
    try {
      render(<AppShell />)
      openOnStage()
      const focusId = useExposeStore.getState().focusId!
      act(() => useExposeStore.getState().openQuickLook(focusId))
      esc()
      expect(seen.at(-1)).toBe(true)
      expect(useExposeStore.getState().view).toEqual({ mode: 'overview' })
      expect(placementOfSessions()).toEqual({ kind: 'stage' })
    } finally {
      window.removeEventListener('keydown', probe)
    }
  })

  it('注册序免疫:StrictMode 双挂载把内容层监听器排到最后,Esc 仍只退一层', () => {
    render(<StrictMode><AppShell /></StrictMode>)
    openOnStage()
    const focusId = useExposeStore.getState().focusId!
    act(() => useExposeStore.getState().openQuickLook(focusId))
    esc()
    expect(useExposeStore.getState().view).toEqual({ mode: 'overview' })
    expect(placementOfSessions()).toEqual({ kind: 'stage' })
  })

  /*
   * 08-31 **这条断言原来钉的是一个 bug**,不是一条规矩。
   *
   * 它当时写的是「浮窗形态上没有宿主关闭器:总览上的 Esc 什么都不关」——
   * 那句话如实描述了当时的实现(全仓只有 StageOverlay 挂 Esc,而它只在有舞台时
   * 才挂载),于是用户 08-31 报障「进了某种打开态但 Esc 按不动」。真机复现确认:
   * 浮窗按 Esc,placements 一个字节都不变。
   *
   * 教训记在这里:**一条如实描述当下行为的断言,不等于一条该守的规矩**。
   * 写「什么都不发生」这类断言时要多问一句「这是设计,还是我们还没做?」——
   * 前者该钉,后者钉下去就是把缺口焊死。
   *
   * 现在宿主是 components/useEscapeChain(链在 stage/transitions.escapeTargetOf),
   * 三种瞬态形都退得掉;下面这条改成钉**内层优先**:总览还有层可退时先退它,
   * 退到头了下一下才轮到收浮窗。
   */
  it('浮窗上的总览:Esc 先退总览自己的层,退到头了下一下才收浮窗', () => {
    render(<AppShell />)
    act(() => useStageStore.getState().openAs(SESSIONS_ITEM_ID, { kind: 'float' }))
    const focusId = useExposeStore.getState().focusId!
    act(() => useExposeStore.getState().openQuickLook(focusId))

    esc()
    // 内层消费了这一下:QuickLook 退回总览,浮窗一动不动。
    expect(useExposeStore.getState().view).toEqual({ mode: 'overview' })
    expect(placementOfSessions()).toEqual({ kind: 'float' })

    esc()
    // 内层没得退了,这一下才轮到宿主 —— 浮窗收回 Dock(修前它永远收不掉)。
    // 收回 Dock = **从 placements 里消失**(dock 是缺席态,不是一条 {kind:'dock'}),
    // 所以这里问的是 undefined 而不是某个值。
    expect(placementOfSessions()).toBeUndefined()
  })

  it('搜索词是 Esc 的第 0 层:先清词,面板与视图都不动(浮窗常态下)', () => {
    render(<AppShell />)
    cmdE()
    fireEvent.change(screen.getByLabelText('搜索会话'), { target: { value: 'provider' } })
    esc()
    expect(useExposeStore.getState().query).toBe('')
    expect(placementOfSessions()).toEqual({ kind: 'float' })
  })
})

/**
 * 「我这一份算不算数」—— 同一块内容可能同时挂着好几份(架子上 keep-alive 的一组 tab、
 * Dock 悬停预览泡),但**只有一份**该占用全局键盘。判据由宿主给(content/visibility.ts),
 * 不由内容自己猜。预览泡那一份在 dock-preview.test.tsx 里钉;这里钉架子上的后台那一份。
 */
describe('哪一份实例算数', () => {
  const arrowDown = () => {
    const event = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
    act(() => {
      window.dispatchEvent(event)
    })
    return event.defaultPrevented
  }

  it('架子上被切到后台的那一份:还挂着(keep-alive),但不吃方向键', () => {
    render(<AppShell />)
    act(() => useStageStore.getState().openAs(SESSIONS_ITEM_ID, { kind: 'edge', side: 'right' }))
    expect(arrowDown()).toBe(true)

    // 同一条架子上再钉一块,它成了活动 tab —— 总览那一层退到后台。
    act(() => useStageStore.getState().openAs('files', { kind: 'edge', side: 'right' }))
    expect(useStageStore.getState().shelves.right.activeId).toBe('files')
    expect(document.querySelector(`[data-panel-layer="${SESSIONS_ITEM_ID}"]`)).toBeTruthy()
    expect(arrowDown()).toBe(false)

    // 切回来:同一份实例,键盘也一起回来。
    act(() => useStageStore.getState().activateShelfTab('right', SESSIONS_ITEM_ID))
    expect(arrowDown()).toBe(true)
  })
})
