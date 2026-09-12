import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import { useFocusDispatch } from '../dispatch'
import { focusTree } from '../registry'
import { useKeymapStore } from '../../keymap/store'
import { initialKeymapState } from '../../keymap/transitions'
import type { CommandId } from '../../keymap/types'
import { pinMacUserAgent } from '../../test/mac-ua'

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
  pinMacUserAgent()
  useKeymapStore.setState({ ...initialKeymapState })
  runCommand = vi.fn()
})

afterEach(() => {
  focusTree.reset()
  // R1 起缺省搬焦点;还原成产品里的那一档,别让下一份用例跑在一个不存在的档位上。
  focusTree.policy.moveFocus = true
  document.body.innerHTML = ''
})

/** 造一条 root → viewer 的活动路径,viewer 接了 `view.find`。 */
function viewerPath(handlers: Partial<Record<CommandId, () => void>>) {
  const shell = document.createElement('div')
  const pane = document.createElement('div')
  shell.append(pane)
  document.body.append(shell)
  const root = focusTree.register('root', null)
  root.setRoot(shell)
  const viewer = focusTree.register('viewer', root.instanceId, { commands: handlers })
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
    viewerPath({ 'view.find': find })
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
    viewerPath({ 'view.find': find })
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
    const { pane } = viewerPath({ 'view.find': find })
    expect(pane.contains(document.body)).toBe(false)
    fireEvent.keyDown(document.body, { key: 'f', metaKey: true })
    expect(find).toHaveBeenCalledTimes(1)
  })

  it('查看器没这个键 → 放行全局(⌘P 照样开检索)', () => {
    render(<Harness run={runCommand} />)
    viewerPath({ 'view.find': vi.fn() })
    fireEvent.keyDown(document.body, { key: 'p', metaKey: true })
    expect(runCommand).toHaveBeenCalledWith('toggle:search')
  })

  it('两边都没人认领 → 什么都不做,也不 preventDefault', () => {
    render(<Harness run={runCommand} />)
    viewerPath({ 'view.find': vi.fn() })
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
    act(() => useKeymapStore.setState({ overrides: { 'toc.toggle': [{ meta: true, key: 'y' }] } }))
    fireEvent.keyDown(document.body, { key: 'y', metaKey: true })
    expect(runCommand).toHaveBeenCalledWith('toc.toggle')
  })
})

describe('⑧ 认领:壳不碰,原样交给里面那台程序(K0)', () => {
  /**
   * **Win / Linux 那条路的等价性**(派工单 §5 点名的那一条)。
   *
   * 改之前:`Ctrl+P` 在终端里命中一条 `pty:p` 局部键 → 派发器 `preventDefault`
   * 并跑处理器 → 处理器往 PTY 写 `\x10`(xterm 那条守卫因为 `defaultPrevented`
   * 已经让开了)。改之后:它命中 `claims` → 派发器**不** `preventDefault`、不跑
   * 任何东西 → xterm 收到原生 keydown 自己把 `\x10` 写下去。
   *
   * 所以这一条要证三件:路由答 `claim`、`toggle:search` 没被跑、事件**未被**
   * `preventDefault`(最后那一件正是 xterm 那条守卫的入口)。
   */
  function terminalPath(): void {
    const shell = document.createElement('div')
    const leafEl = document.createElement('div')
    const pane = document.createElement('div')
    leafEl.append(pane)
    shell.append(leafEl)
    document.body.append(shell)
    const root = focusTree.register('root', null)
    root.setRoot(shell)
    const leaf = focusTree.register('leaf', root.instanceId, {
      commands: { 'tab.close': () => {} },
    })
    leaf.setRoot(leafEl)
    const term = focusTree.register('terminal', leaf.instanceId, {
      commands: { 'view.find': () => {} },
    })
    term.setRoot(pane)
    term.activate('open')
  }

  beforeEach(() => {
    // 这一组要的是 Win / Linux 那一档:主修饰键是 Ctrl,认领表非空。
    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      configurable: true,
    })
  })

  it('Ctrl+P 在终端里:不跑 `toggle:search`,而且**没有** preventDefault', () => {
    render(<Harness run={runCommand} />)
    terminalPath()
    const e = new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, cancelable: true })
    window.dispatchEvent(e)
    expect(runCommand).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
  })

  it('Ctrl+W 在终端里:装着它的那片叶不关 tab(认领比它深)', () => {
    render(<Harness run={runCommand} />)
    terminalPath()
    const e = new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, cancelable: true })
    window.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
  })

  it('没被认领的 Ctrl 组合照旧走候选(Ctrl+E 认领了,Ctrl+O 没有)', () => {
    render(<Harness run={runCommand} />)
    terminalPath()
    // ⌘⇧O = 目录面板;Win 档写作 Ctrl+Shift+O,终端一格都没认领它。
    fireEvent.keyDown(document.body, { key: 'o', ctrlKey: true, shiftKey: true })
    expect(runCommand).toHaveBeenCalledWith('toc.toggle')
  })
})

