import { useEffect, useMemo } from 'react'
import type { RefObject } from 'react'
import type { ScrollMemory } from '../../ui/scroll-memory'
import { useScrollMemory } from '../../ui/scroll-memory'
import { useViewerSource } from '../../data/viewer-source'

/**
 * **查看器的滚动三件**(09-02 批 9b 从 `FileViewer` 拆出;W1 改成按 path 记)。
 *
 * 滚动**永远是查看器 `.body` 自己管**。既然归属只有一处,那三件跟它绑着的事
 * 就该在同一处:
 *
 *   ① 跳行之后把那一行滚到视野中间(律④:跳转滚动不闪);
 *   ② **换宿主之后把滚动位贴回去**;
 *   ③ 每一帧滚动抄进 store,好让 ② 贴得回来。
 *
 * 三件是一条链:没有 ③ 就没有 ② 可贴的数,没有 ② 换宿主就弹回顶上。
 *
 * ── W1 改的只有「贴谁的数」──────────────────────────────────────────────
 * 从前是 store 顶层那一格 `scrollTop`(全应用一份);现在是 `scrolls[path]`
 * 那张表里属于这一份实例的一格。**`placement` 这个依赖没有了** —— 查看器不再
 * 知道自己被摆在哪儿,而「换宿主」这件事本来就是一次真重挂(新的组件实例,
 * layout effect 自然重跑),不需要一个字符串来提醒它。
 *
 * ── 09-06 检索面 ③:②③ 两件搬进库件 ──────────────────────────────────
 * 「还原 / 写回」这一对不是查看器的私事 —— 检索面换词之后要保住列表滚动位,
 * 要的是**同一件**。所以它立成了 `ui/scroll-memory`(四条判例连同「写回必须在
 * layout cleanup」都在那儿),这里只剩**接线**:键是 `path`,数存在
 * `viewer-source` 的 `scrolls` 表里。行为逐字不变 —— 这一批的通过条件就是
 * 查看器既有那五个用例一字不改照过。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 *  ① 生命周期:两个 effect 跟着调用它的组件挂载 / 卸载。无订阅、无计时器、
 *     无模块级副作用 → 不需要 HMR dispose。
 *  ② UI 生命状态:无自有状态。读 store 一格、写 store 一格。
 *  ③ UI 交互状态:无。它不画东西。
 */
export interface ViewerScrollContext {
  /** 当前行(1 基;0 / undefined = 还没落过点,那时不滚)。 */
  currentLine: number | undefined
  /** 这一份实例是哪个文件 —— 贴回去的那个数按它取。 */
  path: string
}

/** 形状就是库件的 `ScrollMemory` —— 这一层只是给它一个查看器口径的名字。 */
export type ViewerScroll = ScrollMemory

export function useViewerScroll(
  bodyRef: RefObject<HTMLElement | null>,
  { currentLine, path }: ViewerScrollContext,
): ViewerScroll {
  const setScrollTop = useViewerSource((st) => st.setScrollTop)

  /* ── ① 律④ 跳转滚动不闪:落点之后把那一行滚到视野中间 ───────────────── */
  useEffect(() => {
    if (!currentLine) return
    const el = bodyRef.current?.querySelector(`[data-line="${currentLine}"]`)
    // 不重挂 body、不改高度 —— 只是滚过去。
    el?.scrollIntoView({ block: 'center' })
  }, [bodyRef, currentLine, path])

  /* ── ②③ 换宿主不丢滚动位 + 抄进 store —— 整件是 `ui/scroll-memory` ─────
   * 读 `getState()` 而不是订阅:订阅了就等于每一帧滚动都重渲这块面。
   * 高亮是懒加载的,所以极长的文件在首帧可能还没排到那么高 —— 那时贴不满是
   * 事实(浏览器把 scrollTop 钳到当下的可滚范围),这一档写在库件的数据状态里。 */
  const ports = useMemo(
    () => ({
      read: (key: string) => useViewerSource.getState().scrolls[key],
      write: setScrollTop,
    }),
    [setScrollTop],
  )
  return useScrollMemory(bodyRef, path, ports)
}
