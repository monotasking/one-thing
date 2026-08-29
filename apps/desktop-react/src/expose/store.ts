import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { SESSIONS_ITEM_ID } from '../stage/items'
import { useStageStore } from '../stage/store'
import * as T from './transitions'
import type { ExposeState, FocusDir } from './types'

interface ExposeStore extends ExposeState {
  /** 开场归位。这块面一挂载就叫一次 —— 「在场即开场」只有挂载这一个时刻。 */
  open: () => void
  escape: () => void
  enterList: (groupId: string) => void
  backToOverview: () => void
  openQuickLook: (sessionId: string) => void
  closeQuickLook: () => void
  moveFocus: (dir: FocusDir) => void
  quickLookPrev: () => void
  quickLookNext: () => void
  toggleGroupCollapsed: (groupId: string) => void
  setQuery: (query: string) => void
  enterSession: (sessionId: string) => void
}

/**
 * 和 stage/store.ts 一样:store 只是 transitions 的一层壳,
 * 每个 action 都是 set(transitions.f)。逻辑写在这里就测不到了。
 *
 * 唯一的「组合」是 enterSession:换会话之后顺手把这块面收回 Dock。
 * 它只能落在壳里 —— 纯函数不认识 Placement,而形态机也不该认识会话。
 */
export const useExposeStore = create<ExposeStore>()(
  persist(
    (set) => ({
      ...T.initialExposeState,

      open: () => set(T.open),
      escape: () => set(T.escape),
      enterList: (groupId) => set((s) => T.enterList(s, groupId)),
      backToOverview: () => set(T.backToOverview),
      openQuickLook: (sessionId) => set((s) => T.openQuickLook(s, sessionId)),
      closeQuickLook: () => set(T.closeQuickLook),
      moveFocus: (dir) => set((s) => T.moveFocus(s, dir)),
      quickLookPrev: () => set(T.quickLookPrev),
      quickLookNext: () => set(T.quickLookNext),
      toggleGroupCollapsed: (groupId) => set((s) => T.toggleGroupCollapsed(s, groupId)),
      setQuery: (query) => set((s) => T.setQuery(s, query)),
      enterSession: (sessionId) => {
        set((s) => T.enterSession(s, sessionId))
        // 「进入」的语义就是离开总览:这块面的活干完了,收回 Dock。
        // 已经在 Dock 里(比如从检索面板进的会话)时它是恒等变换,所以不必先判一次。
        useStageStore.getState().closeToDock(SESSIONS_ITEM_ID)
      },
    }),
    {
      name: 'onething.expose',
      storage: createJSONStorage(() => localStorage),
      // 只持久化折叠状态:视图层每次开场都归位,不该被上次的停留点污染。
      partialize: (s) => ({ collapsedGroups: s.collapsedGroups }),
    },
  ),
)
