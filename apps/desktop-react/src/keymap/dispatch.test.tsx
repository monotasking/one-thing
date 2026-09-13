import { beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { AppShell } from '../components/AppShell'
import { useAgentMenu } from '../components/agent-menu'
import { useExposeStore } from '../expose/store'
import { useStageStore } from '../stage/store'
import { initialStageState } from '../stage/transitions'
import { focusTree } from '../focus/registry'
import { useKeymapStore } from './store'
import { findCommand, initialKeymapState } from './transitions'
import { pinMacUserAgent } from '../test/mac-ua'

/**
 * 派发器只钉两件事:一次按键确实经**注册表**落到命令上,以及改绑之后
 * 老组合当场失效、新组合当场生效 —— 后者是「⌘P 不再是代码里一条硬监听」的证明。
 * 组合本身的算术在 transitions 的纯函数里测,这里不重复。
 */
beforeEach(() => {
  pinMacUserAgent()
  useStageStore.setState({ ...initialStageState, locale: 'zh' })
  useKeymapStore.setState({ ...initialKeymapState })
  useAgentMenu.setState({ open: false })
  // 响应链是模块级单例(同 store):一份用例留下的作用域不该被下一份看见。
  focusTree.reset()
})

describe('快捷键派发', () => {
  /* **K2 起检索面的出厂键是 ⌘⇧F**(⌘P 让给网页打印,09-12 裁定 3)。 */
  it('⌘⇧F 经注册表开检索面板,再按一下收回 Dock', () => {
    render(<AppShell />)
    act(() => void fireEvent.keyDown(document.body, { key: 'f', metaKey: true, shiftKey: true }))
    // 打开统一是浮窗(08-30 拍板:档定形态)
    expect(useStageStore.getState().placements.search).toEqual({ kind: 'float' })

    act(() => void fireEvent.keyDown(document.body, { key: 'f', metaKey: true, shiftKey: true }))
    expect(useStageStore.getState().placements.search).toBeUndefined()
  })

  /*
   * **⌘P 从此不再是这台壳的键**(09-12 裁定 3):出厂表里没人占它,所以这一下
   * 什么都不发生 —— 在内嵌浏览器里它于是自然回到页面自己手里(打印)。
   */
  it('⌘P 出厂不绑:按下去检索面**不开**', () => {
    render(<AppShell />)
    act(() => void fireEvent.keyDown(document.body, { key: 'p', metaKey: true }))
    expect(useStageStore.getState().placements.search).toBeUndefined()
  })

  /*
   * ── **⌘N 不再是全局键,而是一条响应者命令**(K2,09-12 裁定 1)──────────────
   * 从前它是 `session.new`,有一层**应用兜底** —— 于是「焦点在浏览器里按 ⌘N 开出
   * 一条会话」,正是这次报障。K2 起它是 `content.new`(`app: false`):新建哪一种
   * 由焦点说了算,活动路径上没人答就放行。
   *
   * 这一条量两件事,而第二件才是那次报障的治法:
   *  ① **有响应者时它照旧开一条会话**:AppShell 里第一响应者是输入面板
   *     (§3.5 规则 1),而 composer 答 `content.new`(判词在 `Composer` 的
   *     `composerCommands` 上)—— 所以这一下仍然落在同一只 action 上,落在哪个
   *     项目下由那条 action 自己判;
   *  ② **表上它没有应用层兜底**(`app: false`)。没有这一格,「焦点在浏览器里
   *     按 ⌘N」会一路退到应用层再开一条会话 —— 那正是报障。
   * 「浏览器 / 终端叶里它开的是那一种」由 `gate:workspace` ⑬g 与叶那边的
   * `leaf-commands` 用例量。
   */
  it('⌘N 落在**响应者**上(输入面板答它),而且表上没有应用层兜底(K2)', () => {
    render(<AppShell />)
    const calls: (string | null)[] = []
    const before = useExposeStore.getState().newSessionInCurrentProject
    useExposeStore.setState({
      newSessionInCurrentProject: async () => void calls.push(null),
    })
    try {
      act(() => void fireEvent.keyDown(document.body, { key: 'n', metaKey: true }))
      expect(calls).toEqual([null])
    } finally {
      useExposeStore.setState({ newSessionInCurrentProject: before })
    }
    expect(findCommand('content.new')?.app).toBe(false)
    expect(findCommand('session.new' as never)).toBeUndefined()
  })

  it('⌘J 开顶栏 agent 切换器的菜单,再按一下关 —— 只开菜单,不替人换人', () => {
    render(<AppShell />)
    act(() => void fireEvent.keyDown(document.body, { key: 'j', metaKey: true }))
    expect(useAgentMenu.getState().open).toBe(true)
    expect(screen.getByRole('menu')).toBeTruthy()

    act(() => void fireEvent.keyDown(document.body, { key: 'j', metaKey: true }))
    expect(useAgentMenu.getState().open).toBe(false)
  })

  it('改绑之后老组合失效、新组合生效(派发器一行没改)', () => {
    render(<AppShell />)
    act(() => void useKeymapStore.getState().bind('toggle:search', { meta: true, key: 'k' }))

    act(() => void fireEvent.keyDown(document.body, { key: 'p', metaKey: true }))
    expect(useStageStore.getState().placements.search).toBeUndefined()

    act(() => void fireEvent.keyDown(document.body, { key: 'k', metaKey: true }))
    expect(useStageStore.getState().placements.search).toEqual({ kind: 'float' })
  })
})

describe('规则 1 / 2:焦点跟着「打开」走(09-03 R2)', () => {
  /** 第一响应者此刻是哪一格声明。 */
  const firstResponder = () => focusTree.current()?.scope ?? null

  it('壳一挂起来,第一响应者就是输入面板(规则 1 的第一格)', () => {
    render(<AppShell />)
    // 反证:把 AppShell 里那条三级回落的 effect 删掉 → 这里是 null(键盘无主)。
    expect(firstResponder()).toBe('composer')
  })

  /*
   * 量这一句要挑一块**自己不抢焦点**的面。检索面不行:它自己声明了
   * `activateOnMount`(⌘P 敲出来就打字是它的产品语义),所以就算把规则 2 那一句
   * 删掉它照样入焦 —— 用它当判据等于量了个寂寞(第一版就栽在这儿,反证不红)。
   * 改动面(`diff`)没有那一格,所以它能分辨「是谁把焦点送进去的」。
   *
   * **W6-a 换了主角**:从前这里用的是文件树(`toggle:files`)。「目录」那块瓦
   * 改成**启动瓦**之后,那条命令开出来的不是一块面而是一格内容
   * (`dir:<路径>`,住在拼贴树里),形态机那张 `placements` 表上根本没有
   * 它的名字 —— 判据因此换到另一块同样「自己不抢焦点」的普通瓦上。
   * 被测的那句话一个字没改:**键盘开一块面 → 焦点进那块面**。
   */
  it('**用键盘**从 Dock 开一块面 → 焦点进那块面(规则 2)', () => {
    render(<AppShell />)
    act(() => useKeymapStore.setState({ overrides: { 'toggle:diff': [{ meta: true, key: 'k' }] } }))
    act(() => void fireEvent.keyDown(document.body, { key: 'k', metaKey: true }))
    expect(useStageStore.getState().placements.diff).toBeTruthy()
    /*
     * 反证:把 `requestFocusOnOpen(item)` 那一句删掉 → 焦点留在 composer 上,
     * 「⌘K 敲出来键盘就在那块面里」当场不成立。
     *
     * 断言落在 `files` **那一格**上(09-04 改判):从前这里断言的是层
     * (`float-layer`),理由写成「夹具没配文件端口,层里没有可交互的孩子」——
     * 那个理由是错的。真因是 `entryOf` 判「层自己声明了落点吗」看的是**闭包在不在**,
     * 而 `FocusScope` 给每一格都无条件登记一个,于是设计 §4.1 那条「进层 = 进它
     * 装着的那块面」对所有真组件都走不到。改判返回值之后焦点落到了它该落的地方。
     */
    /*
     * **W4 改判:落点是那块面所在的那片叶,不是内容自己那一格。**
     *
     * 浮窗与架子的身子从 W4 起是一棵拼贴树,于是宿主层与内容之间多了两格
     * `leaf`(叶根 + 那一格 tab 的层;设计 §2.4:「每片叶是响应链上的一格
     * `region`,叶 id 就是 scope 的 owner」)。而 `entryOf` 只穿 `layer` 那一种,
     * 走到第一格 `region` 就停 —— 中央区从 W1-a 起就是这个样子,W4 只是让
     * 架子与浮窗与它一致。
     *
     * 所以这一条的断言改成问**契约本身**而不是问 scope 的名字:
     *  · `isOwnerActive('files')` —— 这正是召唤三态用来判「焦点在不在它里面」
     *    的那一句(`summon.summonTransition` 的第四格读它);
     *  · 焦点真的落在装着这块面的那一格 tab 层里(DOM 事实)。
     * 反证不变:把 `requestFocusOnOpen(item)` 删掉 → 焦点留在 composer 上,两句都红。
     */
    expect(focusTree.isOwnerActive('diff')).toBe(true)
    expect(
      document.querySelector('[data-pane-tab="panel:diff"]')?.contains(document.activeElement),
    ).toBe(true)
  })

  /*
   * 09-04 S2 补的第二格:一块**自己没有 region** 的面(工作区总览 —— 它在
   * `focus/scopes.ts` 里没有自己那一行,内容里也没有 `<FocusScope>`)。
   * 上面那条用文件树量的是「层 → 它装着的那块面」那条路(`entryOf` 往里走一层),
   * 这一条量的是它的**另一支**:层里一个可交互的子作用域都没有,焦点就停在层根上。
   * 两支都得有人钉着 —— 用户 09-04 报的正是这一形(`workspace` / `apps` /
   * `notifications` / `providers` / `diff` / `terminal` / `browser` 七块面都在这一支上)。
   */
  it('**用键盘**开一块自己没有 region 的面 → 焦点落在装着它的那一层上(不是留在输入框里)', () => {
    render(<AppShell />)
    act(() => useKeymapStore.setState({ overrides: { 'toggle:workspace': [{ meta: true, key: 'k' }] } }))
    act(() => void fireEvent.keyDown(document.body, { key: 'k', metaKey: true }))
    expect(useStageStore.getState().placements.workspace).toBeTruthy()
    /*
     * 反证:把 `requestFocusOnOpen` 那一句删掉(或把 `focus-follow` 那条 effect
     * 改回「在 store 的 set 里当场 activate」)→ 焦点留在 composer 上,这两句红。
     * 这正是用户报的那一句:「触发一块面,焦点为什么还在 inputbox」。
     */
    // 判据同上一条(W4):问契约(`isOwnerActive`)与 DOM 事实,不问 scope 的名字。
    expect(focusTree.isOwnerActive('workspace')).toBe(true)
    expect(
      document.querySelector('[data-pane-tab="panel:workspace"]')?.contains(document.activeElement),
    ).toBe(true)
  })

  it('同一个键**焦点已经在它里面**时把它收起来,焦点由结构归还自己回去(S1b 第四格)', () => {
    render(<AppShell />)
    act(() => void fireEvent.keyDown(document.body, { key: 'f', metaKey: true, shiftKey: true }))
    // 检索面自己声明了 activateOnMount,所以第一下之后键盘已经在它里面。
    expect(firstResponder()).toBe('search')

    act(() => void fireEvent.keyDown(document.body, { key: 'f', metaKey: true, shiftKey: true }))
    /*
     * 用户 09-04 改判的第四格是**隐藏**(推翻 09-03 的「回去」;VS Code 终端 ⌃`
     * 那一族)。反证:把 store 那条 `case 'hide'` 改回 09-03 的 `returnFrom` →
     * 第一句红(面还在)。
     */
    expect(useStageStore.getState().placements.search).toBeUndefined()
    /*
     * **这一句量的是「焦点没人手动搬」**:形态当场就变了,而那扇窗还挂着一帧走
     * 出场动画(`FloatWindow` 的 `held`),所以此刻第一响应者**仍然**是检索面 ——
     * 归还要等那一层真的卸载。换句话说 `summonItem` 一个 `.focus()` 都没发,
     * 焦点回哪儿从头到尾是树的事(§4.5 的结构归还)。
     * 真机上「收完之后焦点回到按键之前那个输入框」由 `gate:focus` 场景 14 步④量,
     * 那是这条链唯一量得准的地方(jsdom 没有那一帧)。
     * 反证:在 `case 'hide'` 里补一句手动 `activateScope('composer')` → 这里红。
     */
    expect(firstResponder()).toBe('search')
  })
})

describe('设置页里的录制', () => {
  /**
   * 设置面在舞台上,快捷键区就在里面 —— 走真路径,不单独挂一个测试用的壳。
   *
   * 2026-09-13 分页之后设置页开出来停在**通用**页,所以这里多点一下导航 ——
   * 点的是壳真正画出来的那颗钮(`settings-nav-keymap`),不是直接写 store:
   * 「走真路径」那句话包括导航。
   */
  function openSettings() {
    render(<AppShell />)
    act(() => useStageStore.getState().openAs('settings', { kind: 'stage' }))
    act(() => void fireEvent.click(screen.getByTestId('settings-nav-keymap')))
  }

  it('录制态吃掉这一下按键:录 ⌘⇧F 的时候检索面板不会真的弹出来,而是报冲突', () => {
    openSettings()
    const slot = screen.getByLabelText('为「目录」添加一个快捷键')
    fireEvent.click(slot)
    act(() => void fireEvent.keyDown(slot, { key: 'f', metaKey: true, shiftKey: true }))

    // 撞了检索那条,所以既没绑上,也没有人替它开面板。
    expect(useKeymapStore.getState().overrides['toggle:files']).toBeUndefined()
    expect(useStageStore.getState().placements.search).toBeUndefined()
    /*
      * K0:撞车那一句要**说清是哪一条规则**(这里是「一个键上只能有一条全局
      * 命令」)。两条命令都是 `app: true`,所以规则是 `app`。
      */
     expect(screen.getByText(/与「检索」冲突/)).toBeTruthy()
     expect(screen.getByText(/同一个键上只能有一条全局命令/)).toBeTruthy()
  })

  it('按一个没人占的组合就绑上,行上随即出现「恢复默认」', () => {
    openSettings()
    const slot = screen.getByLabelText('为「目录」添加一个快捷键')
    fireEvent.click(slot)
    // ⌘⌃P:K2 之后 ⌘P 空出来了,但它**不是**「没人占」的好例子(它空着是有意的),
    // 所以这里挑一个出厂表里从头到尾没人碰过的组合。
    act(() => void fireEvent.keyDown(slot, { key: 'y', metaKey: true, altKey: true }))

    // K0:覆盖的值是**一串**组合;K5 起录一次是**追加**(这一条本来没绑键,所以只有一枚)。
    expect(useKeymapStore.getState().overrides['toggle:files']).toEqual([
      { key: 'y', meta: true, alt: true },
    ])
    expect(screen.getByLabelText('恢复「目录」的默认组合')).toBeTruthy()
  })
})
