/**
 * Todo 窗的**形态开关**:同一张浮面上的两种内容 —— Todo / 笔记,或草稿纸。
 *
 * ## 为什么住在 localStorage 而不是会话里
 * 「我现在想看哪一种」是**每窗口的当下偏好**,不是会话的属性:同一个会话,
 * 主窗的卡片形态和独立窗可以各看各的;换会话时这一位不该跟着动。所以键按
 * 形态前缀分账(`todoPlanCardMode` / `todoPlanWindowMode`),与 TodoPlanPanel
 * 既有的 `Pinned` / `Collapsed` / `Height` 同一套记账法。
 *
 * ## 它同时是一条跨窗口信号
 * composer 上的草稿纸钮在**主窗**里按下,要切的却是**独立窗**的形态。两个窗口
 * 之间没有渲染层通道(加一条就是后端改动),但 localStorage 天生有一条:同源
 * 的另一个文档写了键,本文档会收到 `storage` 事件。所以入口的动作就是
 * 「写键 + 开窗」,已开着的窗靠 `storage` 事件跟上,没开的窗下次挂载时读到。
 * 事件没送达也不会坏事 —— 最差是那扇已经开着的窗停在原形态,用户自己点一下。
 */
export type TodoPanelMode = 'todo' | 'scratchpad'

export const TODO_PANEL_MODES: readonly TodoPanelMode[] = ['todo', 'scratchpad']

/** 独立窗与内嵌卡片各记各的 —— 与 TodoPlanPanel 的 `storagePrefix` 同源。 */
export const TODO_PANEL_WINDOW_STORAGE_PREFIX = 'todoPlanWindow'
export const TODO_PANEL_CARD_STORAGE_PREFIX = 'todoPlanCard'

/**
 * localStorage 在测试 / 无浏览器环境可能缺席。判据卡在**方法在不在**而不是
 * "全局有没有":Node 22 起 globalThis 上有一个空壳 localStorage(属性齐、
 * 方法全 undefined)。与 `stores/scratchpad.ts` 同一条纪律。
 */
function safeStorage(): Storage | null {
  try {
    const storage = typeof localStorage === 'undefined' ? null : localStorage
    return typeof storage?.getItem === 'function' ? storage : null
  } catch {
    return null
  }
}

/** 认不出来的值一律回到 Todo —— 这是这扇窗原本的样子。 */
export function normalizeTodoPanelMode(raw: unknown): TodoPanelMode {
  return raw === 'scratchpad' ? 'scratchpad' : 'todo'
}

export function todoPanelModeStorageKey(storagePrefix: string): string {
  return `${storagePrefix}Mode`
}

export function readTodoPanelMode(storageKey: string): TodoPanelMode {
  return normalizeTodoPanelMode(safeStorage()?.getItem(storageKey) ?? null)
}

export function writeTodoPanelMode(storageKey: string, mode: TodoPanelMode): void {
  try {
    safeStorage()?.setItem(storageKey, mode)
  } catch {
    // 存不下不是错误,只是不持久。
  }
}

/** composer 的入口用它:先把独立窗的形态定下来,再去开窗。 */
export function requestTodoPlanWindowScratchpadMode(): void {
  writeTodoPanelMode(todoPanelModeStorageKey(TODO_PANEL_WINDOW_STORAGE_PREFIX), 'scratchpad')
}
