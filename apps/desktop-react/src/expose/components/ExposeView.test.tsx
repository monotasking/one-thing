import { StrictMode } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { AppShell } from '../../components/AppShell'
import { SESSIONS_ITEM_ID } from '../../stage/items'
import { useStageStore } from '../../stage/store'
import { focusTree } from '../../focus/registry'
import { initialStageState } from '../../stage/transitions'
import { useKeymapStore } from '../../keymap/store'
import { initialKeymapState } from '../../keymap/transitions'
import { useSessionsSource } from '../../data/sessions-source'
import { FACTS, SESSIONS, seedSessionsSource } from '../../data/__fixtures__/sessions'
import { useExposeStore } from '../store'
import { findSession } from '../projection'
import { initialExposeState, sessionRowIdsOf } from '../transitions'

/**
 * 会话总览去接管化(08-29 拍板)之后要钉住的四件事:
 * 它按 Placement 开(不再是盖满一屏的覆盖层)、两个入口是同一条路、
 * 开场永远从总览起步,以及 **Esc 的让位契约**:
 * 内层(quicklook)先消费,消费不了才轮到宿主关这块面。
 */
beforeEach(() => {
  // 打开档默认即浮窗(08-30 拍板:点开统一浮窗;舞台=浮窗的放大目标)
  useStageStore.setState({ ...initialStageState, locale: 'zh' })
  // 数据先在场,再挂壳 —— 会话侧从此吃真数据源(D1),没有 mock 兜底。
  seedSessionsSource()
  useExposeStore.setState({ ...initialExposeState, currentSessionId: CURRENT_ID })
  useKeymapStore.setState({ ...initialKeymapState })
})

const placementOfSessions = () => useStageStore.getState().placements[SESSIONS_ITEM_ID]
const esc = () => act(() => void fireEvent.keyDown(document.body, { key: 'Escape' }))
const cmdE = () => act(() => void fireEvent.keyDown(document.body, { key: 'e', metaKey: true }))

/**
 * 屏幕上第一条**不是当前会话**的行 —— 「进入」要能真的换一个。
 * 09-04:序列的产地从 `visibleCardIds(groups)` 换成 `rowIdsOf(facts)`
 * (置顶那条排在最前,所以它未必还是「第二张」)。
 */
const CURRENT_ID = SESSIONS[0].id
/*
 * 09-04:序列的产地再挪一格 —— `rowIdsOf` 现在**含节头**(分节可折叠了),
 * 而这里要的是「第一条不是当前会话的**会话**」,所以问 `sessionRowIdsOf`。
 */
const other = SESSIONS.find(
  (s) => s.id === sessionRowIdsOf(initialExposeState, FACTS).find((id) => id !== CURRENT_ID),
)!

