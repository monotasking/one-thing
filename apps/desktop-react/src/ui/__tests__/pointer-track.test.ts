import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PointerTrack } from '../drag'
import { focusTree } from '../../focus/registry'
import { installWindowFocusSource, reportWindowBlur, resetWindowFocus } from '../../focus/window-focus'

/**
 * **`ui/drag/PointerTrack` 的守卫**(U5,2026-09-08)。
 *
 * 它守的是这一件存在的**全部理由**:第二族手势(调一个数 —— 分隔杆 / 架子厚度 /
 * 浮窗)从前只有两条结束路径、监听还挂在元素上,于是拖到一半切走应用就永远回不来。
 * 所以这里逐条钉三条结束路径、钉「取消之后这一场真的死了」、钉拆卸幂等。
 *
 * **事件一律手搓 `MouseEvent`**:jsdom 没有 `PointerEvent` 构造器,而这一件读的
 * 只有 `clientX/clientY`(消费方读的),`MouseEvent` 带得出来;事件**名字**是
 * `pointermove` / `pointerup`,监听按名字挂,所以照样收得到(判据与
 * `drag-session.test.tsx` 那段注释同源)。
 *
 * `setPointerCapture` / `releasePointerCapture` 在 jsdom 里不存在 —— 件里两处都
 * 包在 try/catch 里,所以这里什么都不必补:测的正是「抢不到 capture 也照样工作」。
 */
const pointer = (type: string, x = 0, y = 0) =>
  new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y })

let source: HTMLElement

beforeEach(() => {
  source = document.createElement('div')
  document.body.appendChild(source)
})

afterEach(() => {
  source.remove()
})

/** 这一场登记的那格 Esc 口(瞬态表末位)。没有就答 null。 */
function lastTransient(): (() => boolean) | null {
  const all = focusTree.transientEscapeHandlers()
  return all.length > 0 ? all[all.length - 1] : null
}

describe('PointerTrack:三条结束路径', () => {
  it('pointerup = 落定:end 收到那一发事件,cancel 一次都不叫', () => {
    const end = vi.fn()
    const cancel = vi.fn()
    PointerTrack.open(source, 1, { end, cancel })
    source.dispatchEvent(pointer('pointermove', 40, 0))
    source.dispatchEvent(pointer('pointerup', 60, 0))
    expect(end).toHaveBeenCalledTimes(1)
    expect((end.mock.calls[0][0] as MouseEvent).clientX).toBe(60)
    expect(cancel).not.toHaveBeenCalled()
  })

  it('pointercancel = 作废,理由是 pointercancel', () => {
    const end = vi.fn()
    const cancel = vi.fn()
    PointerTrack.open(source, 1, { end, cancel })
    source.dispatchEvent(pointer('pointercancel'))
    expect(cancel).toHaveBeenCalledWith('pointercancel')
    expect(end).not.toHaveBeenCalled()
  })

  /*
   * **这一条是本单立案的直接起因**:拖到一半 Cmd-Tab 切走应用,窗口失焦 ——
   * 从前三处手写的监听都收不到它(它只在 window 上发得出来),于是活值一直挂着。
   * 反证:把 `open()` 里那句 `window.addEventListener('blur', …)` 挖掉 → 这一条红。
   */
  it('窗口失焦 = 作废,理由是 blur', () => {
    const cancel = vi.fn()
    PointerTrack.open(source, 1, { cancel })
    window.dispatchEvent(new Event('blur'))
    expect(cancel).toHaveBeenCalledWith('blur')
  })

  /*
   * **Esc 走响应链的瞬态口,不是一条 window listener**(不变量 I2)。这一条直接
   * 问树:跟踪期间那张瞬态表里有人,而且它答 true(吃掉这一下)。
   * 反证:把 `registerTransient` 那一段换成 window keydown 监听 → `ui:consume` 的
   * `keydown-outside-focus` 硬闸当场红(那是零基线的)。
   */
  it('Esc 由 focus 树的瞬态口认领,答 true 并作废', () => {
    const cancel = vi.fn()
    const before = focusTree.transientEscapeHandlers().length
    PointerTrack.open(source, 1, { cancel })
    expect(focusTree.transientEscapeHandlers().length).toBe(before + 1)
    expect(lastTransient()?.()).toBe(true)
    expect(cancel).toHaveBeenCalledWith('escape')
    // 拆干净 = 那一格也从瞬态表里销号了。
    expect(focusTree.transientEscapeHandlers().length).toBe(before)
  })

  it('落定之后瞬态表里也没有它了 —— 松手之后的 Esc 该归别人', () => {
    const before = focusTree.transientEscapeHandlers().length
    PointerTrack.open(source, 1, {})
    source.dispatchEvent(pointer('pointerup'))
    expect(focusTree.transientEscapeHandlers().length).toBe(before)
  })
})

