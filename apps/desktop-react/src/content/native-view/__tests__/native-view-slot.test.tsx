import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { FocusScope } from '../../../focus/FocusScope'
import { focusTree } from '../../../focus/registry'
import { configureBrowserPort } from '../../../data/browser-port'
import type { BrowserPort, NativeViewPush, NativeViewRequest } from '../../../data/browser-port'
import { useStageStore } from '../../../stage/store'
import { useWorkbenchStore } from '../../../workbench/store'
import { NativeViewSlot } from '../NativeViewSlot'
import { resetNativeViewKeymapDownlink } from '../keymap-downlink'

/**
 * **占位格那三条判据的守卫**(B2)。
 *
 * 三条,每条都配一句反证(拆掉即红):
 *  ① 帧**只在变化时发** —— 量的是发出去的条数,不是内容;
 *  ② **遮挡三判据**(浮窗压在上面 / 浮层作用域挂着 / 拖拽中)各自单独成立,
 *     而且「我自己那扇窗」不算遮我(不比名次的话一片长在浮窗里的视图会把自己
 *     永远遮住);
 *  ③ **快照的显隐次序**:图到了要等解码 + 一帧才显;撤图要多留一帧。反过来
 *     的那两种写法在真机上各是一下闪白。
 * 外加一条:`key` 推送进的是**壳里唯一那个派发器**(量的是 window 上真收到了
 * 一次 keydown,而不是这只组件自己挂了第二个监听)。
 */

interface Sent {
  sent: NativeViewRequest[]
  push: (message: NativeViewPush) => void
}

function installBridge(): Sent {
  const sent: NativeViewRequest[] = []
  let handler: ((message: NativeViewPush) => void) | undefined
  const port: BrowserPort = {
    ready: () => Promise.resolve(undefined),
    read: () => Promise.resolve({ kind: 'ok', value: {} }),
    do: () => Promise.resolve({ kind: 'ok', text: '' }),
    onResourceEvent: () => () => undefined,
    nativeView: {
      send: (message) => {
        sent.push(message)
      },
      on: (next) => {
        handler = next
        return () => {
          handler = undefined
        }
      },
    },
  }
  configureBrowserPort(port)
  return { sent, push: (message) => handler?.(message) }
}

/** 让 `getBoundingClientRect` 答一个真矩形(jsdom 默认全 0 = 「看不见」)。 */
function stubRect(rect: { x: number; y: number; w: number; h: number }): void {
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const self = this as HTMLElement
    const own = (self.dataset.fakeRect ?? '').split(',').map(Number)
    const [x, y, w, h] = own.length === 4 ? own : [rect.x, rect.y, rect.w, rect.h]
    return { x, y, width: w, height: h, top: y, left: x, right: x + w, bottom: y + h, toJSON: () => ({}) } as DOMRect
  }
}

const realRect = Element.prototype.getBoundingClientRect

/**
 * jsdom 没有 `ResizeObserver`。这里塞一只**不会自己回调**的替身:这组用例摇的是
 * store / 事件那几条路,不是「容器尺寸真变了」那一条 —— 让替身沉默,量到的条数
 * 才是被摇的那几下自己的。
 */
class SilentResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function renderSlot(viewId = 'v1') {
  return render(
    <FocusScope scope="browser">
      {({ scopeProps }) => (
        <div {...scopeProps} data-pane-region="center">
          <NativeViewSlot viewId={viewId} scope="browser" />
        </div>
      )}
    </FocusScope>,
  )
}

/** 逐帧跑完排队的 rAF(jsdom 的 rAF 是 setTimeout,`act` 里同步冲刷即可)。 */
async function flushFrames(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  }
}

beforeEach(() => {
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = SilentResizeObserver
  resetNativeViewKeymapDownlink()
  stubRect({ x: 10, y: 20, w: 300, h: 200 })
  useWorkbenchStore.setState({ dragging: false })
  useStageStore.setState({ floatOrder: [] })
})

