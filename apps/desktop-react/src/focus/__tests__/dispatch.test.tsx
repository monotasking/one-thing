import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import { useFocusDispatch } from '../dispatch'
import { focusTree } from '../registry'
import { useKeymapStore } from '../../keymap/store'
import { initialKeymapState } from '../../keymap/transitions'
import type { CommandId } from '../../keymap/types'

/**
 * **唯一那个 window keydown 的顺序**(设计 §4.3 / §4.4)。
 *
 * 一次按键的八步(独占 → I1 收回 → 瞬态 → Esc → Tab → 输入面单键 → 局部 → 全局)
 * 每一步各钉一条。**R1 起它就是壳上那一个**(`AppShell` 里 `useFocusDispatch`,
 * 旧的 `useKeymapDispatch` 与 `useEscapeChain` 都已退役)。
 *
 * R1 的过渡形是**两半相位**(捕获半 / 冒泡半,表在 `dispatch.ts` 文件头):
 * 浮层的 Esc 与模态的 Tab 在捕获半,面与全局命令在冒泡半 —— 那条分界就是今天
 * 的相位线,所以还没接树的那四家(ExposeView / composer / viewer / files)
 * 与浮层、全局的相对次序一格没变。这一组里凡是直接 `window.dispatchEvent` 的,
 * 两半都会跑到(事件派在 window 自己身上 = AT_TARGET,捕获与冒泡都算数)。
 *
 * 反证:把 `routeKey` 的循环改成从浅到深 → 「局部先接」那条红;把 Esc 那段的
 * `return` 去掉让它继续往下走 → 「没人答 true 时不 preventDefault」那条红。
 */

function Harness({ run }: { run: (id: CommandId) => void }) {
  useFocusDispatch({ runCommand: run })
  return null
}

let runCommand: ReturnType<typeof vi.fn>

beforeEach(() => {
  useKeymapStore.setState({ ...initialKeymapState })
  runCommand = vi.fn()
})

afterEach(() => {
  focusTree.reset()
  // R1 起缺省搬焦点;还原成产品里的那一档,别让下一份用例跑在一个不存在的档位上。
  focusTree.policy.moveFocus = true
  document.body.innerHTML = ''
})

/** 造一条 root → viewer 的活动路径,viewer 接了 `find`。 */
function viewerPath(handlers: Record<string, () => void>) {
  const shell = document.createElement('div')
  const pane = document.createElement('div')
  shell.append(pane)
  document.body.append(shell)
  const root = focusTree.register('root', null)
  root.setRoot(shell)
  const viewer = focusTree.register('viewer', root.instanceId, { keyHandlers: handlers })
  viewer.setRoot(pane)
  viewer.activate('open')
  return { root, viewer, shell, pane }
}

describe('① 独占口先于一切', () => {
  it('录制态申请独占后,连全局命令都吃掉', () => {
    render(<Harness run={runCommand} />)
    const eaten: string[] = []
    focusTree.capture((e) => {
      eaten.push(e.key)
      return true
    })
    fireEvent.keyDown(document.body, { key: 'p', metaKey: true })
    expect(eaten).toEqual(['p'])
    expect(runCommand).not.toHaveBeenCalled()
  })
})

describe('② 别人真消费掉了就让开', () => {
  it('defaultPrevented 的按键一律不再路由', () => {
    render(<Harness run={runCommand} />)
    const find = vi.fn()
    viewerPath({ find })
    const e = new KeyboardEvent('keydown', { key: 'f', metaKey: true, cancelable: true })
    e.preventDefault()
    window.dispatchEvent(e)
    expect(find).not.toHaveBeenCalled()
  })
})

describe('③ Esc 沿路径由深到浅退一层', () => {
  it('第一个答 true 的消费掉,浅的那一层不再被问', () => {
    render(<Harness run={runCommand} />)
    const order: string[] = []
    const root = focusTree.register('root', null, {
      onEscape: () => (order.push('root'), true),
    })
    const jump = focusTree.register('jumpbar', root.instanceId, {
      onEscape: () => (order.push('jump'), true),
    })
    jump.activate()
    const e = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    window.dispatchEvent(e)
    expect(order).toEqual(['jump'])
    expect(e.defaultPrevented).toBe(true)
  })

  it('深的那一层答 false → 让给浅的', () => {
    render(<Harness run={runCommand} />)
    const order: string[] = []
    const root = focusTree.register('root', null, {
      onEscape: () => (order.push('root'), true),
    })
    const composer = focusTree.register('composer', root.instanceId, {
      onEscape: () => (order.push('composer'), false),
    })
    composer.activate()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
    expect(order).toEqual(['composer', 'root'])
  })

  it('没人答 true → **不 preventDefault**(输入法组字等后面的消费者照旧)', () => {
    render(<Harness run={runCommand} />)
    focusTree.register('root', null).activate()
    const e = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    window.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
  })
})

