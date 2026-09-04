import { useLayoutEffect, useRef } from 'react'
import { CENTER_REGION } from './regions'
import { spanWVar, spanXVar } from './layout'
import type { RefObject } from 'react'

/**
 * **中央区那几片叶此刻各占哪一段宽度**(W1-b,设计 §2.2)。
 *
 * 顶栏上的标签组要「精确坐在各叶的正上方」。叶的四个边是一串 `calc()`(见
 * `layout.ts`),那串式子相对的是**中央区那棵树的容器**,而顶栏在另一棵子树里 ——
 * 两边没有共同的定位参考系,所以这件事只有**真实的排版**说得出来。判法与
 * `AppShell` 的 `useComposerGeometry` 逐字同型:量出来,写成两格 CSS 变量,
 * 让下游用 `calc()` 读。
 *
 * ── 为什么由顶栏那条带来量,而不是每片叶自己上报 ─────────────────────────
 * 派工规格里写的是「每片中央叶量自己的 left/width」。真写起来那样要多一条
 * **跨模块的发布总线**(叶写、顶栏读),而总线是模块级状态 —— 要配 HMR 退役、
 * 要处理「叶先挂还是顶栏先挂」。这里换成**消费方自己量**:顶栏本来就知道它要
 * 哪几个节点的跨度(`topStrips` 给的 `spanId`),`document.querySelector` 一次
 * 就够。DOM 插入发生在 React 提交的 mutation 相位,**早于任何 layout effect**,
 * 所以顶栏的 effect 跑起来时那些格子一定已经在 DOM 上了(哪怕顶栏在树里排在
 * 中央区前面)。取件口钉在中央区那棵树里(`[data-pane-region=center]`),
 * 将来浮窗里的树长出来也不会被这一句误认。
 *
 * ── 变量写在哪儿 ────────────────────────────────────────────────────────
 * 写在**宿主自己身上**(顶栏那条带),值是**相对宿主左缘**的偏移。于是标签组的
 * `left` 直接就是 `var(--leaf-x-…)`,不必再知道顶栏让位有多宽 —— 那一段是
 * `.traffic` 那块真元素占的,带子从它右边起。
 *
 * ── 什么时候重量 ────────────────────────────────────────────────────────
 *  · `ResizeObserver`:叶或宿主的**尺寸**变了 —— 拖分隔杆、架子收展、窗口改尺寸、
 *    进出全屏(让位 80 → 16,带子跟着变宽)。拖杆那几十帧走的正是这一条,
 *    一帧都不经过 React;
 *  · **每一次渲染**(下面那只无依赖的 layout effect):位置变了而尺寸没变的那些形。
 *    真实存在一格:Dock 的让位边从左换到右时 `.center` 的内容盒整体平移,叶的
 *    border-box 尺寸一个像素没动,`ResizeObserver` 一声不吭。那一下必然伴随外壳
 *    重渲(`data-dock-reserve` 就在壳根上),所以「渲染即重量」正好接住它。
 *    代价是每次渲染几次 `getBoundingClientRect()` —— 组数就是叶数,个位数。
 *
 * ── 为什么不会打转 ──────────────────────────────────────────────────────
 * 写这两格变量只影响顶栏上标签组的 left/width,而标签组**永不换行**(挤压纪律),
 * 所以它改不动顶栏的高度,也就改不动中央区的高度与叶的尺寸。没有回路,
 * `ResizeObserver` 的「循环」告警不会来。
 *
 * ── 生命周期 ────────────────────────────────────────────────────────────
 * 挂载即量、卸载即断开并**把写过的变量逐格抹掉**(留着等于让下一次挂载先读到
 * 一份陈旧的几何)。组件级,不是模块级 —— 没有跨模块存活的东西,不需要 HMR dispose。
 */
export function useLeafGeometry(
  hostRef: RefObject<HTMLElement | null>,
  spanIds: readonly string[],
): void {
  /*
   * 依赖表里放的是**拼起来的那一串**,不是数组本身:`spanIds` 每渲染都是新数组,
   * 进依赖表等于每渲染重建一次 observer(而 observer 重建 = 一次 disconnect +
   * 一次 observe,那正是「树没变也要重来一遍」)。
   */
  const key = spanIds.join('|')
  const measureRef = useRef<(() => void) | null>(null)

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    const ids = key ? key.split('|') : []

    const measure = () => {
      const base = host.getBoundingClientRect()
      for (const id of ids) {
        const el = spanElement(id)
        if (!el) continue
        const box = el.getBoundingClientRect()
        // 取整:半像素的抖动会让标签组每帧都换一个 left,肉眼看是边缘在呼吸。
        host.style.setProperty(spanXVar(id), `${Math.round(box.left - base.left)}px`)
        host.style.setProperty(spanWVar(id), `${Math.round(box.width)}px`)
      }
    }
    measureRef.current = measure
    measure()

    // jsdom 里没有 ResizeObserver —— 那时只剩「渲染即重量」那一条,用例照跑。
    if (typeof ResizeObserver !== 'function') {
      return () => {
        measureRef.current = null
        clearSpans(host, ids)
      }
    }
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    for (const id of ids) {
      const el = spanElement(id)
      if (el) observer.observe(el)
    }
    return () => {
      observer.disconnect()
      measureRef.current = null
      clearSpans(host, ids)
    }
  }, [hostRef, key])

  /*
   * 无依赖表 = 每次渲染都跑。它排在上面那只之后,所以首次挂载时 `measureRef`
   * 已经装好;后面的渲染里若 `key` 没变,上面那只不重跑,这里用的就是上一次
   * 装进去的那只闭包(host 与 ids 都还对)。
   */
  useLayoutEffect(() => {
    measureRef.current?.()
  })
}

/** 一个节点(叶或切分)在中央区那棵树里的取件口。产地只此一处。 */
function spanElement(nodeId: string): Element | null {
  return document.querySelector(
    `[data-pane-region="${CENTER_REGION}"] [data-pane-span="${cssAttrValue(nodeId)}"]`,
  )
}

function clearSpans(host: HTMLElement, ids: readonly string[]): void {
  for (const id of ids) {
    host.style.removeProperty(spanXVar(id))
    host.style.removeProperty(spanWVar(id))
  }
}

/**
 * 属性选择器里的那一段字符串。叶 / 切分 id 是 `leaf-<戳>-<序>` 这一形
 * (产地 `workbench/ids.ts`),没有需要转义的字符;这一句是**契约的守夜人** ——
 * 哪天 id 的形状变了,这里当场把引号与反斜杠转掉,而不是拼出一条非法选择器。
 */
function cssAttrValue(value: string): string {
  return value.replace(/["\\]/g, '\\$&')
}
