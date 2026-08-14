// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, nextTick, defineComponent, ref } from 'vue'
import ProcessRail from '../message/ProcessRail.vue'
import { clearExpansionIntents } from '@/stores/helpers/expansion-intent'
import { CHAT_FOLLOW_STATE_KEY } from '@/composables/useFollowScroll'
import {
  MockIntersectionObserver,
  verticalRect,
} from '@/composables/__tests__/intersection-observer-mock'

// Stand-in for anything inside the rail that owns expansion state
// (StepsPanel / CollapseGroup / inline reasoning panel).
const StatefulChild = defineComponent({
  setup: () => ({ expanded: ref(false) }),
  template: `<div class="child" :class="{ 'is-expanded': expanded }" @click="expanded = !expanded">child</div>`,
})

function mountRail(streaming: boolean, solo = false) {
  return mount(ProcessRail, {
    props: { summary: '3 steps', streaming, solo },
    slots: { default: StatefulChild },
  })
}

const isOpen = (w: ReturnType<typeof mountRail>) =>
  w.find('.process-rail').classes().includes('is-open')

describe('ProcessRail expansion', () => {
  it('auto-opens while streaming and auto-collapses once settled', async () => {
    const w = mountRail(true)
    await nextTick()
    expect(isOpen(w)).toBe(true)

    await w.setProps({ streaming: false })
    await nextTick()
    expect(isOpen(w)).toBe(false)
  })

  it('keeps a manual toggle across the stream boundary', async () => {
    const w = mountRail(true)
    await nextTick()

    // user closes it mid-stream — must stay closed while still streaming
    await w.find('.process-rail-header').trigger('click')
    await nextTick()
    expect(isOpen(w)).toBe(false)

    // ...and must stay closed after the stream ends
    await w.setProps({ streaming: false })
    await nextTick()
    expect(isOpen(w)).toBe(false)
  })

  it('does not auto-collapse a rail the user explicitly opened mid-stream', async () => {
    const w = mountRail(true)
    await nextTick()
    await w.find('.process-rail-header').trigger('click') // close
    await w.find('.process-rail-header').trigger('click') // reopen explicitly
    await nextTick()
    expect(isOpen(w)).toBe(true)

    await w.setProps({ streaming: false })
    await nextTick()
    expect(isOpen(w)).toBe(true)
  })

  it('preserves inner expansion state when the rail auto-collapses and is reopened', async () => {
    const w = mountRail(true)
    await nextTick()

    // user expands a tool call inside the rail while it streams
    await w.find('.child').trigger('click')
    await nextTick()
    expect(w.find('.child').classes()).toContain('is-expanded')

    // stream ends -> rail auto-collapses (body hidden, not destroyed)
    await w.setProps({ streaming: false })
    await nextTick()
    expect(isOpen(w)).toBe(false)

    // reopening restores exactly what the user left open
    await w.find('.process-rail-header').trigger('click')
    await nextTick()
    expect(w.find('.child').classes()).toContain('is-expanded')
  })

  it('does not mount the body for a rail that never opened', async () => {
    const w = mountRail(false)
    await nextTick()
    expect(w.find('.process-rail-body').exists()).toBe(false)
    expect(w.find('.child').exists()).toBe(false)
  })

  it('always shows the body in solo mode', async () => {
    const w = mountRail(false, true)
    await nextTick()
    expect(w.find('.process-rail-header').exists()).toBe(false)
    expect(w.find('.child').isVisible()).toBe(true)
  })
})

// The local ref alone cannot survive a remount, and remounts are exactly what
// the streaming keys used to produce. These pin the three-tier priority:
// user record > live auto-open > collapsed.
describe('ProcessRail expansion intent', () => {
  beforeEach(() => {
    clearExpansionIntents()
  })

  function mountKeyedRail(intentKey: string, streaming = true) {
    return mount(ProcessRail, {
      props: { summary: '3 steps', streaming, solo: false, intentKey },
      slots: { default: StatefulChild },
    })
  }

  it('restores a recorded collapse on a fresh instance', async () => {
    const first = mountKeyedRail('rail-m1-process-steps-1')
    await nextTick()
    await first.find('.process-rail-header').trigger('click')
    expect(isOpen(first)).toBe(false)
    first.unmount()

    // A key change gives a brand-new instance with an empty local ref; only
    // the record can tell it the user had closed this rail.
    const remounted = mountKeyedRail('rail-m1-process-steps-1')
    await nextTick()
    expect(isOpen(remounted)).toBe(false)
  })

  it('restores a recorded expand even after the stream settles', async () => {
    const first = mountKeyedRail('rail-m1-process-steps-1')
    await nextTick()
    await first.find('.process-rail-header').trigger('click') // close
    await first.find('.process-rail-header').trigger('click') // explicit reopen
    expect(isOpen(first)).toBe(true)
    first.unmount()

    const settled = mountKeyedRail('rail-m1-process-steps-1', false)
    await nextTick()
    expect(isOpen(settled)).toBe(true)
  })

  it('scopes records per key — another rail keeps the streaming default', async () => {
    const first = mountKeyedRail('rail-m1-process-steps-1')
    await nextTick()
    await first.find('.process-rail-header').trigger('click')
    first.unmount()

    const other = mountKeyedRail('rail-m1-process-steps-2')
    await nextTick()
    expect(isOpen(other)).toBe(true)
  })

  it('leaves an unkeyed rail on purely local state', async () => {
    const keyed = mountKeyedRail('rail-m1-process-steps-1')
    await nextTick()
    await keyed.find('.process-rail-header').trigger('click')
    keyed.unmount()

    const unkeyed = mountRail(true)
    await nextTick()
    expect(isOpen(unkeyed)).toBe(true)
  })
})

