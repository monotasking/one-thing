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
import { resetViewClaims } from '../view-claim'

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
  // 账本按 viewId 活过挂载,不清的话上一条用例说过的「遮着」会漏进下一条的起点。
  resetViewClaims()
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

  it('卸载后**一帧内没人接手**才报一帧「看不见」,但**不**发 close —— 摘地不等于关 tab', async () => {
    const bridge = installBridge()
    const view = renderSlot()
    await flushFrames()
    const before = bridge.sent.length
    act(() => view.unmount())
    // 卸载那一拍一个字都不发:这一帧留给换宿主的下一任(2026-09-26)。
    expect(bridge.sent.length).toBe(before)
    await flushFrames()
    expect(bridge.sent.at(-1)).toMatchObject({ verb: 'frame', visible: false })
    expect(bridge.sent.some((m) => (m as { verb: string }).verb === 'close')).toBe(false)
  })

  /*
   * 换宿主(2026-09-26 用户报障「拖进主面板变白,切走再切回才恢复」的根):同一次
   * 提交里旧的卸载、新的挂上,主进程**不许**收到那帧「0×0、看不见」—— 从前它夹在
   * 两帧「可见」之间,让一片藏着的视图先缩成 0×0 再放回去。
   * **反证**:把 `NativeViewSlot` 清理里那一发 frame 从 `releaseViewClaim` 的回调挪回
   * 当场发 → 这一条红。
   */
  it('换宿主:卸载与再挂载同一拍 → 全程没有一帧「看不见」,新宿主只多一帧「可见」', async () => {
    const bridge = installBridge()
    const first = renderSlot()
    await flushFrames()
    const hidden = () => bridge.sent.filter((m) => m.verb === 'frame' && !m.visible).length
    const shown = () => bridge.sent.filter((m) => m.verb === 'frame' && m.visible).length
    expect(hidden()).toBe(0)
    expect(shown()).toBe(1)
    act(() => {
      first.unmount()
    })
    renderSlot()
    await flushFrames()
    expect(hidden()).toBe(0)
    expect(shown()).toBe(2)
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

  it('挂着一格 `modal` 作用域**且压在这片地上** → occlude(菜单 / 弹层 / 抽屉都走这一条)', async () => {
    const bridge = installBridge()
    renderSlot()
    await flushFrames()
    const handle = focusTree.register('menu', null, {})
    act(() => {
      // 菜单体与这片地(10,20,300×200)相交。
      const root = document.createElement('div')
      root.dataset.fakeRect = '100,100,200,300'
      handle.setRoot(root)
    })
    await flushFrames()
    expect(bridge.sent.filter((m) => m.verb === 'occlude').length).toBe(1)
    act(() => handle.unregister())
    await flushFrames()
    expect(bridge.sent.filter((m) => m.verb === 'unocclude').length).toBe(1)
  })

  /*
   * 2026-09-26 用户报障「点会话列表的项目过滤,浏览器会闪」:那张菜单开在侧栏,与浏览器
   * 隔半个屏幕,从前判据②只数「树上挂着几格」,于是照样走一遍拍快照 → 藏 → 显。
   * **反证**:把 `overlayCovers(rect)` 换回 `overlayScopeCount() > 0` → 这一条红。
   */
  it('挂着的 `modal` 作用域**不与这片地相交** → 一个字都不发(隔半个屏幕的菜单盖不住我)', async () => {
    const bridge = installBridge()
    renderSlot()
    await flushFrames()
    const handle = focusTree.register('menu', null, {})
    act(() => {
      const root = document.createElement('div')
      root.dataset.fakeRect = '800,600,200,300'
      handle.setRoot(root)
    })
    await flushFrames()
    expect(bridge.sent.filter((m) => m.verb === 'occlude').length).toBe(0)
    act(() => handle.unregister())
    await flushFrames()
    expect(bridge.sent.filter((m) => m.verb === 'unocclude').length).toBe(0)
  })

  it('带满屏遮罩的对话框:面板不相交也算遮(量的是 `data-overlay-scrim` 那张遮罩)', async () => {
    const bridge = installBridge()
    renderSlot()
    await flushFrames()
    const scrim = document.createElement('div')
    scrim.setAttribute('data-overlay-scrim', '')
    scrim.dataset.fakeRect = '0,0,2000,2000'
    const panel = document.createElement('div')
    panel.dataset.fakeRect = '800,600,200,300'
    scrim.appendChild(panel)
    document.body.appendChild(scrim)
    const handle = focusTree.register('dialog', null, {})
    act(() => {
      handle.setRoot(panel)
    })
    await flushFrames()
    expect(bridge.sent.filter((m) => m.verb === 'occlude').length).toBe(1)
    act(() => handle.unregister())
    await flushFrames()
    expect(bridge.sent.filter((m) => m.verb === 'unocclude').length).toBe(1)
    scrim.remove()
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

/**
 * **换宿主 = 一次重挂**(拖去别的叶 / 架子 / 浮窗;2026-09-15 用户报障「拖拽后不能
 * 自适应」「搜索时闪烁」的根)。真机读数与判词在 `view-claim.ts` 文件头。这里量的
 * 是占位格这一侧的三句话:
 *  · 拖拽期间发过 `occlude` 的那一任卸载、新的一任在同一拍挂上(拖完了)→ 新的一任
 *    要**补上** `unocclude`(反证:把 `lastOccluded` 的起点改回 `false`,第一条当场红);
 *  · 上一任手上的快照跟着交接:新占位格**第一帧**就有那张图,不是空一秒;
 *  · 卸载之后没人接手 → 一帧后替它收回一次;没遮着就一个字不发。
 */
describe('换宿主(重挂)', () => {
  it('拖拽中卸载、拖完挂上 → 新的一任补发 unocclude(一条,不多不少)', async () => {
    const bridge = installBridge()
    const first = renderSlot()
    await flushFrames()
    act(() => {
      useWorkbenchStore.setState({ dragging: true })
    })
    await flushFrames()
    expect(bridge.sent.filter((m) => m.verb === 'occlude').length).toBe(1)
    // 松手:`setDragging(false)` 与落定同一拍 —— 旧的卸载、新的挂上,中间不隔一帧。
    act(() => {
      useWorkbenchStore.setState({ dragging: false })
      first.unmount()
    })
    renderSlot()
    await flushFrames()
    expect(bridge.sent.filter((m) => m.verb === 'unocclude').length).toBe(1)
    expect(bridge.sent.filter((m) => m.verb === 'occlude').length).toBe(1)
    // 新的一任报了一帧「看得见」——主进程那边 visible ∧ !occluded 才画得出来。
    expect(bridge.sent.at(-1)).toMatchObject({ verb: 'unocclude' })
    expect(bridge.sent.filter((m) => m.verb === 'frame' && m.visible).length).toBe(2)
  })

  /*
   * 2026-09-26 录屏坐实的病:拖进主面板标签条之后,原生视图留在浮窗的旧矩形上。
   * 关掉的浮窗用上一棵树再画 120ms 出场动画(`FloatWindow.shownTree`),旧占位格在
   * 新的一任挂上**之后**还活着;它量到的 z 变了(`floatOrder` 里没了那扇窗),就把
   * 旧浮窗矩形又发一遍,盖掉新宿主的帧。
   * **反证**:把 `measure` 开头 `isCurrentViewHolder` 那一段删掉 → 这一条红。
   */
  it('旧的一任还活着(出场动画)又量了一次 → 一个字不发;主进程手上最后一帧是新宿主的', async () => {
    const bridge = installBridge()
    // 旧的一任长在浮窗 a 里(z 1)。
    const mountOld = () =>
      render(
        <FocusScope scope="browser">
          {({ scopeProps }) => (
            <div {...scopeProps} data-pane-region="float:a">
              <NativeViewSlot viewId="v1" scope="browser" />
            </div>
          )}
        </FocusScope>,
      )
    act(() => {
      useStageStore.setState({ floatOrder: ['a'] })
    })
    const old = mountOld()
    const oldHost = old.container.querySelector<HTMLElement>('[data-native-view="v1"]')!
    oldHost.dataset.fakeRect = '400,300,300,200'
    await flushFrames()
    expect(bridge.sent.at(-1)).toMatchObject({ verb: 'frame', bounds: { x: 400, y: 300 }, z: 1 })

    // 落定:新的一任在中央区挂上(旧的还没卸载 —— 它在出场动画里),浮窗从 floatOrder 里消失。
    const fresh = renderSlot()
    act(() => {
      useStageStore.setState({ floatOrder: [] })
    })
    await flushFrames()
    const frames = bridge.sent.filter((m) => m.verb === 'frame')
    // 新宿主那一帧(10,20,300×200,z 0)是最后一帧;旧的一任量到 z 变了也没开口。
    expect(frames.at(-1)).toMatchObject({ bounds: { x: 10, y: 20, width: 300, height: 200 }, z: 0 })
    expect(frames.filter((m) => m.bounds.x === 400).length).toBe(1)

    // 旧的一任走了:有人接着持有 → 不藏、不收回。
    act(() => old.unmount())
    await flushFrames()
    expect(bridge.sent.filter((m) => m.verb === 'frame' && !m.visible).length).toBe(0)
    fresh.unmount()
  })

  it('新的一任先走了 → 旧的一任回到最上面,把自己的帧重发一遍(主进程手上那句是别人说的)', async () => {
    const bridge = installBridge()
    const old = renderSlot()
    await flushFrames()
    const fresh = render(
      <FocusScope scope="browser">
        {({ scopeProps }) => (
          <div {...scopeProps} data-pane-region="float:b">
            <NativeViewSlot viewId="v1" scope="browser" />
          </div>
        )}
      </FocusScope>,
    )
    const freshHost = fresh.container.querySelector<HTMLElement>('[data-native-view="v1"]')!
    freshHost.dataset.fakeRect = '500,500,100,100'
    act(() => {
      useStageStore.setState({ floatOrder: ['b'] })
    })
    await flushFrames()
    expect(bridge.sent.filter((m) => m.verb === 'frame').at(-1)).toMatchObject({ bounds: { x: 500 }, z: 1 })
    const before = bridge.sent.filter((m) => m.verb === 'frame').length

    act(() => fresh.unmount())
    // 任何一次重量(store 变化)都会让回到最上面的那一任重发。
    act(() => {
      useStageStore.setState({ floatOrder: [] })
    })
    await flushFrames()
    const frames = bridge.sent.filter((m) => m.verb === 'frame')
    expect(frames.length).toBe(before + 1)
    expect(frames.at(-1)).toMatchObject({ bounds: { x: 10, y: 20, width: 300, height: 200 }, visible: true, z: 0 })
    old.unmount()
  })

  it('快照跟着账交接:新占位格第一帧就画着上一任那张图', async () => {
    const bridge = installBridge()
    const first = renderSlot()
    await flushFrames()
    act(() => {
      useWorkbenchStore.setState({ dragging: true })
    })
    await flushFrames()
    act(() => {
      bridge.push({ kind: 'snapshot', viewId: 'v1', dataUrl: 'data:image/png;base64,AA' })
    })
    await flushFrames()
    act(() => first.unmount())
    const second = renderSlot()
    const img = second.container.querySelector<HTMLImageElement>('[data-testid="native-view-snapshot"]')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src')).toBe('data:image/png;base64,AA')
  })

  it('仍在拖拽中换宿主 → 新的一任不重复发 occlude(主进程已经知道)', async () => {
    const bridge = installBridge()
    const first = renderSlot()
    await flushFrames()
    act(() => {
      useWorkbenchStore.setState({ dragging: true })
    })
    await flushFrames()
    act(() => first.unmount())
    renderSlot()
    await flushFrames()
    expect(bridge.sent.filter((m) => m.verb === 'occlude').length).toBe(1)
    expect(bridge.sent.filter((m) => m.verb === 'unocclude').length).toBe(0)
  })

  it('卸载之后没人接手 → 一帧后替它收回一次;没遮着就一个字不发', async () => {
    const bridge = installBridge()
    const view = renderSlot()
    await flushFrames()
    act(() => {
      useWorkbenchStore.setState({ dragging: true })
    })
    await flushFrames()
    const before = bridge.sent.length
    act(() => view.unmount())
    // 卸载那一拍:一个字都不发(藏与收回都留一帧给重挂,2026-09-26 起同一条线)。
    expect(bridge.sent.length).toBe(before)
    await flushFrames()
    // 没人接手:先藏这片地,再替它把「遮着」收回 —— 次序是判据(反过来主进程会先显一帧)。
    const tail = bridge.sent.slice(before)
    expect(tail.map((m) => m.verb)).toEqual(['frame', 'unocclude'])
    expect(tail[0]).toMatchObject({ verb: 'frame', visible: false })
    expect(bridge.sent.filter((m) => m.verb === 'unocclude').length).toBe(1)

    // 没遮着的那一任走了:一条 unocclude 都不多。
    act(() => {
      useWorkbenchStore.setState({ dragging: false })
    })
    const quiet = installBridge()
    const plain = renderSlot('v2')
    await flushFrames()
    act(() => plain.unmount())
    await flushFrames()
    expect(quiet.sent.filter((m) => m.verb === 'unocclude').length).toBe(0)
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
    // 全局命令也在表里(K2 起检索面的出厂键是 ⌘⇧F)。
    expect(chords.some((c) => c === 'cmd+shift+f' || c === 'ctrl+shift+f')).toBe(true)
    /*
     * **叶那一族也在**(K2):一片原生视图永远住在一格 tab 里,所以 ⌘T / ⌘W /
     * ⌘1–9 同样要先于页面截下来(Chrome 对自己那几个键的做法)。判词整段在
     * `keymap-downlink.NATIVE_VIEW_HOST_SCOPES` 上;拆掉它这两句当场红。
     */
    expect(chords.some((c) => c === 'cmd+t' || c === 'ctrl+t')).toBe(true)
    expect(chords.some((c) => c === 'cmd+w' || c === 'ctrl+w')).toBe(true)
  })
})
