/**
 * 外壳布局协调器 —— L2 / L3(`docs/design/shell-layout-2026-08.md` §L2 §L3)。
 *
 * 在此之前每一列各自 clamp:侧栏 200–500px 写在 App.vue,大纲栏 268px + 一条
 * `CHAT_SIDE_PANEL_MIN_WINDOW_WIDTH = 1100` 死阈值写在 ChatContainer.vue,右栏
 * 22%–48%/≥250px 又写在 App.vue 的另一处。几个 clamp 谁也不知道别人 ——
 * 窄窗下的表现因此是几条独立规则撞出来的,而不是设计出来的。
 *
 * 这里把它变成**一个预算**:
 *
 *     W = sidebar + chat + workbench                 (chat ≥ 480px 是硬下限)
 *
 * 装不下就按固定顺序从右往左收(用户偏好只在预算允许时兑现):
 *
 *     1. workbench 收窄到 250
 *     2. workbench 折叠
 *     3. sidebar 从停靠转浮层
 *
 * L3 起大纲栏不再是一列(它的四段并进了右栏的两条会话域页签),降级表因此少了
 * 原来的第 1 步"chatSide 折叠",`chatSideFits` 这枚只为顶栏按钮活着的输出也随
 * 之退役。
 *
 * **「用户折叠」与「预算折叠」是两件事**:前者写 `layoutPrefs` store,后者只活在
 * 这个函数的返回值里。因为降级是 `(W, 偏好)` 的纯函数,窗宽一恢复,预算折叠自动
 * 撤销 —— 不需要任何"记得把它弹回来"的代码,也不会把用户偏好改坏。
 *
 * `resolveShellLayout` 是纯函数,整张降级表都在 vitest 里钉着
 * (`__tests__/useShellLayout.test.ts`)。
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'
import {
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  MAX_WORKBENCH_WIDTH,
  MIN_WORKBENCH_WIDTH,
  clampSidebarWidth,
  clampWorkbenchWidth,
  useLayoutPrefsStore,
} from '@/stores/layoutPrefs'

/**
 * 聊天列的硬下限:阅读列 46rem 的下界 + 两侧留白。低于它,消息就不再是"一列
 * 可读的文字",而是被挤成两三个词一行的窄条。
 */
export const CHAT_MIN_WIDTH = 480

export interface ShellLayoutInput {
  /** `.app-shell` 的内容宽(px)。≤0 = 还没量到,一律兑现偏好、不做降级。 */
  shellWidth: number
  sidebarWidth: number
  /** 用户折叠了侧栏。 */
  sidebarCollapsed: boolean
  /** 右栏展开时的宽度偏好。 */
  workbenchWidth: number
  /** 右栏该不该显示(用户开合 ∧ 运行时有内容可显示)。 */
  workbenchOpen: boolean
}

export interface ShellLayout {
  /** 侧栏是否停靠。false = 走浮层态(用户折叠的,或预算挤掉的)。 */
  sidebarDocked: boolean
  /** 侧栏是被**预算**挤成浮层的(用户偏好仍是展开;窗宽恢复即回弹)。 */
  sidebarFloatingByBudget: boolean
  sidebarWidth: number
  /** 拖侧栏分隔条的上限 —— 拖到头也要给聊天列留 480px。 */
  sidebarMaxWidth: number

  /** 聊天列的实际宽度(仅供读数/调试;真实布局由 flex 收口)。 */
  chatWidth: number

  workbenchVisible: boolean
  /** 右栏是被**预算**收起的(用户偏好仍是展开)。 */
  workbenchCollapsedByBudget: boolean
  /** 右栏展开时的宽度(即使当前不可见也给出来 —— 折叠动画要用它当冻结宽)。 */
  workbenchWidth: number
  workbenchMinWidth: number
  /** 拖右栏分隔条的上限 —— 同样要给聊天列留 480px。 */
  workbenchMaxWidth: number
}

