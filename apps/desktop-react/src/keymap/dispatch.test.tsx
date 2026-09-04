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
   * 文件树没有那一格,所以它能分辨「是谁把焦点送进去的」。
   */
  it('**用键盘**从 Dock 开一块面 → 焦点进那块面(规则 2)', () => {
    render(<AppShell />)
    act(() => useKeymapStore.setState({ overrides: { 'toggle:files': { meta: true, key: 'k' } } }))
    act(() => void fireEvent.keyDown(document.body, { key: 'k', metaKey: true }))
    expect(useStageStore.getState().placements.files).toBeTruthy()
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
    expect(firstResponder()).toBe('files')
    // 那一格确实住在**装着这块面的那一扇**里(owner 记在层上,不在内容面上)。
    const layerOf = (id: string | undefined) =>
      id ? focusTree.nodes().get(focusTree.nodes().get(id)?.parent ?? '') : undefined
    expect(layerOf(focusTree.current()?.instanceId)?.owner).toBe('files')
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
    const slot = screen.getByLabelText('为「文件」设置快捷键')
    fireEvent.click(slot)
    act(() => void fireEvent.keyDown(slot, { key: 'p', metaKey: true }))

    // 撞了检索那条,所以既没绑上,也没有人替它开面板。
    expect(useKeymapStore.getState().overrides['toggle:files']).toBeUndefined()
    expect(useStageStore.getState().placements.search).toBeUndefined()
    expect(screen.getByText('与「检索」冲突')).toBeTruthy()
  })

  it('按一个没人占的组合就绑上,行上随即出现「恢复默认」', () => {
    openSettings()
    const slot = screen.getByLabelText('为「文件」设置快捷键')
    fireEvent.click(slot)
    act(() => void fireEvent.keyDown(slot, { key: 'f', metaKey: true, shiftKey: true }))

    expect(useKeymapStore.getState().overrides['toggle:files']).toEqual({
      key: 'f',
      meta: true,
      shift: true,
    })
    expect(screen.getByLabelText('恢复「文件」的默认组合')).toBeTruthy()
  })
})
