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

  it('**开出来那一下不会顺手把它收掉**(第一格是开,不是开关)', () => {
    const run = runner()
    act(() => run.current(toggleCommandId('files')))
    /*
     * 这份夹具里没有响应链的树(纯 store 层),所以 `isOwnerActive` 恒答 false ——
     * 于是第二下走的是第三格「只聚焦」,形态一格不动。第四格(焦点真在面里 →
     * 隐藏)由下面那条带树的用例量。
     * 反证:把 `summonItem` 的第一格改回纯开关(在 Dock 里就开、在别处就
     * `closeToDock`)→ 第二下把它收回 Dock,这里红。
     */
    const opened = placementOf(useStageStore.getState(), 'files')
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

  it('**钉在架子上、焦点在它里面 → 收起整条架子**,隔壁 tab 不许被顶上来(09-04 裁定)', () => {
    /*
     * 用户否决的那一版是 `closeToDock`:关掉 sessions 之后架子会把 projects 顶成
     * 活动 tab,焦点跟着掉到隔壁面上。这一条把那个后果直接写成断言。
     */
    const shell = document.createElement('div')
    shell.tabIndex = -1
    document.body.append(shell)
    const root = focusTree.register('root', null)
    root.setRoot(shell)
    const layerEl = document.createElement('div')
    layerEl.tabIndex = -1
    shell.append(layerEl)
    focusTree.register('shelf-layer', root.instanceId, { owner: 'sessions' }).setRoot(layerEl)

    useStageStore.setState({
      placements: {
        sessions: { kind: 'edge', side: 'right' },
        projects: { kind: 'edge', side: 'right' },
      },
      shelves: {
        ...initialStageState.shelves,
        right: {
          tabs: ['sessions', 'projects'],
          activeId: 'sessions',
          thickness: 400,
          collapsed: false,
        },
      },
    })
    const before = useStageStore.getState().placements
    layerEl.focus()
    expect(focusTree.isOwnerActive('sessions')).toBe(true)

    const run = runner()
    act(() => run.current(toggleCommandId('sessions')))

    const after = useStageStore.getState()
    expect(after.shelves.right.collapsed).toBe(true)
    // 这块面仍是那条架子的活动 tab —— 再召唤一下就展开回原样(与 shelf-expand 成一对)。
    expect(after.shelves.right.activeId).toBe('sessions')
    // 反证:把 `case 'hide'` 的钉边支删掉(一律 closeToDock)→ 下面两句红:
    // sessions 从账上消失,activeId 被顶成 projects。
    expect(after.placements).toEqual(before)
    expect(after.shelves.right.tabs).toEqual(['sessions', 'projects'])
  })

  it('看得见、焦点在它里面 → **把它收回 Dock**(09-04 改判),焦点由结构归还自己回去', () => {
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
    // 层里那块面 —— `entryOf` 会走进它,所以焦点落在这儿而不是层根上。
    const paneEl = document.createElement('div')
    paneEl.tabIndex = -1
    layerEl.append(paneEl)
    focusTree.register('viewer', layer.instanceId).setRoot(paneEl)

    useStageStore.setState({ placements: { files: { kind: 'float' } }, floatOrder: ['files'] })
    const before = useStageStore.getState().placements

    composer.focus()
    layer.activate('open')
    expect(focusTree.isOwnerActive('files')).toBe(true)

    const run = runner()
    act(() => run.current(toggleCommandId('files')))
    /*
     * 面收回 Dock:`placements` 里少了这一条(别的一条不动)。
     * 反证:把 store 那条 `case 'hide'` 改回 09-03 的 `returnFrom` → 这里红,
     * 因为那一版面留在原位。
     */
    expect('files' in useStageStore.getState().placements).toBe(false)
    expect(before).toEqual({ files: { kind: 'float' } })
    /*
     * **焦点没人手动搬**:这份夹具里那一扇层是手写登记的,不会随 placements 卸载,
     * 所以这里量的是「store 那条分支自己一个 `.focus()` 都不发」——
     * 真机上「面一收焦点回到按键之前的地方」由 gate:focus 场景 14 步④ 量。
     */
    expect(document.activeElement).toBe(paneEl)
  })
})
