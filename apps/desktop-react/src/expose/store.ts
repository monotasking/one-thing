import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { currentGroups, onSessionsRemoved, useSessionsSource } from '../data/sessions-source'
import { SESSIONS_ITEM_ID } from '../stage/items'
import { useStageStore } from '../stage/store'
import { formOf } from '../stage/transitions'
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
  /** 搜索框把键盘交给网格(只点亮锚点,不移动)。 */
  focusGrid: () => void
  /** 渲染层量到「一行几张」之后报进来 —— 唯一产地是 CSS 的计算值。 */
  setColumns: (columns: number) => void
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
      focusGrid: () => set((s) => T.focusGrid(s, currentGroups())),
      setColumns: (columns) => set((s) => T.setColumns(s, columns)),
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
      // 搜索词一变,焦点可能落到一张被过滤掉的卡上 —— 纯函数要那份分组事实才夹得住。
      setQuery: (query) => set((s) => T.setQuery(s, query, currentGroups())),
      enterSession: (sessionId) => {
        set((s) => T.enterSession(s, sessionId))
        // 进了会话,目录(钢琴键)与首页消息就都成了「此刻要看的东西」。
        void useSessionsSource.getState().ensureChapters(sessionId)
        void useSessionsSource.getState().ensureMessages(sessionId)
        /*
         * 「进入」之后这块面收不收,看它的**形态**(08-30 用户拍板):
         *  - 舞台 / 浮窗是**瞬态形**——点开、选完、即走,「进入」的语义就是活干完了,
         *    收回 Dock(已在 Dock 时是恒等变换,不必先判)。
         *  - 钉在边上(edge)是**常驻形**——用户把它固定成了工作面,选一条会话是
         *    这块面的日常动作,不是谢幕;收掉它等于把用户刚安置好的家具搬走。
         * 同一个动作按落点分岔,分岔判据只有这一处 —— 纯函数(transitions.enterSession)
         * 仍然不认识 Placement,这层壳才是那个唯一的接缝。
         */
        const stage = useStageStore.getState()
        if (formOf(stage, SESSIONS_ITEM_ID) !== 'edge') {
          stage.closeToDock(SESSIONS_ITEM_ID)
        }
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

/**
 * 「有会话被删掉了」→ 形态夹持(H 批)。
 *
 * 这是同一条接缝的第二个方向:`currentGroups()` 是壳**问**数据源要事实,
 * 这一条是数据源**告诉**壳事实没了。判据仍然全在纯函数
 * (`T.sessionsRemoved`:Quick Look 退层 / 空掉的组退层 / 当前会话回空态 /
 * 焦点退到序列首),壳只负责把那份**摘除之后**的分组事实递进去。
 *
 * 订阅在模块求值时装一次,不退订 —— 它和 store 本身同寿命,而 store 是单例。
 */
onSessionsRemoved((removedIds) => {
  useExposeStore.setState((s) => T.sessionsRemoved(s, removedIds, currentGroups()))
})
