/**
 * Native chat follow scrolling.
 *
 * "Following" has one source of truth: the browser's natural scroll bottom
 * (`scrollHeight - clientHeight`). Visual space above the composer is real
 * tail padding in the message list, not an artificial anchor correction.
 */

import {
  computed,
  getCurrentInstance,
  inject,
  nextTick,
  onUnmounted,
  provide,
  ref,
  watch,
  type ComputedRef,
  type InjectionKey,
  type Ref,
} from 'vue'
import { isTraceEnabled, traceEvent } from '@/utils/stream-scroll-trace'

export const FOLLOW_BOTTOM_GAP = 64

/**
 * 跟底状态的只读出口。
 *
 * 跟底这件事只有消息列表知道(useFollowScroll 的实例在 MessageList 里),但
 * 子树深处的自动收起需要它来判断"现在收会不会挪走用户眼前的东西"
 * (见 `useDeferredAutoCollapse`)。所以 MessageList provide 一个**只读**的
 * ComputedRef,子组件 inject。
 *
 * 拿不到时(挂在 MessageList 之外,比如侧栏预览)按 `true` 处理 —— 维持旧行为,
 * 而不是让非消息流的挂载点跟着改表现。
 */
export const CHAT_FOLLOW_STATE_KEY: InjectionKey<ComputedRef<boolean>> =
  Symbol('onething:chat-follow-state')

/** 在消息列表侧提供跟底状态(只读投影,子树改不动它)。 */
export function provideChatFollowState(isFollowing: Ref<boolean>): void {
  provide(CHAT_FOLLOW_STATE_KEY, computed(() => isFollowing.value))
}

/** 子树侧读取跟底状态;不在消息列表下时返回 null。 */
export function useChatFollowState(): ComputedRef<boolean> | null {
  return inject(CHAT_FOLLOW_STATE_KEY, null)
}

const BOTTOM_EPSILON_PX = 0.75
const USER_DETACH_REATTACH_LOCK_MS = 700
/** 认定"这个 scrollTop 就是我自己刚写的"的容差。 */
const SELF_WRITE_EPSILON_PX = 2
export const SHOW_SCROLL_TO_BOTTOM_DISTANCE_PX = 160

const raf =
  typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : (callback: FrameRequestCallback) =>
        globalThis.setTimeout(() => callback(performance.now()), 16) as unknown as number
const caf =
  typeof cancelAnimationFrame === 'function'
    ? cancelAnimationFrame
    : (frame: number) => globalThis.clearTimeout(frame)

export interface ScrollGeometry {
  scrollHeight: number
  scrollTop: number
  clientHeight: number
}

export function getNaturalBottomDistance(geometry: ScrollGeometry): number {
  return Math.max(0, geometry.scrollHeight - geometry.clientHeight) - geometry.scrollTop
}

export function shouldShowScrollToBottomButton(
  geometry: ScrollGeometry,
  isFollowing: boolean,
): boolean {
  return !isFollowing && getNaturalBottomDistance(geometry) > SHOW_SCROLL_TO_BOTTOM_DISTANCE_PX
}

export interface UseFollowScrollOptions {
  scroller: Ref<HTMLElement | null>
  content: Ref<HTMLElement | null>
  count: ComputedRef<number>
  maintainOnLayout?: boolean | { readonly value: boolean } | (() => boolean)
}