// 流结束时整条 rail 塌成一行 summary。用户读的是 rail **下方**流出的正文,
// 塌缩必须把差值还给 scrollTop,否则正文猛地上移 —— 阅读位置就丢了。
// 用户自己点收起不补偿:那是主动行为。
describe('ProcessRail auto-collapse scroll compensation', () => {
  const RAIL_TOP = -320
  const RAIL_OPEN_BOTTOM = -20
  const RAIL_FOLDED_BOTTOM = -296 // 300px 的 rail 折成 24px 一行

  function rect(top: number, bottom: number): DOMRect {
    return {
      top,
      bottom,
      left: 0,
      right: 0,
      width: 0,
      height: bottom - top,
      x: 0,
      y: top,
      toJSON: () => ({}),
    } as DOMRect
  }

  function setupRail(options: { scrollTop?: number } = {}) {
    let scrollTop = options.scrollTop ?? 900

    const scroller = document.createElement('div')
    scroller.style.overflowY = 'auto'
    Object.defineProperty(scroller, 'scrollHeight', { value: 4000, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 800, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (next: number) => {
        scrollTop = next
      },
    })
    scroller.getBoundingClientRect = () => rect(0, 800)

    const host = document.createElement('div')
    scroller.appendChild(host)
    document.body.appendChild(scroller)

    const wrapper = mount(ProcessRail, {
      props: { summary: '3 steps', streaming: true, solo: false, intentKey: 'rail-compensation' },
      slots: { default: StatefulChild },
      attachTo: host,
    })

    // 高度跟着**真实 DOM 状态**走:展开 300px,折起 24px。这样"塌缩前量一次、
    // 塌缩后再量一次"在测试里也是真的两次不同读数,而不是手动摆出来的。
    const railElement = wrapper.element as HTMLElement
    railElement.getBoundingClientRect = () =>
      rect(RAIL_TOP, railElement.classList.contains('is-open') ? RAIL_OPEN_BOTTOM : RAIL_FOLDED_BOTTOM)

    return {
      wrapper,
      getScrollTop: () => scrollTop,
      cleanup: () => {
        wrapper.unmount()
        scroller.remove()
      },
    }
  }

  beforeEach(() => {
    clearExpansionIntents()
    document.body.innerHTML = ''
  })

  it('gives back the collapsed height when the stream settles above the viewport', async () => {
    const rail = setupRail()
    await nextTick()
    expect(isOpen(rail.wrapper)).toBe(true)

    // The pre-flush watcher measures the OPEN rail, the DOM then folds.
    await rail.wrapper.setProps({ streaming: false })
    await nextTick()
    await nextTick()

    expect(isOpen(rail.wrapper)).toBe(false)
    expect(rail.getScrollTop()).toBe(900 - 276)
    rail.cleanup()
  })

  it('does not compensate a collapse the user asked for', async () => {
    const rail = setupRail()
    await nextTick()

    await rail.wrapper.find('.process-rail-header').trigger('click')
    await nextTick()
    await nextTick()

    expect(isOpen(rail.wrapper)).toBe(false)
    expect(rail.getScrollTop()).toBe(900)
    rail.cleanup()
  })

  it('leaves a follower parked at the bottom alone', async () => {
    // scrollHeight 4000 - clientHeight 800 = 3200 → 贴底,交给跟底逻辑。
    const rail = setupRail({ scrollTop: 3200 })
    await nextTick()

    await rail.wrapper.setProps({ streaming: false })
    await nextTick()
    await nextTick()

    expect(rail.getScrollTop()).toBe(3200)
    rail.cleanup()
  })
})

