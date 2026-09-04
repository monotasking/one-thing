import { useCallback, useEffect, useLayoutEffect } from 'react'
import type { RefObject, UIEvent } from 'react'
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

export interface ViewerScroll {
  /** 挂到 `.body` 的 `onScroll` 上。 */
  onScroll: (event: UIEvent<HTMLElement>) => void
}

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

  /*
   * ── ② 换宿主不丢滚动位 ────────────────────────────────────────────────
   * 换宿主 = 这棵组件树真的重挂。挂上来的第一帧就把 store 里那个数贴回去,
   * 用户看到的是「同一份内容还停在原地」,而不是弹回顶上。
   *
   * `useLayoutEffect` 而不是 `useEffect`:后者在**画完之后**才跑,屏幕上会先闪
   * 一帧顶部。高亮是懒加载的,所以极长的文件在首帧可能还没排到那么高 ——
   * 那时贴不满是事实(浏览器把 scrollTop 钳到当下的可滚范围)。
   */
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    // 读 `getState()` 而不是订阅:订阅了就等于每一帧滚动都重渲这块面。
    el.scrollTop = useViewerSource.getState().scrolls[path] ?? 0
  }, [bodyRef, path])

  /* ── ③ 抄进 store 好让 ② 贴得回去 ──────────────────────────────────────
   * 没有组件订阅 `scrolls`,所以这一口每帧调都不引起重渲。 */
  const onScroll = useCallback(
    (event: UIEvent<HTMLElement>) => setScrollTop(path, event.currentTarget.scrollTop),
    [setScrollTop, path],
  )

  return { onScroll }
}