afterEach(() => {
  configureBrowserPort(undefined)
  resetNativeViewKeymapDownlink()
  Element.prototype.getBoundingClientRect = realRect
  focusTree.reset()
})

describe('帧', () => {
  it('只在变化时发:量出来的矩形没变就一条都不再发', async () => {
    const bridge = installBridge()
    renderSlot()
    await flushFrames()
    const frames = () => bridge.sent.filter((m) => m.verb === 'frame')
    const first = frames().length
    expect(first).toBeGreaterThan(0)
    // 再摇几次(resize / store 变化都会排一次 measure),矩形没变 → 不再发。
    act(() => {
      window.dispatchEvent(new Event('resize'))
      useStageStore.setState({ floatOrder: [] })
    })
    await flushFrames()
    expect(frames().length).toBe(first)
  })

  it('单位是 CSS px,原样进 bounds(DIP = CSS px,§9-10)', async () => {
    const bridge = installBridge()
    renderSlot()
    await flushFrames()
    const frame = bridge.sent.find((m) => m.verb === 'frame')
    expect(frame).toMatchObject({
      verb: 'frame',
      viewId: 'v1',
      bounds: { x: 10, y: 20, width: 300, height: 200 },
      visible: true,
      z: 0,
    })
  })

  it('卸载时报一帧「看不见」,但**不**发 close —— 摘地不等于关 tab', async () => {
    const bridge = installBridge()
    const view = renderSlot()
    await flushFrames()
    act(() => view.unmount())
    expect(bridge.sent.at(-1)).toMatchObject({ verb: 'frame', visible: false })
    expect(bridge.sent.some((m) => (m as { verb: string }).verb === 'close')).toBe(false)
  })
})

describe('遮挡三判据', () => {
  it('拖拽中 → occlude;拖完 → unocclude', async () => {
    const bridge = installBridge()
    renderSlot()
    await flushFrames()
    act(() => {
      useWorkbenchStore.setState({ dragging: true })
    })
    await flushFrames()
    expect(bridge.sent.filter((m) => m.verb === 'occlude').length).toBe(1)
    act(() => {
      useWorkbenchStore.setState({ dragging: false })
    })
    await flushFrames()
    expect(bridge.sent.filter((m) => m.verb === 'unocclude').length).toBe(1)
  })

  it('挂着一格 `modal` 作用域 → occlude(菜单 / 弹层 / 命令面板都走这一条)', async () => {
    const bridge = installBridge()
    renderSlot()
    await flushFrames()
    const handle = focusTree.register('menu', null, {})
    act(() => {
      handle.setRoot(document.createElement('div'))
    })
    await flushFrames()
    expect(bridge.sent.filter((m) => m.verb === 'occlude').length).toBe(1)
    act(() => handle.unregister())
    await flushFrames()
    expect(bridge.sent.filter((m) => m.verb === 'unocclude').length).toBe(1)
  })

  it('压在上面的浮窗相交 → occlude;**自己那扇窗不算**(否则它会把自己永远遮住)', async () => {
    const bridge = installBridge()
    // 这片地长在 `float:a` 里(名次 0 → z 1)。
    const view = render(
      <FocusScope scope="browser">
        {({ scopeProps }) => (
          <div {...scopeProps} data-pane-region="float:a">
            <NativeViewSlot viewId="v1" scope="browser" />
          </div>
        )}
      </FocusScope>,
    )
    // 屏幕上有两扇窗:a(我自己)与 b(排在我上面),两扇都与我相交。
    const mount = (id: string) => {
      const el = document.createElement('div')
      el.setAttribute('data-float-body', id)
      el.dataset.fakeRect = '0,0,1000,1000'
      document.body.appendChild(el)
      return el
    }
    mount('a')
    act(() => {
      useStageStore.setState({ floatOrder: ['a'] })
    })
    await flushFrames()
    // 只有我自己那扇 → 不遮。
    expect(bridge.sent.filter((m) => m.verb === 'occlude').length).toBe(0)
    mount('b')
    act(() => {
      useStageStore.setState({ floatOrder: ['a', 'b'] })
    })
    await flushFrames()
    expect(bridge.sent.filter((m) => m.verb === 'occlude').length).toBe(1)
    view.unmount()
  })
})

