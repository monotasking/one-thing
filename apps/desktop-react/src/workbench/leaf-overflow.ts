import { useCallback, useEffect } from 'react'
import { create } from 'zustand'
import type { TabsOverflow } from '../ui/Tabs'

/**
 * **「这片叶的标签条上有几格没露全」那一格事实**(W7-t / B1)。
 *
 * ── 它为什么是一格 store,而不是一段 props ────────────────────────────────
 * 与 `workbench/leaf-menu` 逐字同一条判例:量它的人与画它的人**够不着彼此**。
 * 溢出是标签条自己的形(`ui/Tabs` 是那个横滚容器,只有它量得出谁在视野里),
 * 而那颗 ⋯ 与它那张表长在**叶动作组**上 —— 中央区这一档里两者是 `TopBar` 的
 * 两兄弟(`LeafTabGroup` 与 `TopBarLeafActions`),架子 / 浮窗那一档里它们才是
 * 父子。一格 store 让两档走同一条路。
 *
 * 存的是**条自己交出来的那份**(`TabsOverflow`):名单 + 一口 `reveal`。
 * `reveal` 必须跟着条走而不是按 id 现查 DOM —— 同一个 refId 可以在两片叶里各开
 * 一格,`document.querySelector` 分不出该滚哪一条。
 *
 * 寿命 = 那条条在场的这段时间:宿主挂载时报,卸载时 `forget`。
 */

interface LeafOverflowStore {
  /** 叶 id → 那条条此刻的溢出读数。没有这一格 = 那条条没在量(或者全露着)。 */
  byLeaf: Readonly<Record<string, TabsOverflow>>
  /** 条量完一遍。**同一份名单不重复写**(引用恒等,免得白重渲一次动作组)。 */
  report(leafId: string, state: TabsOverflow): void
  /** 这条条下场了。 */
  forget(leafId: string): void
}

export const useLeafOverflowStore = create<LeafOverflowStore>()((set) => ({
  byLeaf: {},
  report: (leafId, state) =>
    set((s) => {
      const now = s.byLeaf[leafId]
      if (now && sameIds(now.ids, state.ids) && now.reveal === state.reveal) return s
      return { byLeaf: { ...s.byLeaf, [leafId]: state } }
    }),
  forget: (leafId) =>
    set((s) => {
      if (!(leafId in s.byLeaf)) return s
      const next = { ...s.byLeaf }
      delete next[leafId]
      return { byLeaf: next }
    }),
}))

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}

/** 这片叶此刻有哪几格没露全(以及把一格滚进视野那一口)。 */
export function useLeafOverflow(leafId: string): TabsOverflow | undefined {
  return useLeafOverflowStore((st) => st.byLeaf[leafId])
}

/**
 * **把这条条的溢出读数报给叶动作组** —— 两个宿主(顶栏那一组 / 架子·浮窗那条
 * 叶檐)共用的一只接线。
 *
 * 它在这里而不是在两个宿主里各写一遍,理由与这只文件存在的理由同一条:
 * 「报」这件事只该有一个形状,而它的另一半(卸载时 `forget`)最容易在第二处
 * 被漏掉 —— 漏掉的表现是那条条早就不在了,⋯ 还列着它上一刻的名单。
 */
export function useReportOverflow(leafId: string): (state: TabsOverflow) => void {
  useEffect(() => () => useLeafOverflowStore.getState().forget(leafId), [leafId])
  return useCallback(
    (state: TabsOverflow) => useLeafOverflowStore.getState().report(leafId, state),
    [leafId],
  )
}

/*
 * 模块级可变状态的 HMR 退役(09-01 立法)。这张表跨渲染留存,而每一格里的
 * `reveal` 还闭包着**某一份模块实例的 DOM** —— 热替换之后那几只闭包既读不到新的
 * 条,也不该把旧 DOM 拖着不放。清成初值就够:下一次挂载时每条条自己会重报一遍。
 */
if (import.meta.hot) import.meta.hot.dispose(() => useLeafOverflowStore.setState({ byLeaf: {} }))