describe('会话总览是一块普通的面', () => {
  it('⌘E 按打开方式把它开出来 —— 打开统一是浮窗(08-30 拍板),内容住在面里', () => {
    render(<AppShell />)
    cmdE()
    expect(placementOfSessions()).toEqual({ kind: 'float' })
    expect(screen.getByLabelText('搜索会话')).toBeTruthy()
  })

  /*
   * ── W1-b:顶栏那一格从「总览入口」变成了「中央区的标签」──────────────────
   *
   * 08-29 去接管化拍板让顶栏的会话名钮 = 点 Dock 上那块「会话总览」瓦。W1-b 按
   * 设计 §2.2 的 D 稿把中央区的檐整条搬进顶栏,那颗钮的位子换成了**会话叶的标签**
   * ——「只有一片会话叶时,顶栏画的就是那一个标签 = 今天的会话标题」。
   *
   * 于是那条路**没了**:标签是标签,点它只能是「切到这一格」;一个点下去开出另一
   * 块面的 tab 是在说谎。总览今天的入口是 Dock 那块瓦与 ⌘E。
   *
   * **这是一处可感知的行为变化,交卷时点名给用户**(要不要补回来、补成动作组里的
   * 一颗还是会话标签右键菜单的一行,是用户的拍点)。这一条从「点它会开总览」翻成
   * 「点它不开总览」,是为了让那次翻面**有人看着** —— 哪天有人顺手把入口接回标签
   * 的 onSelect 上,这里会红。
   */
  it('顶栏那一格是中央区的标签,不是总览入口(W1-b 可感知变化)', () => {
    render(<AppShell />)
    const current = findSession(
      useSessionsSource.getState().sessions,
      useExposeStore.getState().currentSessionId,
    )!
    // 会话标题活在顶栏那条标签上(内容自己发布进 live-title,活的盖静的)。
    const tab = screen.getByRole('tab', { name: new RegExp(current.title) })
    expect(screen.getByTestId('topbar').contains(tab)).toBe(true)
    fireEvent.click(tab)
    // 总览一格没动:它没被摆出来过,点标签也不会把它摆出来。
    expect(placementOfSessions()).toBeUndefined()
  })

  it('开场归位:上次停在 Quick Look,再开还是从总览起步', () => {
    render(<AppShell />)
    cmdE()
    act(() => useExposeStore.getState().openQuickLook(other.id))
    cmdE()
    cmdE()
    expect(useExposeStore.getState().view).toEqual({ mode: 'overview' })
  })

  /*
   * 09-04:↵ 不再直接 `enterSession` —— 活动项可能是一个节头,那时它是「收 / 展」。
   * 这一条走的是**整块面**(键盘挂在作用域根上),所以它证的是路由那一段:
   * ExposeView → store.activateRow → transitions.activateRow 的两档分岔。
   */
  it('↵ 落在节头上收 / 展这一节,当前会话一格不动;落在行上才进会话', () => {
    render(<AppShell />)
    cmdE()
    // 这一组没钉「此刻」(夹具的 NOW 是过去的某天),所以节名不定 ——
    // 拿屏幕上第一个节头,它是谁不重要,重要的是 ↵ 落在**节头**上是哪一档。
    const firstHead = document.querySelector('[data-section-id]')!
    const sectionId = firstHead.getAttribute('data-section-id')!
    act(() => useExposeStore.setState({ focusId: `section:${sectionId}`, focusVisible: true }))
    fireEvent.keyDown(screen.getByTestId('expose-tree'), { key: 'Enter' })
    expect(firstHead.getAttribute('aria-expanded')).toBe('false')
    expect(useExposeStore.getState().currentSessionId).toBe(CURRENT_ID)
    // 面板一动不动(进会话才会把它收回 Dock)。
    expect(placementOfSessions()).toEqual({ kind: 'float' })

    // 再一下把它展回去(同一口两态),行才重新在屏上。
    fireEvent.keyDown(screen.getByTestId('expose-tree'), { key: 'Enter' })
    expect(firstHead.getAttribute('aria-expanded')).toBe('true')

    act(() => useExposeStore.setState({ focusId: other.id, focusVisible: true }))
    fireEvent.keyDown(screen.getByTestId('expose-tree'), { key: 'Enter' })
    expect(useExposeStore.getState().currentSessionId).toBe(other.id)
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

  /*
   * ── 「组列表同理」那一条 09-04 随 list 视图一起退役 ────────────────────────
   * 方向 A 把总览与组列表合并成同一张树(设计 §1),`view.mode === 'list'` 与
   * `enterList` 一并删除 —— 没有那一层,也就没有「从那一层退回总览」这件事。
   * Esc 的**让位契约**本身一个字没变,由上下两条(Quick Look 退层 / 总览让位)
   * 与下面的相位组守着。
   */

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
  /**
   * ── R2:方向键挂在**作用域根**上,「谁算数」由树答 ────────────────────────
   * 从前这一组派的是 window 上的一下 ArrowDown,由 ExposeView 那条捕获监听的
   * `live` 门决定接不接。R2 之后方向键是这块面的**行内结构键**(挂在作用域根上),
   * 而「后台那一份不吃键」不再需要一道自制的门:架子把后台层打了 `inert`,
   * ①浏览器据此把整层移出焦点序与命中测试,②注册表据此不选它当第一响应者、
   * 路径经过它就截断(§4.7)。所以这一组改问那两件事本身。
   */
  const arrowDownOn = (root: Element) => {
    const event = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
    act(() => {
      root.dispatchEvent(event)
    })
    return event.defaultPrevented
  }

  const exposeRootIn = (layer: Element) =>
    layer.querySelector('[data-focus-scope="expose"]') as HTMLElement

  /*
   * W4:一格 tab 的那一层从架子自己那份 `ShelfTabLayer` 换成了树的
   * `PaneLeaf` → `PaneTabLayer`(架子的身子现在是一棵拼贴树)。取件口因此换成
   * `data-pane-tab=<refId>`,树上那一格的 scope 也从 `shelf-layer` 变成 `leaf`
   * ——**这一条要守的两件事一个字没改**:后台那一份还挂着,而且 DOM 与树
   * 两遍 `inert` 同源。
   */
  const layerOf = (id: string) =>
    document.querySelector(`[data-pane-tab="panel:${id}"]`) as HTMLElement

  it('架子上被切到后台的那一份:还挂着(keep-alive),但整层 inert —— 键盘够不着', () => {
    render(<AppShell />)
    act(() => useStageStore.getState().openAs(SESSIONS_ITEM_ID, { kind: 'edge', side: 'right' }))
    const live = layerOf(SESSIONS_ITEM_ID)
    expect(live.hasAttribute('inert')).toBe(false)
    expect(arrowDownOn(exposeRootIn(live))).toBe(true)

    // 同一条架子上再钉一块,它成了活动 tab —— 总览那一层退到后台。
    act(() => useStageStore.getState().openAs('files', { kind: 'edge', side: 'right' }))
    expect(useStageStore.getState().shelves.right.activeId).toBe('files')
    const background = layerOf(SESSIONS_ITEM_ID)
    // ①还挂着(keep-alive);②整层 inert;③树里那一格也 inert —— 两遍必须同源,
    // 少了给树的那一遍,后台那一份照样能被算成第一响应者(R1 立的判例)。
    expect(background).toBeTruthy()
    expect(background.hasAttribute('inert')).toBe(true)
    const dumped = focusTree
      .dump()
      .nodes.filter((n) => n.scope === 'leaf' && n.owner === `panel:${SESSIONS_ITEM_ID}`)
    expect(dumped.some((n) => n.inert)).toBe(true)
    expect(focusTree.activePath()).not.toContain(
      focusTree.dump().nodes.find((n) => n.scope === 'expose' && dumped.some((d) => d.instanceId === n.parent))
        ?.instanceId,
    )

    // 切回来:同一份实例,键盘也一起回来。
    act(() => useStageStore.getState().activateShelfTab('right', SESSIONS_ITEM_ID))
    const back = layerOf(SESSIONS_ITEM_ID)
    expect(back.hasAttribute('inert')).toBe(false)
    expect(arrowDownOn(exposeRootIn(back))).toBe(true)
  })
})
