import { create } from 'zustand'
import * as T from './transitions'
import type { TocState } from './types'

/**
 * 动作名带 Panel 后缀,是因为 TocState 里已经有一个布尔字段就叫 open ——
 * 一个名字不能同时是「状态」和「动作」。这里让状态保住短名字(它才是被读的那个)。
 */
interface TocStore extends TocState {
  openPanel: () => void
  closePanel: () => void
  togglePanel: () => void
  hoverKey: (index: number | null) => void
}

/**
 * 和 stage/expose 的 store 一样:只是 transitions 的一层壳,
 * 每个 action 都是 set(transitions.f)。逻辑写在这里就测不到了。
 *
 * 不持久化:目录展不展开是「此刻鼠标在哪」,不是用户摆好的工作台。
 */
export const useTocStore = create<TocStore>()((set) => ({
  ...T.initialTocState,

  openPanel: () => set(T.openToc),
  closePanel: () => set(T.closeToc),
  togglePanel: () => set(T.toggleToc),
  hoverKey: (index) => set((s) => T.hoverKey(s, index)),
}))