describe('④ Tab 只在 modal 圈禁', () => {
  it('模态里 Tab 走到末项后回首项(焦点真的回去)', () => {
    render(<Harness run={runCommand} />)
    const panel = document.createElement('div')
    const a = document.createElement('button')
    a.id = 'a'
    const b = document.createElement('button')
    b.id = 'b'
    panel.append(a, b)
    document.body.append(panel)
    const root = focusTree.register('root', null)
    const dialog = focusTree.register('dialog', root.instanceId)
    dialog.setRoot(panel)
    dialog.activate()
    b.focus()

    const e = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true })
    window.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
    expect(document.activeElement?.id).toBe('a')
  })

  it('非模态的路径上 Tab 一个字都不管', () => {
    render(<Harness run={runCommand} />)
    viewerPath({})
    const e = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true })
    window.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
  })
})

describe('⑤ 输入面里的无修饰单键归输入框', () => {
  it('在 textarea 里打字不进路由;带修饰的组合照常派发', () => {
    render(<Harness run={runCommand} />)
    const box = document.createElement('textarea')
    document.body.append(box)
    focusTree.register('root', null).activate()

    fireEvent.keyDown(box, { key: 'p' })
    expect(runCommand).not.toHaveBeenCalled()

    fireEvent.keyDown(box, { key: 'p', metaKey: true })
    expect(runCommand).toHaveBeenCalledWith('toggle:search')
  })
})