describe('一张表,一个捕获相位的监听(R2 两半合一)', () => {
  /** 在 window 捕获相位上排一个探针。它比派发器**晚**登记,所以跑在它后面。 */
  function witness(): { seen: string[]; off: () => void } {
    const seen: string[] = []
    const onKey = () => seen.push('capture-witness')
    window.addEventListener('keydown', onKey, true)
    return { seen, off: () => window.removeEventListener('keydown', onKey, true) }
  }

  /**
   * 反证:把派发器的相位改回冒泡(`window.addEventListener('keydown', onKey)`),
   * 下面这两条当场红 —— 冒泡相位里,捕获探针看到的 `defaultPrevented` 会是 false。
   */
  it('浮层的 Esc 在**捕获**相位就认领掉了', () => {
    render(<Harness run={runCommand} />)
    const root = focusTree.register('root', null)
    const jump = focusTree.register('jumpbar', root.instanceId, { onEscape: () => true })
    jump.activate()

    let preventedAtCapture: boolean | null = null
    const onCapture = (e: KeyboardEvent) => {
      preventedAtCapture = e.defaultPrevented
    }
    window.addEventListener('keydown', onCapture, true)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    window.removeEventListener('keydown', onCapture, true)

    expect(preventedAtCapture).toBe(true)
  })

  it('**面(root / layer / region)的 Esc 也在同一个相位** —— 这就是两半合一的读数', () => {
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
    expect(preventedAtCapture).toBe(true)
  })

  it('window 上**只有这一个** keydown 监听(两半合一的另一半读数)', () => {
    const added: boolean[] = []
    const spy = vi
      .spyOn(window, 'addEventListener')
      .mockImplementation(((type: string, _fn: unknown, opts: unknown) => {
        if (type === 'keydown') added.push(opts === true)
      }) as typeof window.addEventListener)
    render(<Harness run={runCommand} />)
    spy.mockRestore()
    // 一条,而且是捕获档。反证:把冒泡半加回去 → 长度变 2。
    expect(added).toEqual([true])
  })

  it('输入法组字期间树一格都不动(⑤ Esc 不退层、⑨ 全局命令不响)', () => {
    render(<Harness run={runCommand} />)
    const answered: string[] = []
    focusTree
      .register('root', null, { onEscape: () => (answered.push('root'), true) })
      .activate()

    const esc = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    Object.defineProperty(esc, 'isComposing', { value: true })
    window.dispatchEvent(esc)
    expect(answered).toEqual([])
    expect(esc.defaultPrevented).toBe(false)

    const cmd = new KeyboardEvent('keydown', { key: 'p', metaKey: true, cancelable: true })
    Object.defineProperty(cmd, 'isComposing', { value: true })
    window.dispatchEvent(cmd)
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('录制态独占**掐断传播**:派发器之后的旁观者一个字都收不到(录 ⌘P 不会真开检索)', () => {
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