// 补偿只覆盖"塌缩在视口顶之上"。用户真正丢内容的场景是元素**就在眼前**:
// 正读着 rail 里的输出,流一结束它自己折了。那时候不该收 —— 先挂起。
describe('ProcessRail auto-collapse visibility gate', () => {
  // 展开时整条在视口里(200..500),折起后 200..224。
  const RAIL_TOP = 200
  const RAIL_OPEN_BOTTOM = 500
  const RAIL_FOLDED_BOTTOM = 224

  function setupVisibleRail(options: { following?: boolean } = {}) {
    const following = ref(options.following ?? false)

    const scroller = document.createElement('div')
    scroller.style.overflowY = 'auto'
    Object.defineProperty(scroller, 'scrollHeight', { value: 4000, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 800, configurable: true })
    scroller.getBoundingClientRect = () => verticalRect(0, 800)

    const host = document.createElement('div')
    scroller.appendChild(host)
    document.body.appendChild(scroller)

    const wrapper = mount(ProcessRail, {
      props: { summary: '3 steps', streaming: true, solo: false, intentKey: 'rail-gate' },
      slots: { default: StatefulChild },
      attachTo: host,
      global: {
        provide: { [CHAT_FOLLOW_STATE_KEY as symbol]: computed(() => following.value) },
      },
    })

    const railElement = wrapper.element as HTMLElement
    railElement.getBoundingClientRect = () =>
      verticalRect(
        RAIL_TOP,
        railElement.classList.contains('is-open') ? RAIL_OPEN_BOTTOM : RAIL_FOLDED_BOTTOM,
      )

    return {
      wrapper,
      following,
      cleanup: () => {
        wrapper.unmount()
        scroller.remove()
      },
    }
  }

  beforeEach(() => {
    clearExpansionIntents()
    MockIntersectionObserver.reset()
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('stays open when the stream settles while the user is looking at it', async () => {
    const rail = setupVisibleRail()
    await nextTick()

    await rail.wrapper.setProps({ streaming: false })
    await nextTick()

    expect(isOpen(rail.wrapper)).toBe(true)
    expect(MockIntersectionObserver.instances).toHaveLength(1)
    rail.cleanup()
  })

  it('collapses once the rail scrolls out of the viewport', async () => {
    const rail = setupVisibleRail()
    await nextTick()
    await rail.wrapper.setProps({ streaming: false })
    await nextTick()
    expect(isOpen(rail.wrapper)).toBe(true)

    MockIntersectionObserver.last.emit(false)
    await nextTick()

    expect(isOpen(rail.wrapper)).toBe(false)
    expect(MockIntersectionObserver.allDisconnected()).toBe(true)
    rail.cleanup()
  })

  it('collapses once the user is pinned to the bottom again', async () => {
    const rail = setupVisibleRail()
    await nextTick()
    await rail.wrapper.setProps({ streaming: false })
    await nextTick()
    expect(isOpen(rail.wrapper)).toBe(true)

    rail.following.value = true
    await nextTick()

    expect(isOpen(rail.wrapper)).toBe(false)
    expect(MockIntersectionObserver.allDisconnected()).toBe(true)
    rail.cleanup()
  })

  it('collapses immediately while following the bottom — the gate never engages', async () => {
    const rail = setupVisibleRail({ following: true })
    await nextTick()

    await rail.wrapper.setProps({ streaming: false })
    await nextTick()

    expect(isOpen(rail.wrapper)).toBe(false)
    expect(MockIntersectionObserver.instances).toHaveLength(0)
    rail.cleanup()
  })

  it('lets a manual toggle cancel the pending collapse', async () => {
    const rail = setupVisibleRail()
    await nextTick()
    await rail.wrapper.setProps({ streaming: false })
    await nextTick()
    expect(isOpen(rail.wrapper)).toBe(true)

    await rail.wrapper.find('.process-rail-header').trigger('click')
    await nextTick()

    expect(isOpen(rail.wrapper)).toBe(false)
    expect(MockIntersectionObserver.allDisconnected()).toBe(true)

    // 挂起已作废:再报一次"滚出视口"不该有任何影响,用户重新展开就是展开。
    MockIntersectionObserver.last.emit(false)
    await rail.wrapper.find('.process-rail-header').trigger('click')
    await nextTick()
    expect(isOpen(rail.wrapper)).toBe(true)
    rail.cleanup()
  })

  it('cancels the pending collapse when a new stream re-opens the rail', async () => {
    const rail = setupVisibleRail()
    await nextTick()
    await rail.wrapper.setProps({ streaming: false })
    await nextTick()
    expect(isOpen(rail.wrapper)).toBe(true)

    await rail.wrapper.setProps({ streaming: true })
    await nextTick()
    expect(isOpen(rail.wrapper)).toBe(true)
    expect(MockIntersectionObserver.allDisconnected()).toBe(true)

    // 陈旧的 observer 回调不得把新一轮的 rail 折了。
    MockIntersectionObserver.last.emit(false)
    await nextTick()
    expect(isOpen(rail.wrapper)).toBe(true)

    // 新一轮结束时重新问门 —— 又是一次全新的挂起。
    await rail.wrapper.setProps({ streaming: false })
    await nextTick()
    expect(isOpen(rail.wrapper)).toBe(true)
    expect(MockIntersectionObserver.instances).toHaveLength(2)
    rail.cleanup()
  })

  it('drops the pending collapse on unmount', async () => {
    const rail = setupVisibleRail()
    await nextTick()
    await rail.wrapper.setProps({ streaming: false })
    await nextTick()
    expect(MockIntersectionObserver.instances).toHaveLength(1)

    rail.cleanup()

    expect(MockIntersectionObserver.allDisconnected()).toBe(true)
  })
})
