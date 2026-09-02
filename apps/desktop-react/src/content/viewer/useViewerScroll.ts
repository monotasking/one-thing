import { useCallback, useEffect, useLayoutEffect } from 'react'
import type { RefObject, UIEvent } from 'react'
import { useViewerSource } from '../../data/viewer-source'

/**
 * **查看器的滚动三件**(09-02 批 9b 从 `FileViewer` 拆出)。
 *
 * 滚动**永远是查看器 `.body` 自己管**(那条不随落点变的裁定在 `FileViewer`
 * 文件头的落点生命周期表里)。既然归属只有一处,那三件跟它绑着的事就该在同一处:
 *
 *   ① 跳行之后把那一行滚到视野中间(律④:跳转滚动不闪);
 *   ② **换宿主之后把滚动位贴回去**(F2 兑现 F1 那条留账);
 *   ③ 每一帧滚动抄进 store,好让 ② 贴得回来。
 *
 * 三件是一条链:没有 ③ 就没有 ② 可贴的数,没有 ② 换落点就弹回顶上。
 * 从前它们散在组件里三处(两个 effect + 一个内联 `onScroll`),中间隔着七十行
 * JSX —— 改其中一件的人看不见另外两件。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 *  ① 生命周期:两个 effect 跟着调用它的组件挂载 / 卸载,`useLayoutEffect`
 *     那一件**每次换宿主或换文件都重跑**(那正是它存在的理由:换宿主 =
 *     一次生命周期事件)。无订阅、无计时器、无模块级副作用 → 不需要 HMR dispose。
 *  ② UI 生命状态:无自有状态。它读 store 的一格(`scrollTop`)、写 store 的一格,
 *     屏幕上的形完全由 `.body` 自己的 `overflow:auto` 决定。
 *  ③ UI 交互状态:无。它不画东西。
 */
export interface ViewerScrollContext {
  /** 当前行(1 基;0 / undefined = 还没落过点,那时不滚)。 */
  currentLine: number | undefined
  /** 换文件也要重贴一次滚动位:同一个宿主里换文件,`.body` 不重挂但内容全换了。 */
  path: string | undefined
  /** 换落点 = 换宿主 = 这棵树真的重挂,挂上来第一帧就得把数贴回去。 */
  placement: string
}

export interface ViewerScroll {
  /** 挂到 `.body` 的 `onScroll` 上。 */
  onScroll: (event: UIEvent<HTMLElement>) => void
}

export function useViewerScroll(
  bodyRef: RefObject<HTMLElement | null>,
  { currentLine, path, placement }: ViewerScrollContext,
): ViewerScroll {
  const setScrollTop = useViewerSource((st) => st.setScrollTop)

  /* ── ① 律④ 跳转滚动不闪:落点之后把那一行滚到视野中间 ───────────────── */
  useEffect(() => {
    if (!currentLine) return
    const el = bodyRef.current?.querySelector(`[data-line="${currentLine}"]`)
    // 不重挂 body、不改高度 —— 只是滚过去。行跳渲(content-visibility)下同样成立:
    // 浏览器会为滚动目标先把那一行排出来。
    el?.scrollIntoView({ block: 'center' })
  }, [bodyRef, currentLine, path])

  /*
   * ── ② 换落点不丢滚动位(F2 兑现 F1 那条留账)────────────────────────────
   * 换一档打开方式 = 换宿主 = 这棵组件树真的重挂。挂上来的第一帧就把 store 里
   * 那个数贴回去,用户看到的是「同一份内容还停在原地」,而不是弹回顶上。
   *
   * `useLayoutEffect` 而不是 `useEffect`:后者在**画完之后**才跑,屏幕上会先闪
   * 一帧顶部。高亮是懒加载的,所以极长的文件在首帧可能还没排到那么高 ——
   * 那时贴不满是事实(浏览器把 scrollTop 钳到当下的可滚范围),
   * 记在这里:要做到逐像素还原得等一台影子布局,不值当。
   */
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    // 读 `getState()` 而不是订阅:订阅了就等于每一帧滚动都重渲这块面。
    el.scrollTop = useViewerSource.getState().scrollTop
  }, [bodyRef, placement, path])

  /* ── ③ 抄进 store 好让 ② 贴得回去 ──────────────────────────────────────
   * 没有组件订阅 `scrollTop`,所以这一口每帧调都不引起重渲
   * (理由写在 viewer-source 文件头 ④)。 */
  const onScroll = useCallback(
    (event: UIEvent<HTMLElement>) => setScrollTop(event.currentTarget.scrollTop),
    [setScrollTop],
  )

  return { onScroll }
}
