// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, defineComponent, h, nextTick, ref } from 'vue'
import {
  useDeferredAutoCollapse,
  intersectsScrollerViewport,
  resolveDeferredExpanded,
  resolveDeferredExpandedKeys,
  type DeferredAutoCollapseGate,
  type DeferredReleaseReason,
} from '../useDeferredAutoCollapse'
import { CHAT_FOLLOW_STATE_KEY } from '../useFollowScroll'
import { MockIntersectionObserver, verticalRect as domRect } from './intersection-observer-mock'

/** 一个 800px 高的滚动容器 + 一个几何可摆布的子元素。 */
function buildScrollerWith(elementTop: number, elementBottom: number) {
  const scroller = document.createElement('div')
  scroller.style.overflowY = 'auto'
  Object.defineProperty(scroller, 'scrollHeight', { value: 4000, configurable: true })
  Object.defineProperty(scroller, 'clientHeight', { value: 800, configurable: true })
  scroller.getBoundingClientRect = () => domRect(0, 800)

  const element = document.createElement('div')
  element.getBoundingClientRect = () => domRect(elementTop, elementBottom)
  scroller.appendChild(element)
  document.body.appendChild(scroller)

  return { scroller, element }
}

interface Harness {
  gate: DeferredAutoCollapseGate<string>
  deferred: string[]
  released: Array<[string, DeferredReleaseReason]>
  following: ReturnType<typeof ref<boolean>>
  unmount: () => void
}

/**
 * 真的挂一个组件:这样 inject / onUnmounted 走的都是生产路径。
 * `provideFollow: false` 模拟"挂在 MessageList 之外"。
 */
function mountGate(options: { following?: boolean; provideFollow?: boolean } = {}): Harness {
  const following = ref(options.following ?? false)
  const deferred: string[] = []
  const released: Array<[string, DeferredReleaseReason]> = []
  let gate!: DeferredAutoCollapseGate<string>

  const Host = defineComponent({
    setup() {
      gate = useDeferredAutoCollapse<string>({
        onDefer: key => void deferred.push(key),
        onRelease: (key, reason) => void released.push([key, reason]),
      })
      return () => h('div')
    },
  })

  const wrapper = mount(Host, {
    global: {
      provide: options.provideFollow === false
        ? {}
        : { [CHAT_FOLLOW_STATE_KEY as symbol]: computed(() => following.value) },
    },
  })

  return { gate, deferred, released, following, unmount: () => wrapper.unmount() }
}