describe('快照:显与隐的次序', () => {
  it('图到了要等一帧才显;`unocclude` 之后图多留一帧再撤', async () => {
    const bridge = installBridge()
    const view = renderSlot()
    await flushFrames()
    act(() => {
      useWorkbenchStore.setState({ dragging: true })
    })
    await flushFrames()
    act(() => {
      bridge.push({ kind: 'snapshot', viewId: 'v1', dataUrl: 'data:image/png;base64,AA' })
    })
    // 图刚到那一拍:`<img>` 已经在树上(要它去解码),但还**没显**。
    const img = () => view.container.querySelector('[data-testid="native-view-snapshot"]')
    expect(img()).not.toBeNull()
    await flushFrames()
    expect(img()?.hasAttribute('hidden')).toBe(false)
    /*
     * 盖的东西走了:`unocclude` 这一发出去的那一帧,图**还在**(那一帧不许空 ——
     * 主进程要在它自己那一拍才 `setVisible(true)`),**下一帧**才撤。
     * 反证:把「撤图晚一帧」改成当场撤,下面第一条当场红。
     */
    act(() => {
      useWorkbenchStore.setState({ dragging: false })
    })
    await flushFrames(1)
    expect(bridge.sent.filter((m) => m.verb === 'unocclude').length).toBe(1)
    expect(img()).not.toBeNull()
    await flushFrames(3)
    expect(img()).toBeNull()
  })
})

describe('键:推回来的那一下进的是壳里唯一那个派发器', () => {
  it('`key` 推送 → window 上真收到一次 keydown,修饰键逐格对上', async () => {
    const bridge = installBridge()
    renderSlot()
    await flushFrames()
    const seen = vi.fn()
    window.addEventListener('keydown', seen, true)
    act(() => {
      bridge.push({ kind: 'key', viewId: 'v1', key: 'k', code: 'KeyK', modifiers: ['cmd'] })
    })
    window.removeEventListener('keydown', seen, true)
    expect(seen).toHaveBeenCalledTimes(1)
    const event = seen.mock.calls[0][0] as KeyboardEvent
    expect(event.key).toBe('k')
    expect(event.code).toBe('KeyK')
    expect(event.metaKey).toBe(true)
    expect(event.ctrlKey).toBe(false)
  })
})

describe('焦点', () => {
  it('主进程推 `focus` → 这一格作用域被激活(I1:activeElement = 占位格)', async () => {
    const bridge = installBridge()
    renderSlot()
    await flushFrames()
    act(() => {
      bridge.push({ kind: 'focus', viewId: 'v1' })
    })
    expect(focusTree.current()?.scope).toBe('browser')
  })

  it('推 `blur` 什么都不做 —— 焦点去哪由那一边决定', async () => {
    const bridge = installBridge()
    renderSlot()
    await flushFrames()
    act(() => {
      bridge.push({ kind: 'focus', viewId: 'v1' })
    })
    const before = focusTree.current()?.instanceId
    act(() => {
      bridge.push({ kind: 'blur', viewId: 'v1' })
    })
    expect(focusTree.current()?.instanceId).toBe(before)
  })
})

describe('键位下沉', () => {
  it('挂载时推一次整表,里面含全局命令与 `browser` 那条 ⌘L', async () => {
    const bridge = installBridge()
    renderSlot()
    await flushFrames()
    const keymap = bridge.sent.find((m) => m.verb === 'keymap')
    expect(keymap).toBeTruthy()
    const chords = (keymap as { chords: readonly string[] }).chords
    // ⌘L / Ctrl+L —— 主修饰键随平台,两种拼法认一种即可。
    expect(chords.some((c) => c === 'cmd+l' || c === 'ctrl+l')).toBe(true)
    // 全局命令也在表里(出厂的 ⌘P 检索面)。
    expect(chords.some((c) => c === 'cmd+p' || c === 'ctrl+p')).toBe(true)
  })
})
