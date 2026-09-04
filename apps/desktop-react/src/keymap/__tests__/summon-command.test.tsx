import { renderHook } from '@testing-library/react'
import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { useKeymapCommandRunner } from '../dispatch'
import { toggleCommandId } from '../transitions'
import { focusTree } from '../../focus/registry'
import { useStageStore } from '../../stage/store'
import { initialStageState, placementOf } from '../../stage/transitions'

/**
 * **`toggle:<面>` 那条命令的落点**(S1,设计 §14)。
 *
 * 这一组钉的是 `keymap/dispatch.ts` 那条分支真的走到了**召唤**而不是旧的开关:
 * 判据全在纯函数里(`stage/__tests__/summon.test.ts` 逐态钉着),这里量的是
 * **接线** —— 同一条命令按两下不再把刚开出来的面关掉,以及第四态真的把键盘还回去。
 *
 * 命令 id 一个字没改(改了会作废用户已存的改绑),所以这里仍然用 `toggleCommandId`。
 */

afterEach(() => {
  focusTree.reset()
  focusTree.policy.moveFocus = true
  useStageStore.setState({ ...initialStageState })
  document.body.innerHTML = ''
})

/** 起一份 runner。它订阅着几个 store,所以要在组件里跑。 */
function runner() {
  return renderHook(() => useKeymapCommandRunner()).result
}

describe('toggle:<面> = 召唤,不是开关', () => {
  it('在 Dock 里 → 开出来', () => {
    const run = runner()
    act(() => run.current(toggleCommandId('files')))
    expect(placementOf(useStageStore.getState(), 'files').kind).not.toBe('dock')
  })

  it('**再按一下不关它**(与旧 toggleItem 唯一的语义分歧)', () => {
    const run = runner()
    act(() => run.current(toggleCommandId('files')))
    const opened = placementOf(useStageStore.getState(), 'files')
    /*
     * 反证:把这条分支改回 `toggleItem` → 第二下把它收回 Dock,这里当场红。
     * §14 的原话:「关面是 Esc 的活,不是聚焦键的」。
     */
    act(() => run.current(toggleCommandId('files')))
    expect(placementOf(useStageStore.getState(), 'files')).toEqual(opened)
  })

  it('架子上藏在后台 tab 里 → 露出来,而**位置一格不动**', () => {
    useStageStore.setState({
      placements: {
        files: { kind: 'edge', side: 'right' },
        sessions: { kind: 'edge', side: 'right' },
      },
      shelves: {
        ...initialStageState.shelves,
        right: { tabs: ['sessions', 'files'], activeId: 'sessions', thickness: 400, collapsed: false },
      },
    })
    const run = runner()
    act(() => run.current(toggleCommandId('files')))
    const after = useStageStore.getState()
    expect(after.shelves.right.activeId).toBe('files')
    // 位置不变:还钉在同一条边上,tab 次序一个字没动。
    expect(placementOf(after, 'files')).toEqual({ kind: 'edge', side: 'right' })
    expect(after.shelves.right.tabs).toEqual(['sessions', 'files'])
  })

  it('架子收成细梁 → 展开,tab 次序与活动 tab 都不动', () => {
    useStageStore.setState({
      placements: { files: { kind: 'edge', side: 'left' } },
      shelves: {
        ...initialStageState.shelves,
        left: { tabs: ['files'], activeId: 'files', thickness: 400, collapsed: true },
      },
    })
    const run = runner()
    act(() => run.current(toggleCommandId('files')))
    expect(useStageStore.getState().shelves.left.collapsed).toBe(false)
  })

  it('浮窗被压在下面 → 翻到最上面(placements 一个字节不变)', () => {
    useStageStore.setState({
      placements: { files: { kind: 'float' }, search: { kind: 'float' } },
      floatOrder: ['files', 'search'],
    })
    const before = useStageStore.getState().placements
    const run = runner()
    act(() => run.current(toggleCommandId('files')))
    const after = useStageStore.getState()
    expect(after.floatOrder).toEqual(['search', 'files'])
    expect(after.placements).toEqual(before)
  })

  it('看得见、焦点在它里面 → 把键盘还回去,而形态一格不动', () => {
    // 一棵最小的树:壳根 + 输入框 + 一扇替 files 摆着的浮窗层。
    const shell = document.createElement('div')
    shell.tabIndex = -1
    document.body.append(shell)
    const root = focusTree.register('root', null)
    root.setRoot(shell)

    const composer = document.createElement('button')
    shell.append(composer)
    focusTree.register('composer', root.instanceId).setRoot(composer)

    const layerEl = document.createElement('div')
    layerEl.tabIndex = -1
    shell.append(layerEl)
    const layer = focusTree.register('float-layer', root.instanceId, { owner: 'files' })
    layer.setRoot(layerEl)

    useStageStore.setState({ placements: { files: { kind: 'float' } }, floatOrder: ['files'] })
    const before = useStageStore.getState().placements

    composer.focus()
    layer.activate('open')
    expect(focusTree.isOwnerActive('files')).toBe(true)

    const run = runner()
    act(() => run.current(toggleCommandId('files')))
    expect(document.activeElement).toBe(composer)
    // 面留在原位 —— 召唤永远不改形态的第四态。
    expect(useStageStore.getState().placements).toEqual(before)
  })
})
