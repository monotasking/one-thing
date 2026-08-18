/**
 * 浮层侧栏时序机(L4)。
 *
 * 钉的是**时序**,不是呈现:四段延迟各自该在什么时候把哪枚布尔翻过去,以及
 * "冷却窗内 hover 不勾浮层"这条防抖规则 —— 它们从前散在 App.vue 的四个裸
 * timer 里,谁也测不到。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FLOATING_CLOSE_COOLDOWN_MS,
  FLOATING_CLOSE_DURATION_MS,
  FLOATING_SHOW_DELAY_MS,
  SIDEBAR_TOGGLE_COOLDOWN_MS,
  useFloatingSidebar,
} from '../useFloatingSidebar'

describe('useFloatingSidebar', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('hover 进触发区要等满延迟才勾出浮层', () => {
    const sidebar = useFloatingSidebar()

    sidebar.triggerEnter()
    expect(sidebar.floating.value).toBe(false)

    vi.advanceTimersByTime(FLOATING_SHOW_DELAY_MS - 1)
    expect(sidebar.floating.value).toBe(false)

    vi.advanceTimersByTime(1)
    expect(sidebar.floating.value).toBe(true)
    // 浮层进场自己带动画,侧栏那条宽度过渡这一路要压住。
    expect(sidebar.noTransition.value).toBe(true)

    sidebar.dispose()
  })

  it('延迟内离开触发区 = 这一次不勾(扫过左缘不该把侧栏带出来)', () => {
    const sidebar = useFloatingSidebar()

    sidebar.triggerEnter()
    vi.advanceTimersByTime(FLOATING_SHOW_DELAY_MS - 1)
    sidebar.triggerLeave()
    vi.advanceTimersByTime(FLOATING_SHOW_DELAY_MS * 4)

    expect(sidebar.floating.value).toBe(false)
    sidebar.dispose()
  })

  it('关闭走两段:动画时长里仍是浮层态,之后才解开过渡与冷却', () => {
    const sidebar = useFloatingSidebar()

    sidebar.triggerEnter()
    vi.advanceTimersByTime(FLOATING_SHOW_DELAY_MS)
    sidebar.close()

    expect(sidebar.closing.value).toBe(true)
    expect(sidebar.floating.value).toBe(true)
    expect(sidebar.cooldown.value).toBe(true)

    vi.advanceTimersByTime(FLOATING_CLOSE_DURATION_MS)
    expect(sidebar.floating.value).toBe(false)
    expect(sidebar.closing.value).toBe(false)
    // 动画落地后过渡仍压着,免得侧栏落回停靠位时闪一下。
    expect(sidebar.noTransition.value).toBe(true)
    expect(sidebar.cooldown.value).toBe(true)

    vi.advanceTimersByTime(FLOATING_CLOSE_COOLDOWN_MS)
    expect(sidebar.noTransition.value).toBe(false)
    expect(sidebar.cooldown.value).toBe(false)

    sidebar.dispose()
  })

  it('关闭动画期间鼠标回到浮层上 = 撤销关闭', () => {
    const sidebar = useFloatingSidebar()

    sidebar.triggerEnter()
    vi.advanceTimersByTime(FLOATING_SHOW_DELAY_MS)
    sidebar.close()
    sidebar.keepOpen()

    expect(sidebar.closing.value).toBe(false)
    expect(sidebar.floating.value).toBe(true)

    // 关闭那两段 timer 都撤了 —— 时间推到底浮层也不该自己掉下去。
    vi.advanceTimersByTime(FLOATING_CLOSE_DURATION_MS + FLOATING_CLOSE_COOLDOWN_MS)
    expect(sidebar.floating.value).toBe(true)

    sidebar.dispose()
  })

  it('toggle 之后的冷却窗内 hover 不勾浮层', () => {
    const sidebar = useFloatingSidebar()

    sidebar.notifyToggled()
    expect(sidebar.actionAnimating.value).toBe(true)
    expect(sidebar.cooldown.value).toBe(true)

    sidebar.triggerEnter()
    vi.advanceTimersByTime(SIDEBAR_TOGGLE_COOLDOWN_MS - 1)
    expect(sidebar.floating.value).toBe(false)

    vi.advanceTimersByTime(1)
    expect(sidebar.actionAnimating.value).toBe(false)
    expect(sidebar.cooldown.value).toBe(false)

    // 冷却结束后再 hover 才算数。
    sidebar.triggerEnter()
    vi.advanceTimersByTime(FLOATING_SHOW_DELAY_MS)
    expect(sidebar.floating.value).toBe(true)

    sidebar.dispose()
  })

  it('侧栏回停靠位时 reset 收摊浮层,但不撤 toggle 的动画窗口', () => {
    const sidebar = useFloatingSidebar()

    sidebar.notifyToggled()
    sidebar.triggerEnter()
    sidebar.reset()

    expect(sidebar.floating.value).toBe(false)
    expect(sidebar.closing.value).toBe(false)
    // 折叠动画还在跑:顶栏留位/布局测量都靠它,不能被浮层这一摊顺手关掉。
    expect(sidebar.actionAnimating.value).toBe(true)

    // reset 撤掉了待展开的那一次延迟。
    vi.advanceTimersByTime(FLOATING_SHOW_DELAY_MS)
    expect(sidebar.floating.value).toBe(false)

    vi.advanceTimersByTime(SIDEBAR_TOGGLE_COOLDOWN_MS)
    expect(sidebar.actionAnimating.value).toBe(false)

    sidebar.dispose()
  })

  it('dispose 之后没有 timer 还在跑', () => {
    const sidebar = useFloatingSidebar()

    sidebar.triggerEnter()
    sidebar.notifyToggled()
    sidebar.dispose()

    expect(vi.getTimerCount()).toBe(0)
  })
})
