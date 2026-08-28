import { beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { AppShell } from '../components/AppShell'
import { useStageStore } from '../stage/store'
import { initialStageState } from '../stage/transitions'
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
})

describe('快捷键派发', () => {
  it('⌘P 经注册表开检索面板,再按一下收回 Dock', () => {
    render(<AppShell />)
    act(() => void fireEvent.keyDown(document.body, { key: 'p', metaKey: true }))
    expect(useStageStore.getState().placements.search).toEqual({ kind: 'stage' })

    act(() => void fireEvent.keyDown(document.body, { key: 'p', metaKey: true }))
    expect(useStageStore.getState().placements.search).toBeUndefined()
  })

  it('改绑之后老组合失效、新组合生效(派发器一行没改)', () => {
    render(<AppShell />)
    act(() => void useKeymapStore.getState().bind('toggle:search', { meta: true, key: 'k' }))

    act(() => void fireEvent.keyDown(document.body, { key: 'p', metaKey: true }))
    expect(useStageStore.getState().placements.search).toBeUndefined()

    act(() => void fireEvent.keyDown(document.body, { key: 'k', metaKey: true }))
    expect(useStageStore.getState().placements.search).toEqual({ kind: 'stage' })
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
