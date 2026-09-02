import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, within } from '@testing-library/react'
import { AppShell } from '../AppShell'
import { useStageStore } from '../../stage/store'
import { initialStageState } from '../../stage/transitions'
import { TOOLTIP_DELAY_MS } from '../motion'

/**
 * Dock 上的悬停,以及**预览泡的退役守卫**(09-02 用户裁定「不需要这个功能了」)。
 *
 * 泡曾经是第二级悬停:600ms 长出一块只读活视图。这一整套(泡组件、跨瓦的
 * hover-intent 主角制、朝泡走的瞄准三角区、收拢宽限、自动隐藏的回身窗口、
 * `--preview-*` / `--dur-preview-*` 全套 token)已经删干净。
 *
 * 这一份用例是那次退役的守卫,不是「泡的行为」的用例:下面三条从前是
 * **副作用守卫**(泡在场时不许干的事),今天转正成**退役守卫**(这件事根本
 * 不该再发生)。把 DockTile 里那一行 600ms 计时器加回去,①③ 立刻红。
 *
 * 保留的是名字标签那一级(300ms,贴着瓦):它与泡是两件事,用户明说了留着。
 */
beforeEach(() => {
  vi.useFakeTimers()
  useStageStore.setState({ ...initialStageState, locale: 'zh' })
})

afterEach(() => {
  vi.useRealTimers()
})

/**
 * 悬停多久算「怎么等都不会有」。取 2000ms:旧泡的首开延迟是 600、瞄准窗口 400、
 * 收拢宽限 320,三者相加还有余量 —— 这个数刻意不去引任何 token,因为它守的正是
 * 「那些 token 一个都不该再存在」。
 */
const LONG_HOVER_MS = 2000

function tileOf(name: string): HTMLElement {
  const strip = document.querySelector('[data-dock="strip"]') as HTMLElement
  return within(strip).getByLabelText(name)
}

/** 悬停那块瓦(名字标签与从前的泡都长在 `.wrap` 上,所以进的是瓦的父层)。 */
function hover(name: string, ms: number) {
  fireEvent.mouseEnter(tileOf(name).parentElement as HTMLElement)
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

describe('Dock 悬停', () => {
  it('① 怎么悬停都不再长出预览泡', () => {
    render(<AppShell />)
    hover('文件', LONG_HOVER_MS)
    expect(document.querySelector('[data-preview]')).toBeNull()
  })

  it('② 名字标签仍然照出(300ms 那一级留着)', () => {
    render(<AppShell />)
    const strip = document.querySelector('[data-dock="strip"]') as HTMLElement
    hover('文件', TOOLTIP_DELAY_MS)
    // 标签是一段纯文本 span;瓦本身的名字在 aria-label 上,不在文本里。
    const labels = Array.from(strip.querySelectorAll('span')).filter((el) => el.textContent === '文件')
    expect(labels).toHaveLength(1)
  })

  it('②b 移开即散', () => {
    render(<AppShell />)
    const strip = document.querySelector('[data-dock="strip"]') as HTMLElement
    hover('文件', TOOLTIP_DELAY_MS)
    fireEvent.mouseLeave(tileOf('文件').parentElement as HTMLElement)
    expect(Array.from(strip.querySelectorAll('span')).filter((el) => el.textContent === '文件')).toHaveLength(0)
  })

  /**
   * ③ **副作用退役守卫**。泡里挂的是同一张 renderContent 表渲染出来的第二份内容,
   * 会话总览那一份从前会在 window 上再挂一份键盘监听 —— 悬停时方向键 / Esc 于是
   * 同时驱动两份同一个全局 store。泡没了,这条路从根上不存在了。
   *
   * 判据取 `defaultPrevented`:总览那条监听器进 ARROWS 分支时**无条件**
   * preventDefault,所以这一位与「有没有一份 ExposeView 在听」严格同步,
   * 不必先把会话数据摆好。对照组(真的摆出来那一份)同时钉住「别把该吃的也关掉」。
   */
  function pressArrowDown(): boolean {
    const event = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
    act(() => {
      window.dispatchEvent(event)
    })
    return event.defaultPrevented
  }

  it('③ 悬停会话总览不会把键盘拽走(泡的第二份监听随泡一起退役)', () => {
    render(<AppShell />)
    // 对照组:真的摆出来的那一份**该**吃方向键。
    act(() => useStageStore.getState().openAs('sessions', { kind: 'stage' }))
    expect(pressArrowDown()).toBe(true)

    // 收回坞里再怎么悬停:既没有第二份内容,方向键也没人吃。
    act(() => useStageStore.getState().closeToDock('sessions'))
    hover('会话总览', LONG_HOVER_MS)
    expect(document.querySelector('[data-preview]')).toBeNull()
    expect(pressArrowDown()).toBe(false)
  })
})

/**
 * Dock 的地标(09-02)。
 *
 * Dock 挂在 `<main>` **外面**(它是浮在整扇窗上的一条,不是主区里的一块),所以
 * 它画出来的东西——瓦、悬停名字条——从前落在**所有地标之外**,axe 的 region
 * 那条会红(病历见 scripts/gate-a11y-settle.mjs 里 PARK 的注释)。修法是给它一段
 * `<nav>` 加一个可读的名字,而不是把它塞进 `<main>`。
 */
describe('Dock 是一块导航地标', () => {
  it('条身落在带名字的 <nav> 里', () => {
    render(<AppShell />)
    const strip = document.querySelector('[data-dock="strip"]') as HTMLElement
    const landmark = strip.closest('nav')
    expect(landmark).toBeTruthy()
    expect(landmark?.getAttribute('aria-label')).toBe('应用坞')
  })
})
