import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import * as T from './transitions'
import type { ExposeState, FocusDir } from './types'

interface ExposeStore extends ExposeState {
  open: () => void
  close: () => void
  toggle: () => void
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
 */
export const useExposeStore = create<ExposeStore>()(
  persist(
    (set) => ({
      ...T.initialExposeState,

      open: () => set(T.open),
      close: () => set(T.close),
      toggle: () => set(T.toggle),
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
      enterSession: (sessionId) => set((s) => T.enterSession(s, sessionId)),
    }),
    {
      name: 'onething.expose',
      storage: createJSONStorage(() => localStorage),
      // 只持久化折叠状态:重开永远从「关着的总览」开始。
      partialize: (s) => ({ collapsedGroups: s.collapsedGroups }),
    },
  ),
)
