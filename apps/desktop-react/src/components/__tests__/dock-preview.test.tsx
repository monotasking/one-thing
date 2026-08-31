import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, within } from '@testing-library/react'
import { AppShell } from '../AppShell'
import { useStageStore } from '../../stage/store'
import { initialStageState } from '../../stage/transitions'
import { PREVIEW_DELAY_MS, PREVIEW_GRACE_MS } from '../motion'
import type { Placement } from '../../stage/types'

/**
 * 预览泡出现的**条件**,不是它长什么样:泡是「还没打开的东西给你的一眼」,
 * 所以已经看得见的项不该再出泡。判据只有一条「它还收在坞里吗」——
 * 去接管化之后会话总览也按这一条判,没有第二种瓦。
 * 延迟是 token 的镜像,所以这里用假时钟走完 PREVIEW_DELAY_MS 而不是真等 600ms。
 */
beforeEach(() => {
  vi.useFakeTimers()
  useStageStore.setState({ ...initialStageState, locale: 'zh' })
})

afterEach(() => {
  vi.useRealTimers()
})

/**
 * 悬停坞里的那一块瓦,并把假时钟推过预览延迟。
 * 必须限定在坞条内 —— 同一块内容开在舞台/浮窗里时,那扇面也叫同一个名字。
 */
function hoverTile(name: string) {
  const strip = document.querySelector('[data-dock="strip"]') as HTMLElement
  const tile = within(strip).getByLabelText(name)
  fireEvent.mouseEnter(tile.parentElement as HTMLElement)
  act(() => {
    vi.advanceTimersByTime(PREVIEW_DELAY_MS)
  })
}

function place(id: string, placement: Placement) {
  act(() => useStageStore.getState().openAs(id, placement))
}

