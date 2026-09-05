import { create } from 'zustand'
import * as T from './transitions'
import type { TocState } from './types'

/**
 * 动作名带 Panel 后缀,是因为 TocState 里已经有一个布尔字段就叫 open ——
 * 一个名字不能同时是「状态」和「动作」。这里让状态保住短名字(它才是被读的那个)。
 *
 * ── W5-a:**按会话记一格**,不是全应用一格 ────────────────────────────────
 * 目录展不展开是「这条会话的目录此刻展着没有」。会话多开之后两片叶各有一条 rail,
 * 存一格就是两条 rail 共用一个开关 —— 一边悬停另一边跟着展开。所以状态按 sessionId
 * 分格,动作全部收 sessionId 当第一个参数。
 *
 * **表只增不清**:一格是两个字段的小对象,而「什么时候该忘掉一条会话」在这一层
 * 没有判据(叶关了、会话删了都是别人的事实)—— 猜一个就是第二处生命周期。
 */
interface TocStore {
  /** 每条会话一格;没有那一格 = 从没展开过,读 `initialTocState`。 */
  bySession: Record<string, TocState>
  openPanel: (sessionId: string) => void
  closePanel: (sessionId: string) => void
  togglePanel: (sessionId: string) => void
  hoverKey: (sessionId: string, index: number | null) => void
}

/**
 * 读一条会话那一格。**没有那一格时给同一个常量对象** —— 每次现造一个
 * `{open:false,hoverIndex:null}` 会让 zustand 的浅比每次都判「变了」,
 * 于是没展开过的那条会话每推一次 store 就重渲一次。
 */
export function selectToc(sessionId: string): (store: TocStore) => TocState {
  return (store) => store.bySession[sessionId] ?? T.initialTocState
}

/**
 * 和 stage/expose 的 store 一样:只是 transitions 的一层壳,
 * 每个 action 都是 set(transitions.f)。逻辑写在这里就测不到了。
 *
 * 不持久化:目录展不展开是「此刻鼠标在哪」,不是用户摆好的工作台。
 */
export const useTocStore = create<TocStore>()((set) => {
  /** 纯函数只认一格 —— 这一层负责把它套回表里(没变就整张表原样返回)。 */
  const patch = (sessionId: string, step: (state: TocState) => TocState) =>
    set((store) => {
      const before = store.bySession[sessionId] ?? T.initialTocState
      const after = step(before)
      if (after === before) return store
      return { bySession: { ...store.bySession, [sessionId]: after } }
    })

  return {
    bySession: {},

    openPanel: (sessionId) => patch(sessionId, T.openToc),
    closePanel: (sessionId) => patch(sessionId, T.closeToc),
    togglePanel: (sessionId) => patch(sessionId, T.toggleToc),
    hoverKey: (sessionId, index) => patch(sessionId, (state) => T.hoverKey(state, index)),
  }
})
