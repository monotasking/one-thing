import { beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { AppShell } from '../components/AppShell'
import { useAgentMenu } from '../components/agent-menu'
import { useExposeStore } from '../expose/store'
import { useStageStore } from '../stage/store'
import { initialStageState } from '../stage/transitions'
import { focusTree } from '../focus/registry'
import { useKeymapStore } from './store'
import { initialKeymapState } from './transitions'

/**
 * 派发器只钉两件事:一次按键确实经**注册表**落到命令上,以及改绑之后
 * 老组合当场失效、新组合当场生效 —— 后者是「⌘P 不再是代码里一条硬监听」的证明。
 * 组合本身的算术在 transitions 的纯函数里测,这里不重复。
 */
beforeEach(() => {
  useStageStore.setState({ ...initialStageState, locale: 'zh' })
  useKeymapStore.setState({ ...initialKeymapState })
  useAgentMenu.setState({ open: false })
  // 响应链是模块级单例(同 store):一份用例留下的作用域不该被下一份看见。
  focusTree.reset()
})

describe('快捷键派发', () => {
  it('⌘P 经注册表开检索面板,再按一下收回 Dock', () => {
    render(<AppShell />)
    act(() => void fireEvent.keyDown(document.body, { key: 'p', metaKey: true }))
    // 打开统一是浮窗(08-30 拍板:档定形态)
    expect(useStageStore.getState().placements.search).toEqual({ kind: 'float' })

    act(() => void fireEvent.keyDown(document.body, { key: 'p', metaKey: true }))
    expect(useStageStore.getState().placements.search).toBeUndefined()
  })

  it('⌘N 经注册表落到「新建会话」上 —— 派发器不判落在哪个项目,那是 action 的事', () => {
    render(<AppShell />)
    const calls: (string | null)[] = []
    const before = useExposeStore.getState().newSession
    useExposeStore.setState({
      newSession: async (projectId) => void calls.push(projectId),
    })
    try {
      act(() => void fireEvent.keyDown(document.body, { key: 'n', metaKey: true }))
      expect(calls).toEqual([null])
    } finally {
      useExposeStore.setState({ newSession: before })
    }
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
    act(() => useKeymapStore.setState({ overrides: { 'toggle:diff': { meta: true, key: 'k' } } }))
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
    act(() => useKeymapStore.setState({ overrides: { 'toggle:workspace': { meta: true, key: 'k' } } }))
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
    act(() => void fireEvent.keyDown(document.body, { key: 'p', metaKey: true }))
    // 检索面自己声明了 activateOnMount,所以第一下之后键盘已经在它里面。
    expect(firstResponder()).toBe('search')

    act(() => void fireEvent.keyDown(document.body, { key: 'p', metaKey: true }))
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
  /** 设置面在舞台上,快捷键区就在里面 —— 走真路径,不单独挂一个测试用的壳。 */
  function openSettings() {
    render(<AppShell />)
    act(() => useStageStore.getState().openAs('settings', { kind: 'stage' }))
  }

  it('录制态吃掉这一下按键:录 ⌘P 的时候检索面板不会真的弹出来,而是报冲突', () => {
    openSettings()
    const slot = screen.getByLabelText('为「目录」设置快捷键')
    fireEvent.click(slot)
    act(() => void fireEvent.keyDown(slot, { key: 'p', metaKey: true }))

    // 撞了检索那条,所以既没绑上,也没有人替它开面板。
    expect(useKeymapStore.getState().overrides['toggle:files']).toBeUndefined()
    expect(useStageStore.getState().placements.search).toBeUndefined()
    expect(screen.getByText('与「检索」冲突')).toBeTruthy()
  })

  it('按一个没人占的组合就绑上,行上随即出现「恢复默认」', () => {
    openSettings()
    const slot = screen.getByLabelText('为「目录」设置快捷键')
    fireEvent.click(slot)
    act(() => void fireEvent.keyDown(slot, { key: 'f', metaKey: true, shiftKey: true }))

    expect(useKeymapStore.getState().overrides['toggle:files']).toEqual({
      key: 'f',
      meta: true,
      shift: true,
    })
    expect(screen.getByLabelText('恢复「目录」的默认组合')).toBeTruthy()
  })
})