/** 预算 + 降级顺序。纯函数:同样的输入永远同样的输出,不读任何全局。 */
export function resolveShellLayout(input: ShellLayoutInput): ShellLayout {
  const width = Number.isFinite(input.shellWidth) && input.shellWidth > 0 ? input.shellWidth : 0

  const sidebarWidth = clampSidebarWidth(input.sidebarWidth)
  let sidebarDocked = !input.sidebarCollapsed
  let sidebarFloatingByBudget = false

  let workbenchVisible = input.workbenchOpen
  let workbenchCollapsedByBudget = false
  let workbenchWidth = clampWorkbenchWidth(input.workbenchWidth)

  const occupied = () =>
    (sidebarDocked ? sidebarWidth : 0)
    + (workbenchVisible ? workbenchWidth : 0)
  const room = () => width - occupied()
  const tight = () => width > 0 && room() < CHAT_MIN_WIDTH

  // 1. 右栏收窄到 250(设计稿硬指标,再窄就只剩省略号)。
  if (tight() && workbenchVisible && workbenchWidth > MIN_WORKBENCH_WIDTH) {
    workbenchWidth = MIN_WORKBENCH_WIDTH
  }

  // 2. 右栏折叠 —— store.workbenchOpen 不动,窗宽恢复自动回弹。
  if (tight() && workbenchVisible) {
    workbenchVisible = false
    workbenchCollapsedByBudget = true
  }

  // 3. 侧栏转浮层 —— 同理不改 store.sidebarCollapsed。
  if (tight() && sidebarDocked) {
    sidebarDocked = false
    sidebarFloatingByBudget = true
  }

  const chatWidth = width > 0 ? Math.max(0, room()) : 0

  const workbenchHeadroom = width > 0
    ? width - (sidebarDocked ? sidebarWidth : 0) - CHAT_MIN_WIDTH
    : MAX_WORKBENCH_WIDTH
  const workbenchMaxWidth = Math.max(
    MIN_WORKBENCH_WIDTH,
    Math.min(MAX_WORKBENCH_WIDTH, workbenchHeadroom),
  )

  const sidebarHeadroom = width > 0
    ? width - (workbenchVisible ? workbenchWidth : 0) - CHAT_MIN_WIDTH
    : MAX_SIDEBAR_WIDTH
  const sidebarMaxWidth = Math.max(
    MIN_SIDEBAR_WIDTH,
    Math.min(MAX_SIDEBAR_WIDTH, sidebarHeadroom),
  )

  return {
    sidebarDocked,
    sidebarFloatingByBudget,
    sidebarWidth,
    sidebarMaxWidth,
    chatWidth,
    workbenchVisible,
    workbenchCollapsedByBudget,
    workbenchWidth,
    workbenchMinWidth: MIN_WORKBENCH_WIDTH,
    workbenchMaxWidth,
  }
}

/* ── 运行时输入 ────────────────────────────────────────────────────────────
   两枚模块级 ref,不是几处各存一份:协调器**只有一个**,读的必须是同一份布局。
   ResizeObserver 也因此全仓只剩这一处(`observeShellWidth`)。 */
const shellWidth = ref(0)
/** 右栏该不该显示的运行时闸(有会话 / 过过工作区面板),由 App.vue 灌。 */
const workbenchRequested = ref(false)

export function setShellWidth(width: number): void {
  shellWidth.value = Number.isFinite(width) ? width : 0
}

export function setWorkbenchRequested(requested: boolean): void {
  workbenchRequested.value = requested
}

/** 测试夹具用:把模块级运行时输入拨回初值。 */
export function resetShellLayoutRuntime(): void {
  shellWidth.value = 0
  workbenchRequested.value = false
}

/**
 * 全仓**唯一**一处量外壳宽的 ResizeObserver(L2 拿掉了 App.vue 的
 * `contentSplitterWidth` 与 ChatContainer.vue 的 `chatResizeObserver`)。
 * 返回一个 disposer。
 */
export function observeShellWidth(element: HTMLElement | null | undefined): () => void {
  if (!element) return () => {}
  if (typeof ResizeObserver === 'undefined') {
    setShellWidth(element.getBoundingClientRect().width)
    return () => {}
  }
  const observer = new ResizeObserver(entries => {
    setShellWidth(entries[0]?.contentRect.width ?? 0)
  })
  observer.observe(element)
  setShellWidth(element.getBoundingClientRect().width)
  return () => observer.disconnect()
}

export interface UseShellLayoutResult {
  layout: ComputedRef<ShellLayout>
  shellWidth: Ref<number>
  setShellWidth: (width: number) => void
  setWorkbenchRequested: (requested: boolean) => void
  observeShellWidth: (element: HTMLElement | null | undefined) => () => void
}

/** 协调器的 Vue 门面:偏好来自 store,运行时输入来自上面两枚 setter。 */
export function useShellLayout(): UseShellLayoutResult {
  const prefs = useLayoutPrefsStore()

  const layout = computed(() => resolveShellLayout({
    shellWidth: shellWidth.value,
    sidebarWidth: prefs.sidebarWidth,
    sidebarCollapsed: prefs.sidebarCollapsed,
    workbenchWidth: prefs.workbenchWidth,
    workbenchOpen: workbenchRequested.value,
  }))

  return {
    layout,
    shellWidth,
    setShellWidth,
    setWorkbenchRequested,
    observeShellWidth,
  }
}