export function useFollowScroll(opts: UseFollowScrollOptions) {
  const isFollowing = ref(true)
  let suppressed = false
  let followFrame: number | null = null
  let followBurstFrames = 0
  let reattachLockedUntil = 0
  let lastUserScrollDirection: 'up' | 'down' | null = null
  let contentResizeObserver: ResizeObserver | null = null
  let contentMutationObserver: MutationObserver | null = null
  let lastObservedScrollHeight = 0
  // 自己写过的 scrollTop。用来把"用户自己滚的"和"我把它钉回底部"分开 ——
  // wheel 事件看不见自定义滚动条拖拽 / PageUp / Home / 键盘滚动。
  let lastSelfWriteTop: number | null = null

  function getMaxScrollTop(el: HTMLElement): number {
    return Math.max(0, el.scrollHeight - el.clientHeight)
  }

  function shouldMaintainOnLayout(): boolean {
    const option = opts.maintainOnLayout
    if (typeof option === 'function') return option()
    if (option && typeof option === 'object' && 'value' in option) return option.value
    return option !== false
  }

  function traceScroll(
    source: string,
    data: {
      action?: string
      beforeScrollTop?: number | null
      afterScrollTop?: number | null
      targetScrollTop?: number | null
      extra?: string
    } = {},
  ) {
    if (!isTraceEnabled()) return
    traceEvent(source, () => opts.scroller.value, {
      isFollowing: isFollowing.value,
      isSuppressed: suppressed,
      virtualizerTotalSize: null,
      ...data,
    })
  }

  function writeScrollTop(el: HTMLElement, target: number, source: string, action: string) {
    const before = el.scrollTop
    el.scrollTop = target
    lastSelfWriteTop = el.scrollTop
    traceScroll(source, {
      action,
      beforeScrollTop: before,
      afterScrollTop: el.scrollTop,
      targetScrollTop: target,
    })
  }

  function pinToBottom(source = 'pinToBottom') {
    if (!isFollowing.value || suppressed) return
    const el = opts.scroller.value
    if (!el) return
    const target = getMaxScrollTop(el)
    if (Math.abs(target - el.scrollTop) <= BOTTOM_EPSILON_PX) {
      // 已经在底了就不用写,但"我认得这个位置"的标记要跟上 —— 否则一个陈旧的
      // 标记会让下一次滚动被误判成用户接管。
      lastSelfWriteTop = el.scrollTop
      return
    }
    writeScrollTop(el, target, source, 'write:natural-bottom')
  }

  function schedulePinToBottom(source = 'schedulePinToBottom', requireLayoutMaintenance = false) {
    if (requireLayoutMaintenance && !shouldMaintainOnLayout()) return
    if (followFrame !== null) return
    followFrame = raf(() => {
      followFrame = null
      if (requireLayoutMaintenance && !shouldMaintainOnLayout()) return
      pinToBottom(source)
      if (followBurstFrames > 0) {
        followBurstFrames--
        schedulePinToBottom(`${source}:burst`, requireLayoutMaintenance)
      }
    })
  }

  function pinToBottomThroughLayout(source = 'pinToBottomThroughLayout') {
    if (!shouldMaintainOnLayout()) return
    // ResizeObserver fires after layout and before paint. Pinning immediately
    // here avoids the single visible frame where content has grown but the
    // scroll position still points at the old bottom.
    pinToBottom(source)
    if (followBurstFrames < 2) followBurstFrames = 2
    schedulePinToBottom(`${source}:settle`, true)
  }

  function pinToBottomAfterMutation(source = 'MutationObserver:content') {
    const el = opts.scroller.value
    if (!el) return
    const scrollHeight = el.scrollHeight
    if (scrollHeight === lastObservedScrollHeight) return
    lastObservedScrollHeight = scrollHeight
    if (!shouldMaintainOnLayout()) return
    pinToBottomThroughLayout(source)
  }

  function cancelScheduledPin() {
    if (followFrame === null) return
    caf(followFrame)
    followFrame = null
  }

  function snapToBottom(source = 'snapToBottom') {
    suppressed = false
    isFollowing.value = true
    reattachLockedUntil = 0
    lastUserScrollDirection = 'down'
    cancelScheduledPin()
    followBurstFrames = 4
    pinToBottom(`${source}:sync`)
    nextTick(() => {
      pinToBottom(`${source}:tick`)
      schedulePinToBottom(source)
    })
  }

  function nudgeToAnchor(source = 'nudgeToAnchor') {
    pinToBottomThroughLayout(source)
  }

  function allowOneScroll() {
    traceScroll('allowOneScroll', { action: 'noop:native-scroll' })
  }

  function checkReattach() {
    const el = opts.scroller.value
    if (!el) return

    const distance = getNaturalBottomDistance(el)
    if (isFollowing.value) {
      if (!shouldMaintainOnLayout()) return
      // 一次**不是我写的**、并且把视口带离底部一大截的滚动 = 用户接管了。
      // wheel 分支看不到自定义滚动条拖拽 / PageUp / Home / 键盘滚动,过去这些
      // 路径下 isFollowing 一直是 true,下一个 chunk 就把用户拽回底部。
      // `distance > FOLLOW_BOTTOM_GAP` 是安全阀:内容变矮时浏览器会自己夹一次
      // scrollTop(同样不是我写的),但那种夹完仍然贴底,不会误判成用户操作。
      if (
        !suppressed &&
        lastSelfWriteTop !== null &&
        Math.abs(el.scrollTop - lastSelfWriteTop) > SELF_WRITE_EPSILON_PX &&
        distance > FOLLOW_BOTTOM_GAP
      ) {
        isFollowing.value = false
        lastUserScrollDirection = 'up'
        reattachLockedUntil = performance.now() + USER_DETACH_REATTACH_LOCK_MS
        cancelScheduledPin()
        traceScroll('scroll:external-detach', { action: 'state:following-false' })
        return
      }
      if (distance > BOTTOM_EPSILON_PX && !suppressed) {
        schedulePinToBottom('scroll:follow-drift', true)
      }
      return
    }

    const canAutoReattach =
      performance.now() >= reattachLockedUntil &&
      lastUserScrollDirection === 'down' &&
      distance <= BOTTOM_EPSILON_PX

    if (canAutoReattach) {
      isFollowing.value = true
      reattachLockedUntil = 0
      if (!shouldMaintainOnLayout()) return
      schedulePinToBottom('scroll:reattach-natural-bottom', true)
    }
  }

  function onWheel(e: WheelEvent) {
    if (e.deltaY === 0) return
    lastUserScrollDirection = e.deltaY < 0 ? 'up' : 'down'

    if (e.deltaY < 0) {
      reattachLockedUntil = performance.now() + USER_DETACH_REATTACH_LOCK_MS
      if (isFollowing.value) {
        isFollowing.value = false
        cancelScheduledPin()
        traceScroll('wheel:detach', { action: 'state:following-false' })
      }
    }
  }

  watch(
    opts.content,
    (el) => {
      contentResizeObserver?.disconnect()
      contentResizeObserver = null
      contentMutationObserver?.disconnect()
      contentMutationObserver = null
      if (!el || typeof ResizeObserver === 'undefined') return
      lastObservedScrollHeight = opts.scroller.value?.scrollHeight ?? 0
      contentResizeObserver = new ResizeObserver(() => pinToBottomThroughLayout('ResizeObserver:content'))
      contentResizeObserver.observe(el)
      if (typeof MutationObserver !== 'undefined') {
        contentMutationObserver = new MutationObserver(() => pinToBottomAfterMutation('MutationObserver:content'))
        contentMutationObserver.observe(el, {
          childList: true,
          subtree: true,
          characterData: true,
        })
      }
    },
    { immediate: true },
  )

  const cleanup = () => {
    cancelScheduledPin()
    contentResizeObserver?.disconnect()
    contentResizeObserver = null
    contentMutationObserver?.disconnect()
    contentMutationObserver = null
  }

  if (getCurrentInstance()) {
    onUnmounted(cleanup)
  }

  function prepareForSwitch() {
    suppressed = true
    cancelScheduledPin()
  }

  function finishSwitch() {
    suppressed = false
  }

  return {
    isFollowing,
    isSwitching: () => suppressed,
    isSuppressed: () => suppressed,
    snapToBottom,
    nudgeToAnchor,
    allowOneScroll,
    onWheel,
    checkReattach,
    prepareForSwitch,
    finishSwitch,
  }
}
