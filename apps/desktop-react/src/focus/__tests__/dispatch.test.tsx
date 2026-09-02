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
 * 一次按键的七步(独占 → defaultPrevented → Esc → Tab → 输入面单键 → 局部 → 全局)
 * 每一步各钉一条。**R0 里这只 hook 没有挂在壳上**(AppShell 仍用旧派发器),
 * 所以这一组是它上线前的全部保证。
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
  focusTree.policy.moveFocus = false
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
  it('模态里 Tab 走到末项后回首项(闸开着时焦点真的回去)', () => {
    focusTree.policy.moveFocus = true
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
