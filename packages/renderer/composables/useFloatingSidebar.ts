/**
 * 浮层侧栏的时序机(L4,`docs/design/shell-layout-2026-08.md` §L4)。
 *
 * 在此之前这套时序**散在 App.vue 里**:四个裸 timer(hover 延迟 / 关闭动画 /
 * 关闭后冷却 / toggle 后冷却)、一枚 `floatingCooldown` 布尔、三处 `clearTimeout`
 * 的清场块,以及"谁先谁后"这件只写在注释里的知识。它们服务的是**一个**问题 ——
 * 「侧栏此刻在不在浮层态」—— 所以它们该是一个东西。
 *
 * 这里只管**时序**,不管呈现:
 *   · `floating` / `closing` / `noTransition` 是三枚给 `<Sidebar>` 的开关;
 *   · 侧栏在哪儿画(停靠位 or `position: fixed`)由 App/AppShell 用同一个实例
 *     加 class 决定 —— L4 之后全仓只有**一个** `<Sidebar>` 实例,浮层⇄停靠
 *     不再重挂,滚动位置与展开的分组因此天然保留。
 *
 * 四段时长逐字沿用 L4 之前的行为(改的是归属,不是手感):
 *   · 进入延迟 200ms —— 鼠标扫过左缘不该把侧栏勾出来;
 *   · 关闭 200ms   —— 与 `slideOutLeft` 动画同长,动画跑完才卸浮层态;
 *   · 关闭后 300ms —— 继续压住过渡,避免侧栏落回停靠位时闪一下;
 *   · toggle 后 340ms —— 折叠/展开动画期间不许 hover 把浮层再勾出来。
 */
import { onScopeDispose, ref, type Ref } from 'vue'

/** hover 到左缘后,等这么久才把浮层勾出来。 */
export const FLOATING_SHOW_DELAY_MS = 200
/** 关闭动画时长(与 `Sidebar.vue` 的 `slideOutLeft` 同长)。 */
export const FLOATING_CLOSE_DURATION_MS = 200
/** 关闭动画跑完后,继续压住过渡的时长。 */
export const FLOATING_CLOSE_COOLDOWN_MS = 300
/** 折叠/展开 toggle 之后的冷却:这段时间内 hover 不勾浮层。 */
export const SIDEBAR_TOGGLE_COOLDOWN_MS = 340

export interface FloatingSidebarController {
  /** 浮层态(含关闭动画期间仍为 true —— 动画跑完才落下)。 */
  floating: Ref<boolean>
  /** 正在播关闭动画。 */
  closing: Ref<boolean>
  /** 压住侧栏自己的宽度过渡(浮层进出与折叠动画期间)。 */
  noTransition: Ref<boolean>
  /** 折叠/展开 toggle 的动画窗口 —— 顶栏留位与布局测量都读它。 */
  actionAnimating: Ref<boolean>
  /** 冷却中:hover 不勾浮层(toggle 后 / 关闭后)。 */
  cooldown: Ref<boolean>
  /** 鼠标进了左缘触发区。 */
  triggerEnter: () => void
  /** 鼠标离开触发区 —— 只撤未兑现的那一次延迟,不动已展开的浮层。 */
  triggerLeave: () => void
  /** 鼠标进了浮层本体:撤销待关闭。 */
  keepOpen: () => void
  /** 关浮层(带动画)。 */
  close: () => void
  /** 用户点了折叠/展开:起 340ms 冷却窗。 */
  notifyToggled: () => void
  /** 侧栏回到停靠位:收摊(浮层态与待展开的那一次延迟都作废)。 */
  reset: () => void
  /** 清掉所有在跑的 timer。作用域销毁时自动调用。 */
  dispose: () => void
}

/**
 * 建一台浮层侧栏时序机。
 *
 * 在 setup 里调用即可 —— 它自己挂 `onScopeDispose`,宿主不必再写清场块
 * (L4 之前 App.vue 的 `onUnmounted` 里为此躺着四个 `clearTimeout`)。
 */
export function useFloatingSidebar(): FloatingSidebarController {
  const floating = ref(false)
  const closing = ref(false)
  const noTransition = ref(false)
  const actionAnimating = ref(false)
  const cooldown = ref(false)

  let showTimer: ReturnType<typeof setTimeout> | null = null
  let closeTimer: ReturnType<typeof setTimeout> | null = null
  let closeCooldownTimer: ReturnType<typeof setTimeout> | null = null
  let toggleTimer: ReturnType<typeof setTimeout> | null = null

  function clearShowTimer() {
    if (showTimer === null) return
    clearTimeout(showTimer)
    showTimer = null
  }

  function clearCloseTimers() {
    if (closeTimer !== null) {
      clearTimeout(closeTimer)
      closeTimer = null
    }
    if (closeCooldownTimer !== null) {
      clearTimeout(closeCooldownTimer)
      closeCooldownTimer = null
    }
  }

  function clearToggleTimer() {
    if (toggleTimer === null) return
    clearTimeout(toggleTimer)
    toggleTimer = null
  }

  function triggerEnter() {
    // 冷却中(刚 toggle 过 / 正在关)不勾。
    if (closing.value || cooldown.value) return
    clearShowTimer()
    showTimer = setTimeout(() => {
      showTimer = null
      noTransition.value = true
      floating.value = true
    }, FLOATING_SHOW_DELAY_MS)
  }

  function triggerLeave() {
    // 只撤未兑现的那一次延迟 —— 已经展开的浮层由它自己的 mouseleave 关。
    clearShowTimer()
  }

  function keepOpen() {
    if (!floating.value && !closing.value) return
    clearCloseTimers()
    floating.value = true
    closing.value = false
    cooldown.value = false
    noTransition.value = false
  }

  function close() {
    if (!floating.value || closing.value) return
    clearCloseTimers()
    closing.value = true
    noTransition.value = true
    cooldown.value = true
    closeTimer = setTimeout(() => {
      closeTimer = null
      floating.value = false
      closing.value = false
      // 动画落地后再压一会儿过渡,免得侧栏回停靠位时闪一下。
      closeCooldownTimer = setTimeout(() => {
        closeCooldownTimer = null
        noTransition.value = false
        cooldown.value = false
      }, FLOATING_CLOSE_COOLDOWN_MS)
    }, FLOATING_CLOSE_DURATION_MS)
  }

  function notifyToggled() {
    cooldown.value = true
    actionAnimating.value = true
    clearToggleTimer()
    toggleTimer = setTimeout(() => {
      toggleTimer = null
      actionAnimating.value = false
      cooldown.value = false
    }, SIDEBAR_TOGGLE_COOLDOWN_MS)
  }

  function reset() {
    // 只收浮层这一摊:toggle 的动画窗口是折叠动画的事,不归这里撤。
    clearShowTimer()
    clearCloseTimers()
    floating.value = false
    closing.value = false
  }

  function dispose() {
    clearShowTimer()
    clearCloseTimers()
    clearToggleTimer()
  }

  // `true` = 没有活动作用域时静默(纯函数式的单测直接调它,不该收到警告)。
  onScopeDispose(dispose, true)

  return {
    floating,
    closing,
    noTransition,
    actionAnimating,
    cooldown,
    triggerEnter,
    triggerLeave,
    keepOpen,
    close,
    notifyToggled,
    reset,
    dispose,
  }
}