describe('PointerTrack:结束就是结束', () => {
  /*
   * 与 `DragSession` **相反**的那条契约(判词整段在 `pointer-track.ts` 文件头):
   * 那一件 Esc 取消之后要留着 pointerup 去吃紧跟着的 click;这一件的取消是整个
   * 拆干净 —— 杆与把手身上没有 click 语义,留一条监听只会让「已经作废的一下」
   * 在松手那一刻又落定一次。
   * 反证:把 `settle()` 里那句 `this.dispose()` 挪到 `notify()` 之后 → 仍旧绿;
   * 把 `dispose()` 里摘 `pointerup` 那一行挖掉 → 这一条红(end 被叫了一次)。
   */
  it('取消之后再来一发 pointerup,不再触发 end', () => {
    const end = vi.fn()
    const cancel = vi.fn()
    PointerTrack.open(source, 1, { end, cancel })
    source.dispatchEvent(pointer('pointercancel'))
    source.dispatchEvent(pointer('pointerup'))
    expect(end).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('落定之后再来的 pointermove 一律不理', () => {
    const move = vi.fn()
    PointerTrack.open(source, 1, { move })
    source.dispatchEvent(pointer('pointermove', 10, 0))
    source.dispatchEvent(pointer('pointerup'))
    source.dispatchEvent(pointer('pointermove', 20, 0))
    expect(move).toHaveBeenCalledTimes(1)
  })

  it('三条路互斥:失焦之后的 Esc 与 pointercancel 都是空动作', () => {
    const cancel = vi.fn()
    const track = PointerTrack.open(source, 1, { cancel })
    const esc = lastTransient()
    window.dispatchEvent(new Event('blur'))
    esc?.()
    source.dispatchEvent(pointer('pointercancel'))
    track.cancel('escape')
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalledWith('blur')
  })

  it('dispose 幂等,而且只拆不叫回调', () => {
    const end = vi.fn()
    const cancel = vi.fn()
    const track = PointerTrack.open(source, 1, { end, cancel })
    track.dispose()
    track.dispose()
    source.dispatchEvent(pointer('pointerup'))
    window.dispatchEvent(new Event('blur'))
    expect(end).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
  })

  it('一只回调都不给也拆得干净 —— 三只都是可选的', () => {
    const before = focusTree.transientEscapeHandlers().length
    PointerTrack.open(source, 1, {})
    source.dispatchEvent(pointer('pointermove', 5, 5))
    source.dispatchEvent(pointer('pointerup'))
    expect(focusTree.transientEscapeHandlers().length).toBe(before)
  })
})


/**
 * **「窗口失焦」只认 `focus/window-focus` 那一个产地**(2026-09-15)。桌面上焦点换到
 * 本窗原生视图时 DOM `blur` 也响,而窗口没失焦 —— 那一发不许取消。
 * 反证:把 `open()` 里 `subscribeWindowBlur` 换回 `window.addEventListener('blur', …)` → 第一条红。
 */
describe('PointerTrack:窗口失焦的产地', () => {
  afterEach(() => resetWindowFocus())

  it('宿主接管时 DOM blur 不取消,宿主报的那一发才取消', () => {
    const restore = installWindowFocusSource()
    const end = vi.fn()
    const cancel = vi.fn()
    PointerTrack.open(source, 1, { end, cancel })
    window.dispatchEvent(new Event('blur'))
    expect(cancel).not.toHaveBeenCalled()
    reportWindowBlur()
    expect(cancel).toHaveBeenCalledWith('blur')
    restore()
  })
})