describe('⑥⑦ 局部先接,没接住放行全局', () => {
  it('⌘F 落在活动路径上的查看器(**用户报的那条 bug 的正面**)', () => {
    render(<Harness run={runCommand} />)
    const find = vi.fn()
    viewerPath({ find })
    const e = new KeyboardEvent('keydown', { key: 'f', metaKey: true, cancelable: true })
    window.dispatchEvent(e)
    expect(find).toHaveBeenCalledTimes(1)
    expect(e.defaultPrevented).toBe(true)
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('**判据是「在不在活动路径上」,不是「事件经不经过它的根」**', () => {
    // 这一下按键派在 body 上,一次都没经过查看器的根元素 —— 旧机制(监听挂在
    // 面域根上、靠冒泡先收到)在这里必哑,而树只问「它在不在活动路径上」。
    render(<Harness run={runCommand} />)
    const find = vi.fn()
    const { pane } = viewerPath({ find })
    expect(pane.contains(document.body)).toBe(false)
    fireEvent.keyDown(document.body, { key: 'f', metaKey: true })
    expect(find).toHaveBeenCalledTimes(1)
  })

  it('查看器没这个键 → 放行全局(⌘P 照样开检索)', () => {
    render(<Harness run={runCommand} />)
    viewerPath({ find: vi.fn() })
    fireEvent.keyDown(document.body, { key: 'p', metaKey: true })
    expect(runCommand).toHaveBeenCalledWith('toggle:search')
  })

  it('两边都没人认领 → 什么都不做,也不 preventDefault', () => {
    render(<Harness run={runCommand} />)
    viewerPath({ find: vi.fn() })
    const e = new KeyboardEvent('keydown', { key: 'q', metaKey: true, cancelable: true })
    window.dispatchEvent(e)
    expect(runCommand).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
  })

  it('用户改绑之后走的是新组合(全局那一档仍然读注册表)', () => {
    render(<Harness run={runCommand} />)
    focusTree.register('root', null).activate()
    // 改绑要经 act:派发器的 effect 依赖 overrides,不让 React 提交完就按,
    // 监听器手里还是旧那份表(这条本身就是一次「怎么算改绑生效了」的判例)。
    act(() => useKeymapStore.setState({ overrides: { 'toc.toggle': { meta: true, key: 'y' } } }))
    fireEvent.keyDown(document.body, { key: 'y', metaKey: true })
    expect(runCommand).toHaveBeenCalledWith('toc.toggle')
  })
})

describe('两半相位:浮层认捕获,面认冒泡(R1 过渡形)', () => {
  /** 在 window 捕获相位上排一个探针,它跑在派发器的冒泡半**之前**。 */
  function witness(): { seen: string[]; off: () => void } {
    const seen: string[] = []
    const onKey = () => seen.push('capture-witness')
    window.addEventListener('keydown', onKey, true)
    return { seen, off: () => window.removeEventListener('keydown', onKey, true) }
  }

  it('浮层的 Esc 在**捕获**半认领 —— 冒泡相位的旁观者看到的已经是 defaultPrevented', () => {
    render(<Harness run={runCommand} />)
    const root = focusTree.register('root', null)
    const jump = focusTree.register('jumpbar', root.instanceId, { onEscape: () => true })
    jump.activate()

    let prevented: boolean | null = null
    const onBubble = (e: KeyboardEvent) => {
      prevented = e.defaultPrevented
    }
    window.addEventListener('keydown', onBubble)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    window.removeEventListener('keydown', onBubble)

    expect(prevented).toBe(true)
  })

  it('面(root / layer / region)的 Esc 在**冒泡**半 —— 捕获相位的旁观者还没看到认领', () => {
    render(<Harness run={runCommand} />)
    const answered: string[] = []
    const root = focusTree.register('root', null, {
      onEscape: () => (answered.push('root'), true),
    })
    root.activate()

    let preventedAtCapture: boolean | null = null
    const onCapture = (e: KeyboardEvent) => {
      preventedAtCapture = e.defaultPrevented
    }
    window.addEventListener('keydown', onCapture, true)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    window.removeEventListener('keydown', onCapture, true)

    expect(answered).toEqual(['root'])
    expect(preventedAtCapture).toBe(false)
  })

  it('录制态独占**掐断传播**:捕获半之后的旁观者一个字都收不到(录 ⌘P 不会真开检索)', () => {
    render(<Harness run={runCommand} />)
    focusTree.capture(() => true)
    const w = witness()
    const seenBubble: string[] = []
    const onBubble = () => seenBubble.push('bubble')
    window.addEventListener('keydown', onBubble)

    fireEvent.keyDown(document.body, { key: 'p', metaKey: true })

    window.removeEventListener('keydown', onBubble)
    w.off()
    expect(seenBubble).toEqual([])
    expect(runCommand).not.toHaveBeenCalled()
  })
})

describe('瞬态口(Tooltip 那一族)', () => {
  it('问在活动路径之前;答 false = 不认领,这一下继续传给下面那层', () => {
    render(<Harness run={runCommand} />)
    const order: string[] = []
    const root = focusTree.register('root', null, {
      onEscape: () => (order.push('root'), true),
    })
    root.activate()
    focusTree.registerTransient(() => {
      order.push('tooltip')
      return false
    })

    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(order).toEqual(['tooltip', 'root'])
  })

  it('答 true = 我吃了:路径一格都不问', () => {
    render(<Harness run={runCommand} />)
    const order: string[] = []
    const root = focusTree.register('root', null, {
      onEscape: () => (order.push('root'), true),
    })
    root.activate()
    focusTree.registerTransient(() => (order.push('greedy'), true))

    const e = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    window.dispatchEvent(e)
    expect(order).toEqual(['greedy'])
    expect(e.defaultPrevented).toBe(true)
  })

  it('只在 Esc 上问它 —— 别的键一个字都不碰', () => {
    render(<Harness run={runCommand} />)
    const asked = vi.fn(() => false)
    focusTree.registerTransient(asked)
    focusTree.register('root', null).activate()

    fireEvent.keyDown(document.body, { key: 'p', metaKey: true })
    expect(asked).not.toHaveBeenCalled()
    expect(runCommand).toHaveBeenCalledWith('toggle:search')
  })
})

describe('② I1:按键之前先把孤儿焦点接回来', () => {
  it('焦点掉到 body 了,下一下按键之前它已经回到落点上', () => {
    render(<Harness run={runCommand} />)
    const shell = document.createElement('div')
    shell.tabIndex = -1
    document.body.append(shell)
    const root = focusTree.register('root', null)
    root.setRoot(shell)
    root.activate()
    expect(document.activeElement).toBe(shell)

    shell.blur()
    expect(document.activeElement).toBe(document.body)

    fireEvent.keyDown(document.body, { key: 'p', metaKey: true })
    expect(document.activeElement).toBe(shell)
  })
})
