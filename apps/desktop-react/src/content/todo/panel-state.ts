import { create } from 'zustand'

/**
 * 待办窗**这一次运行**里的瞬态(不落盘):切换弹层开没开、刚从搜索结果点开的是哪一项。
 *
 * 为什么是一只 store 而不是组件 state:头(`TodoHeader`)与正文(`TodoPanel`)是**两个宿主
 * 位置**上的两棵子树 —— 独占一片叶时头画在叶的标签条上,与正文隔着叶的结构。⌘F 在正文里
 * 按下、弹层在头上开;在弹层里点一条项、正文滚到那一行 —— 两边说的是同一件事。
 */
interface TodoPanelState {
  switcherOpen: boolean
  /** 从搜索结果打开的那一项:正文滚到它并淡闪一下。`at` 让同一行连点两次也算两次。 */
  reveal: { id: string; line: number; at: number } | null
  openSwitcher: () => void
  closeSwitcher: () => void
  revealItem: (id: string, line: number) => void
  consumeReveal: () => void
}

export const useTodoPanelState = create<TodoPanelState>()(set => ({
  switcherOpen: false,
  reveal: null,
  openSwitcher: () => set({ switcherOpen: true }),
  closeSwitcher: () => set({ switcherOpen: false }),
  revealItem: (id, line) => set({ reveal: { id, line, at: Date.now() } }),
  consumeReveal: () => set({ reveal: null }),
}))

export function resetTodoPanelState(): void {
  useTodoPanelState.setState({ switcherOpen: false, reveal: null })
}

if (import.meta.hot) {
  import.meta.hot.dispose(resetTodoPanelState)
}
