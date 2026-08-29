import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { currentGroups, useSessionsSource } from '../data/sessions-source'
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
 * D1 之后它多了一份职责,而且只有这一份:**把「此刻有哪些组」交给纯函数**。
 * 纯函数不认识数据源(不然它就不纯了),组件也不该为了按一下方向键去取一次数据 ——
 * 所以这层壳是那个唯一的接缝,`currentGroups()` 只在这里出现。
 *
 * 另外两处「组合」同样只能落在壳里:
 *  - enterSession:换会话之后顺手把这块面收回 Dock(纯函数不认识 Placement);
 *  - openQuickLook / enterSession:顺手让数据源去拉那条会话的首页消息与章节
 *    (「按需」的需求正是在这两个动作发生的)。
 */
export const useExposeStore = create<ExposeStore>()(
  persist(
    (set) => ({
      ...T.initialExposeState,

      open: () => set((s) => T.open(s, currentGroups())),
      escape: () => set(T.escape),
      enterList: (groupId) => set((s) => T.enterList(s, groupId)),
      backToOverview: () => set(T.backToOverview),
      openQuickLook: (sessionId) => {
        set((s) => T.openQuickLook(s, sessionId))
        void useSessionsSource.getState().ensureMessages(sessionId)
      },
      closeQuickLook: () => set(T.closeQuickLook),
      moveFocus: (dir) => set((s) => T.moveFocus(s, dir, currentGroups())),
      quickLookPrev: () => {
        set((s) => T.quickLookPrev(s, currentGroups()))
        const view = useExposeStore.getState().view
        if (view.mode === 'quicklook') void useSessionsSource.getState().ensureMessages(view.sessionId)
      },
      quickLookNext: () => {
        set((s) => T.quickLookNext(s, currentGroups()))
        const view = useExposeStore.getState().view
        if (view.mode === 'quicklook') void useSessionsSource.getState().ensureMessages(view.sessionId)
      },
      toggleGroupCollapsed: (groupId) =>
        set((s) => T.toggleGroupCollapsed(s, groupId, currentGroups())),
      setQuery: (query) => set((s) => T.setQuery(s, query)),
      enterSession: (sessionId) => {
        set((s) => T.enterSession(s, sessionId))
        // 进了会话,目录(钢琴键)与首页消息就都成了「此刻要看的东西」。
        void useSessionsSource.getState().ensureChapters(sessionId)
        void useSessionsSource.getState().ensureMessages(sessionId)
        // 「进入」的语义就是离开总览:这块面的活干完了,收回 Dock。
        // 已经在 Dock 里(比如从检索面板进的会话)时它是恒等变换,所以不必先判一次。
        useStageStore.getState().closeToDock(SESSIONS_ITEM_ID)
      },
    }),
    {
      name: 'onething.expose',
      storage: createJSONStorage(() => localStorage),
      // 只持久化折叠状态:视图层每次开场都归位,不该被上次的停留点污染。
      // 当前会话也不持久化 —— 它现在是**真会话 id**,把一个可能已被删掉的 id
      // 记到下次启动,换来的是一个指向空气的标题。
      partialize: (s) => ({ collapsedGroups: s.collapsedGroups }),
    },
  ),
)