beforeEach(() => {
  MockIntersectionObserver.reset()
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('intersectsScrollerViewport', () => {
  it('reads a fully-above / fully-below element as invisible', () => {
    const above = buildScrollerWith(-400, -10)
    expect(intersectsScrollerViewport(above.element, above.scroller)).toBe(false)

    const below = buildScrollerWith(820, 1200)
    expect(intersectsScrollerViewport(below.element, below.scroller)).toBe(false)
  })

  it('reads anything overlapping the viewport as visible', () => {
    const straddling = buildScrollerWith(-100, 120)
    expect(intersectsScrollerViewport(straddling.element, straddling.scroller)).toBe(true)

    const inside = buildScrollerWith(200, 500)
    expect(intersectsScrollerViewport(inside.element, inside.scroller)).toBe(true)
  })
})

describe('useDeferredAutoCollapse gate', () => {
  it('collapses immediately while the list is pinned to the bottom', () => {
    const harness = mountGate({ following: true })
    const { element } = buildScrollerWith(200, 500)

    expect(harness.gate.request('row', element)).toBe('collapse')
    expect(harness.deferred).toEqual([])
    expect(MockIntersectionObserver.instances).toHaveLength(0)
    harness.unmount()
  })

  it('collapses immediately when the element sits outside the viewport', () => {
    const harness = mountGate({ following: false })
    const above = buildScrollerWith(-600, -20)
    const below = buildScrollerWith(900, 1100)

    expect(harness.gate.request('above', above.element)).toBe('collapse')
    expect(harness.gate.request('below', below.element)).toBe('collapse')
    expect(harness.deferred).toEqual([])
    expect(MockIntersectionObserver.instances).toHaveLength(0)
    harness.unmount()
  })

  it('defers while the element is on screen and the user has left the bottom', () => {
    const harness = mountGate({ following: false })
    const { scroller, element } = buildScrollerWith(200, 500)

    expect(harness.gate.request('row', element)).toBe('defer')
    expect(harness.deferred).toEqual(['row'])
    expect(harness.gate.isPending('row')).toBe(true)
    // observer 懒创建,root 就是那个滚动容器。
    expect(MockIntersectionObserver.instances).toHaveLength(1)
    expect(MockIntersectionObserver.last.options?.root).toBe(scroller)
    expect(MockIntersectionObserver.last.targets).toEqual([element])
    harness.unmount()
  })

  it('does not re-register or re-notify a key that is already pending', () => {
    const harness = mountGate({ following: false })
    const { element } = buildScrollerWith(200, 500)

    expect(harness.gate.request('row', element)).toBe('defer')
    expect(harness.gate.request('row', element)).toBe('defer')
    expect(harness.deferred).toEqual(['row'])
    expect(MockIntersectionObserver.instances).toHaveLength(1)
    harness.unmount()
  })

  it('collapses a pending element once it scrolls out of the viewport', () => {
    const harness = mountGate({ following: false })
    const { element } = buildScrollerWith(200, 500)
    harness.gate.request('row', element)

    // 挂上的那一刻 IO 先报一次"还在视口里" —— 不能当成放行。
    MockIntersectionObserver.last.emit(true)
    expect(harness.released).toEqual([])
    expect(harness.gate.isPending('row')).toBe(true)

    MockIntersectionObserver.last.emit(false)
    expect(harness.released).toEqual([['row', 'collapse']])
    expect(harness.gate.isPending('row')).toBe(false)
    expect(MockIntersectionObserver.last.disconnected).toBe(true)
    harness.unmount()
  })

  it('collapses every pending element once the user is following the bottom again', async () => {
    const harness = mountGate({ following: false })
    const first = buildScrollerWith(200, 400)
    const second = buildScrollerWith(420, 600)
    harness.gate.request('a', first.element)
    harness.gate.request('b', second.element)
    expect(harness.gate.pendingKeys()).toEqual(['a', 'b'])

    harness.following.value = true
    await nextTick()

    expect(harness.released).toEqual([['a', 'collapse'], ['b', 'collapse']])
    expect(harness.gate.pendingKeys()).toEqual([])
    expect(MockIntersectionObserver.instances.every(o => o.disconnected)).toBe(true)
    harness.unmount()
  })

  it('cancels a pending collapse without collapsing (user intent wins)', () => {
    const harness = mountGate({ following: false })
    const { element } = buildScrollerWith(200, 500)
    harness.gate.request('row', element)

    harness.gate.cancel('row')

    expect(harness.released).toEqual([['row', 'cancel']])
    expect(harness.gate.isPending('row')).toBe(false)
    expect(MockIntersectionObserver.last.disconnected).toBe(true)

    // 断开之后再报一次也不会有第二次放行。
    MockIntersectionObserver.last.emit(false)
    expect(harness.released).toEqual([['row', 'cancel']])
    harness.unmount()
  })

  it('drops every pending collapse on unmount without executing it', () => {
    const harness = mountGate({ following: false })
    const { element } = buildScrollerWith(200, 500)
    harness.gate.request('row', element)

    harness.unmount()

    expect(MockIntersectionObserver.last.disconnected).toBe(true)
    expect(harness.released).toEqual([])
    expect(harness.gate.pendingKeys()).toEqual([])
  })

  it('degrades to an immediate collapse without IntersectionObserver', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const harness = mountGate({ following: false })
    const { element } = buildScrollerWith(200, 500)

    expect(harness.gate.request('row', element)).toBe('collapse')
    expect(harness.deferred).toEqual([])
    harness.unmount()
  })

  it('degrades to an immediate collapse when no follow state is provided', () => {
    // 非 MessageList 挂载点(侧栏之类):没有跟底状态就维持旧行为,不挂起。
    const harness = mountGate({ provideFollow: false })
    const { element } = buildScrollerWith(200, 500)

    expect(harness.gate.request('row', element)).toBe('collapse')
    expect(harness.deferred).toEqual([])
    harness.unmount()
  })

  it('collapses immediately when the element has no scroll container', () => {
    const harness = mountGate({ following: false })
    const orphan = document.createElement('div')
    document.body.appendChild(orphan)

    expect(harness.gate.request('row', orphan)).toBe('collapse')
    expect(harness.gate.request('missing', null)).toBe('collapse')
    harness.unmount()
  })
})

/**
 * 合成态(ProcessRail 与 StepsPanel 共用的那一份判定)。两种形态的差异是刻意
 * 保留的:单键形态里用户票压过挂起票,多键形态的 `base` 已经把 intent 揉进去,
 * 只剩 auto | deferred。
 */
describe('resolveDeferredExpanded', () => {
  it('用户 intent 一锤定音,挂起票掀不翻', () => {
    expect(resolveDeferredExpanded({ recorded: false, userToggled: null, auto: true, deferred: true })).toBe(false)
    expect(resolveDeferredExpanded({ recorded: true, userToggled: null, auto: false, deferred: false })).toBe(true)
  })

  it('没有 intent 记录时听本实例的 toggle', () => {
    expect(resolveDeferredExpanded({ recorded: undefined, userToggled: false, auto: true, deferred: true })).toBe(false)
    expect(resolveDeferredExpanded({ recorded: undefined, userToggled: true, auto: false, deferred: false })).toBe(true)
  })

  it('两票都缺席时 auto 与 deferred 取或', () => {
    expect(resolveDeferredExpanded({ recorded: undefined, userToggled: null, auto: false, deferred: false })).toBe(false)
    expect(resolveDeferredExpanded({ recorded: undefined, userToggled: null, auto: true, deferred: false })).toBe(true)
    expect(resolveDeferredExpanded({ recorded: undefined, userToggled: null, auto: false, deferred: true })).toBe(true)
  })
})

describe('resolveDeferredExpandedKeys', () => {
  it('undefined 原样透传 —— CollapseGroup 保持不受控', () => {
    expect(resolveDeferredExpandedKeys(undefined, ['a'])).toBeUndefined()
  })

  it('没有挂起时就是 auto 的结果集(保序)', () => {
    expect(resolveDeferredExpandedKeys(['a', 'b'], [])).toEqual(['a', 'b'])
  })

  it('挂起的 key 补在后面,已在集合里的不重复', () => {
    expect(resolveDeferredExpandedKeys(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c'])
  })
})
