import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { FloatLayer } from '../FloatWindow'
import { useStageStore } from '../../stage/store'
import { initialStageState } from '../../stage/transitions'
import { EXIT_MS } from '../motion'

/**
 * ── 08-30 用户报障:关浮窗会闪 ────────────────────────────────────────────
 * 「点关闭,消失了,又弹出来一次,然后才消失。」
 *
 * 真因是出场动画的实现形状:旧写法在 effect 里检测离场(晚一个提交 ——
 * order 丢掉 id 的那一帧真窗已卸载),再用 `leaving-${id}` 这个**新 key**
 * 挂一份副本播出场 —— 三拍正好是 卸载 / 副本挂载 / 副本卸载,而且副本是
 * 整棵内容(会话总览那样的重面板)白白重挂一遍。
 *
 * 修后契约(这组测试逐条钉):离场检测在渲染期同步发生、离场窗与在场窗共用
 * 同一个 key —— 关闭那一刻起**同一个 DOM 节点**连续在场,只是换上 leaving
 * 动画,到点(EXIT_MS)才真正卸载。修前第一条必红(节点在关闭的提交里就断连)。
 */
describe('FloatLayer 出场:同一实例连续在场,不闪', () => {
  beforeEach(() => {
    useStageStore.setState({ ...initialStageState, locale: 'zh' })
  })

  const win = (host: HTMLElement) => host.querySelector('section')

  it('关闭那一刻同一个 DOM 节点仍在场(带 leaving 动画),EXIT_MS 后才卸载', () => {
    vi.useFakeTimers()
    try {
      const { container } = render(<FloatLayer />)
      act(() => useStageStore.getState().openAs('files', { kind: 'float' }))
      const node = win(container)
      expect(node).toBeTruthy()

      act(() => useStageStore.getState().closeToDock('files'))
      // 关键断言:不是「有一个窗」,是「还是原来那个节点」—— 副本式实现过不了这条。
      expect(win(container)).toBe(node)
      expect(node!.isConnected).toBe(true)
      expect(node!.className).toContain('leaving')

      act(() => void vi.advanceTimersByTime(EXIT_MS + 10))
      expect(win(container)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('离场途中又被打开:还是同一个节点,leaving 摘掉,不重挂', () => {
    vi.useFakeTimers()
    try {
      const { container } = render(<FloatLayer />)
      act(() => useStageStore.getState().openAs('files', { kind: 'float' }))
      const node = win(container)

      act(() => useStageStore.getState().closeToDock('files'))
      act(() => useStageStore.getState().openAs('files', { kind: 'float' }))
      expect(win(container)).toBe(node)
      expect(node!.className).not.toContain('leaving')

      // 到点后它也不该被误清 —— 它已经不在离场名单里了。
      act(() => void vi.advanceTimersByTime(EXIT_MS + 10))
      expect(win(container)).toBe(node)
      expect(node!.isConnected).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('两扇窗关一扇:另一扇不掉、不换节点', () => {
    vi.useFakeTimers()
    try {
      const { container } = render(<FloatLayer />)
      act(() => useStageStore.getState().openAs('files', { kind: 'float' }))
      act(() => useStageStore.getState().openAs('diff', { kind: 'float' }))
      const both = container.querySelectorAll('section')
      expect(both.length).toBe(2)

      act(() => useStageStore.getState().closeToDock('files'))
      act(() => void vi.advanceTimersByTime(EXIT_MS + 10))
      const rest = container.querySelectorAll('section')
      expect(rest.length).toBe(1)
      expect(rest[0]).toBe(both[1])
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * ── 动效档「无」:关掉就是当场没有 ────────────────────────────────────────
 *
 * 上面那三条钉的是「有出场动画时不许闪」。这一条钉的是反面:用户把动效调到
 * 「无」之后,那 120ms 的空壳**一帧都不该留** —— 选「无」的人要的正是
 * 「点了关闭,它就不在了」。
 *
 * 判据里没有假时钟,这是刻意的:排一个 0ms 的定时器也能让节点最终消失,但那要
 * 多等一个宏任务;这条门要的是**同一次提交里就没有它**,所以它压根不进离场名单
 * (实现见 FloatWindow.tsx 的渲染期派生,以及 components/motion.ts 的 exitMs)。
 * 修前必红:旧写法无条件把它挂进 leaving 并排一个 120ms 的定时器。
 */
describe('动效档「无」:关浮窗立即卸载,不留 120ms 的空壳', () => {
  beforeEach(() => {
    useStageStore.setState({ ...initialStageState, locale: 'zh' })
  })

  afterEach(() => {
    document.documentElement.removeAttribute('data-motion-tier')
  })

  it('关掉的那一次提交里,节点就已经不在了(没有假时钟,没有等待)', () => {
    document.documentElement.setAttribute('data-motion-tier', 'none')
    const { container } = render(<FloatLayer />)
    act(() => useStageStore.getState().openAs('files', { kind: 'float' }))
    expect(container.querySelector('section')).toBeTruthy()

    act(() => useStageStore.getState().closeToDock('files'))
    expect(container.querySelector('section')).toBeNull()
  })

  it('standard 档下照旧留着播出场 —— 这条是上面那条的对照组', () => {
    document.documentElement.setAttribute('data-motion-tier', 'standard')
    const { container } = render(<FloatLayer />)
    act(() => useStageStore.getState().openAs('files', { kind: 'float' }))
    act(() => useStageStore.getState().closeToDock('files'))
    expect(container.querySelector('section')).toBeTruthy()
    expect(container.querySelector('section')!.className).toContain('leaving')
  })
})
