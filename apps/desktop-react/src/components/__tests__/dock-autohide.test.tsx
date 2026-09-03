import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import { AppShell } from '../AppShell'
import { useStageStore } from '../../stage/store'
import { initialStageState } from '../../stage/transitions'
import { DOCK_HIDE_DELAY_MS, DOCK_WAKE_DWELL_MS } from '../motion'

/**
 * **自动隐藏的唤醒生命周期**(09-03 报障:「dock 的出现太敏感」)。
 *
 * 判据本身是纯函数(`stage/transitions.shouldShowDock`,它那一组用例在
 * `stage/transitions.test.ts`);这一份钉的是**宿主那半边** —— 那张停留表的寿命:
 * 进带起表 / 在带续表 / 出带清表 / **出窗清表** / 到点再判一次。
 *
 * 出窗那一格是本批的另一半,而且**只能在宿主里判**:指针一旦离开这扇窗,
 * pointermove 就停发了,纯函数永远看不到「事件不来了」这件事,于是计时器会以为
 * 手还老老实实停在边上 —— 「去点系统 Dock,我们的也跟着弹出来」就是这么来的。
 *
 * jsdom 视口是 1024×768(默认),底边窄带 = y ≥ 760(DOCK_WAKE_BAND = 8)。
 * 真机那一半(自然速度穿越 20 次一次都不唤醒)由 `scripts/gate-dock-wake.mjs` 量。
 */
beforeEach(() => {
  vi.useFakeTimers()
  useStageStore.setState({ ...initialStageState, locale: 'zh', dockDisplay: 'autohide' })
})

afterEach(() => {
  vi.useRealTimers()
})

/** Dock 那条 `<nav>`。藏着时它带 `.hidden`。 */
function dockNav(): HTMLElement {
  const strip = document.querySelector('[data-dock="strip"]') as HTMLElement
  return strip.closest('nav') as HTMLElement
}

/**
 * CSS Modules 在这套构建里出来的是 `_hidden_17e458` 这种带哈希的名字,所以判的是
 * **有没有哪一格的语义名是 hidden**,不是字面 `'hidden'`(那样恒假,一整份用例会
 * 自己把自己判成「一直藏着」而全绿 —— 与仓规「读样式表源文本的门先剥注释」同一类坑)。
 */
const isHidden = () =>
  dockNav()
    .className.split(/\s+/)
    .some((c) => /(^|_)hidden(_|$)/.test(c))

/**
 * 往 window 派一发 pointermove(宿主的监听就挂在 window 上)。
 *
 * **用 MouseEvent 而不是 `fireEvent.pointerMove`**:jsdom 没有 `PointerEvent`,
 * testing-library 于是退回裸 `Event`,`clientX/clientY` 全是 undefined —— 判据里
 * `viewport.h - undefined` 是 NaN,窄带恒假,整份用例会**全部因为「永远唤不醒」
 * 而绿**(② 那条正是拿来防这个假绿的:它必须真的唤醒)。
 */
function move(x: number, y: number) {
  act(() => {
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y, bubbles: true }))
  })
}

function tick(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

/** 底边窄带里的一点(视口底往上 2px)。 */
const inBand = (): [number, number] => [Math.floor(window.innerWidth / 2), window.innerHeight - 2]

describe('自动隐藏:唤醒是停留不是碰到', () => {
  it('① 平时藏着', () => {
    render(<AppShell />)
    expect(isHidden()).toBe(true)
  })

  it('② 进带 → 停满门槛 → 出来', () => {
    render(<AppShell />)
    move(...inBand())
    expect(isHidden()).toBe(true) // 碰到那一下什么也不发生
    tick(DOCK_WAKE_DWELL_MS)
    expect(isHidden()).toBe(false)
  })

  it('③ 进带 → 没停够就出带 → 不唤醒(「穿过去」那一下)', () => {
    render(<AppShell />)
    const [x, y] = inBand()
    move(x, y)
    tick(DOCK_WAKE_DWELL_MS - 60)
    move(x, y - 200) // 抬手离开窄带
    tick(DOCK_WAKE_DWELL_MS * 3)
    expect(isHidden()).toBe(true)
  })

  it('④ 出带之后重新进带 = 重新计时,不许把上一次的零头算进来', () => {
    render(<AppShell />)
    const [x, y] = inBand()
    move(x, y)
    tick(DOCK_WAKE_DWELL_MS - 20)
    move(x, y - 200)
    move(x, y)
    tick(DOCK_WAKE_DWELL_MS - 20)
    expect(isHidden()).toBe(true)
    tick(20)
    expect(isHidden()).toBe(false)
  })

  it('⑤ 在带内一直动(没出带)照旧算连续停留 —— 续表不是重排', () => {
    render(<AppShell />)
    const [x, y] = inBand()
    move(x, y)
    tick(DOCK_WAKE_DWELL_MS - 40)
    move(x + 40, y - 1) // 仍在带内
    tick(40)
    expect(isHidden()).toBe(false)
  })
})

describe('自动隐藏:出窗即取消(去点系统 Dock,我们的不许跟着弹)', () => {
  it('⑥ 进带 → window blur → 到点不唤醒', () => {
    render(<AppShell />)
    move(...inBand())
    tick(DOCK_WAKE_DWELL_MS - 100)
    act(() => {
      fireEvent.blur(window)
    })
    tick(DOCK_WAKE_DWELL_MS * 3)
    expect(isHidden()).toBe(true)
  })

  it('⑦ 进带 → 指针移出文档(pointerleave)→ 不唤醒', () => {
    render(<AppShell />)
    move(...inBand())
    tick(DOCK_WAKE_DWELL_MS - 100)
    act(() => {
      fireEvent.pointerLeave(document)
    })
    tick(DOCK_WAKE_DWELL_MS * 3)
    expect(isHidden()).toBe(true)
  })

  it('⑧ 进带 → mouseout 且 relatedTarget 为 null → 不唤醒', () => {
    render(<AppShell />)
    move(...inBand())
    tick(DOCK_WAKE_DWELL_MS - 100)
    act(() => {
      fireEvent.mouseOut(document, { relatedTarget: null })
    })
    tick(DOCK_WAKE_DWELL_MS * 3)
    expect(isHidden()).toBe(true)
  })

  it('⑨ 进带 → 页面转入后台 → 不唤醒', () => {
    render(<AppShell />)
    move(...inBand())
    tick(DOCK_WAKE_DWELL_MS - 100)
    act(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
      fireEvent(document, new Event('visibilitychange'))
    })
    tick(DOCK_WAKE_DWELL_MS * 3)
    expect(isHidden()).toBe(true)
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  })

  it('⑩ 坐标越出视口(拖到系统 Dock 上)也算出窗', () => {
    render(<AppShell />)
    const [x, y] = inBand()
    move(x, y)
    tick(DOCK_WAKE_DWELL_MS - 100)
    move(x, window.innerHeight + 30)
    tick(DOCK_WAKE_DWELL_MS * 3)
    expect(isHidden()).toBe(true)
  })

  it('⑪ 已经出来之后出窗:走既有的 300ms 收回宽限,不是当场收', () => {
    render(<AppShell />)
    move(...inBand())
    tick(DOCK_WAKE_DWELL_MS)
    expect(isHidden()).toBe(false)
    act(() => {
      fireEvent.blur(window)
    })
    tick(DOCK_HIDE_DELAY_MS - 50)
    expect(isHidden()).toBe(false)
    tick(50)
    expect(isHidden()).toBe(true)
  })
})