describe('Dock 预览泡', () => {
  it('还收在坞里的:悬停到时长就出泡,内容走同一张 renderContent 表', () => {
    render(<AppShell />)
    hoverTile('文件')
    expect(document.querySelector('[data-preview="files"]')).toBeTruthy()
  })

  it('已经看得见的不出泡(打开着的东西不必再给一眼)', () => {
    render(<AppShell />)
    place('files', { kind: 'edge', side: 'right' })
    hoverTile('文件')
    expect(document.querySelector('[data-preview="files"]')).toBeNull()
    place('diff', { kind: 'stage' })
    hoverTile('改动')
    expect(document.querySelector('[data-preview="diff"]')).toBeNull()
  })

  it('会话总览照常出泡:它是普通瓦,判据仍是「还收在坞里吗」', () => {
    render(<AppShell />)
    hoverTile('会话总览')
    expect(document.querySelector('[data-preview="sessions"]')).toBeTruthy()
    place('sessions', { kind: 'stage' })
    hoverTile('会话总览')
    expect(document.querySelector('[data-preview="sessions"]')).toBeNull()
  })

  /**
   * 泡里那一份是**惰性只读**的:它渲染(所以「预览与真的打开之后一致」成立),
   * 但不许占用全局输入。08-30 之前不是这样 —— 悬停会话总览时,泡里那一份 ExposeView
   * 也在 window 上挂了一份键盘监听,于是方向键 / Esc 同时驱动两份同一个全局 store。
   * 「泡不吃指针」拦不住这个:pointer-events 管不到键盘。
   *
   * 判据取 `defaultPrevented` 而不是 store 的某个字段:那条监听器进 ARROWS 分支时
   * **无条件** preventDefault,所以这一位与「有没有一份 ExposeView 在听」严格同步,
   * 不必先把会话数据摆好。对照组(真的摆出来那一份)同时钉住「别把该吃的也一起关掉」。
   */
  function pressArrowDown(): boolean {
    const event = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
    act(() => {
      window.dispatchEvent(event)
    })
    return event.defaultPrevented
  }

  it('泡里那一份不挂全局键盘监听(悬停看一眼 ≠ 把键盘也接过去)', () => {
    render(<AppShell />)
    // 对照组:真的摆出来的那一份**该**吃方向键。
    place('sessions', { kind: 'stage' })
    expect(pressArrowDown()).toBe(true)

    // 收回坞里,只剩悬停那一眼:同一块内容照样渲染,方向键却不再被它吃掉。
    act(() => useStageStore.getState().closeToDock('sessions'))
    hoverTile('会话总览')
    expect(document.querySelector('[data-preview="sessions"]')).toBeTruthy()
    expect(pressArrowDown()).toBe(false)
  })

  it('一次一个主角:泡出现时名字标签隐掉', () => {
    render(<AppShell />)
    hoverTile('文件')
    expect(document.querySelector('[data-preview="files"]')).toBeTruthy()
    // 标签是一段纯文本节点,泡里那句标题在 [data-preview] 里面;泡外不该再有第二处。
    const outside = Array.from(document.querySelectorAll('span')).filter(
      (el) => el.textContent === '文件' && !el.closest('[data-preview]'),
    )
    expect(outside).toHaveLength(0)
  })

  /* ── 08-31:移向泡的那条路 ─────────────────────────────────────────────
   * 报障原话「预览泡移入即消失」。真机量出的修前行为:泡浮在瓦上方
   * --preview-lift(12px)处,而**指针离开瓦 3px 泡就没了** —— 那 12px 缝
   * 既不属于瓦也不属于泡,人根本够不到它。两条修法各钉一条:
   *  ① 离开只是排一个宽限,再进即取消(下面三条);
   *  ② 泡吃指针且点得动(最后两条)—— 修前它整块 pointer-events:none,
   *     那等于「这块泡永远碰不到」。
   * ────────────────────────────────────────────────────────────────── */
  function wrapOf(name: string): HTMLElement {
    const strip = document.querySelector('[data-dock="strip"]') as HTMLElement
    return within(strip).getByLabelText(name).parentElement as HTMLElement
  }

  it('离开瓦不当场收 —— 宽限没走完之前泡还在(那正是走过去要花的时间)', () => {
    render(<AppShell />)
    hoverTile('文件')
    fireEvent.mouseLeave(wrapOf('文件'))
    act(() => void vi.advanceTimersByTime(PREVIEW_GRACE_MS - 1))
    expect(document.querySelector('[data-preview="files"]')).toBeTruthy()
  })

  it('宽限走完还没回来才收', () => {
    render(<AppShell />)
    hoverTile('文件')
    fireEvent.mouseLeave(wrapOf('文件'))
    act(() => void vi.advanceTimersByTime(PREVIEW_GRACE_MS))
    expect(document.querySelector('[data-preview="files"]')).toBeNull()
  })

  it('半路回到泡上就取消收拢,而且**不重新长一遍**(600ms 不再数一次)', () => {
    render(<AppShell />)
    hoverTile('文件')
    fireEvent.mouseLeave(wrapOf('文件'))
    act(() => void vi.advanceTimersByTime(PREVIEW_GRACE_MS - 10))
    // 泡是 .wrap 的后代,所以「进泡」本身就是这一层的 mouseEnter。
    fireEvent.mouseEnter(wrapOf('文件'))
    act(() => void vi.advanceTimersByTime(PREVIEW_GRACE_MS * 2))
    expect(document.querySelector('[data-preview="files"]')).toBeTruthy()
  })

  it('泡点得动:点它 = 点那块瓦(按它自己的打开方式开)', () => {
    render(<AppShell />)
    hoverTile('文件')
    const bubble = document.querySelector('[data-preview="files"]') as HTMLElement
    act(() => void fireEvent.click(bubble))
    expect(useStageStore.getState().placements.files).toBeTruthy()
  })

  it('泡仍然 aria-hidden,而且不可聚焦 —— 键盘那条路走的是瓦上那颗真按钮', () => {
    render(<AppShell />)
    hoverTile('文件')
    const bubble = document.querySelector('[data-preview="files"]') as HTMLElement
    expect(bubble.getAttribute('aria-hidden')).toBe('true')
    // aria-hidden 里出现可聚焦元素才是真的 a11y 违例(axe: aria-hidden-focus)。
    expect(bubble.hasAttribute('tabindex')).toBe(false)
    expect(bubble.getAttribute('role')).toBeNull()
  })
})
