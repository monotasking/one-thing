import { useCallback, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useContentDrag } from './useContentDrag'
import { parseRefId } from './kinds'
import type { PaneLeafNode } from './tree'

/**
 * **一格 tab 就是一个拖拽来源**(W3 裁定 6)。
 *
 * `ui/Tabs` 早就把「按住一格 tab」这件事透传出来了(`onTabPointerDown`,W4 为
 * 架子的撕出立的口),而 W3 之前它只有**一个**消费者(架子),而且那一路只对
 * **瓦**成立 —— 浮窗的三张表都按瓦 id 记,一个文件没有瓦 id(W4 的诚实降级,
 * 留账 2)。
 *
 * 这只 hook 把那一口接到统一的拖拽上,于是三处 tab 一次全通:
 *   中央区顶栏那一组(`TopBarTabs.LeafTabGroup`)
 *   架子叶与浮窗根叶的檐(`PaneLeaf.PaneLeafStrip`)
 *   分屏出来的那几片叶(同上 —— 它们画的是同一件檐)
 * 而 W4 留账 2 顺手结清:**任何一种 ref 都撕得出浮窗**,窗号由 `nextFloatId` 铸
 * (判词在 `drop-commit.dropRef` 的最后一段)。
 *
 * ── 被拖的 tab 不离开这条檐 ─────────────────────────────────────────────
 * 「树 / 面常驻铁律」的拖拽版(设计 §3.1 末句:「拖拽起手时,被拖的行不离开
 * 列表,只在浮影上动」)。所以这只 hook 一个字都不改树 —— 落定那一刻才改。
 * 从架子上撕一格 tab 因此**换了手感**:W4 之前那一路是「过阈值当场变浮窗、
 * 之后每帧 `moveFloat`」,现在是「浮影跟指针 + 一圈窗子轮廓预示,松手成窗」。
 * 这是设计 §3 定的统一模型(五种来源同一套),记在交卷报告的可感知变化里。
 */
export function useTabDrag(leaf: PaneLeafNode): (id: string, e: ReactPointerEvent<HTMLElement>) => void {
  /*
   * 按下的是**哪一格**要在起拖那一刻答得出来,而 `useContentDrag` 的 `ref()`
   * 是无参的(它不认识 tab 条)。所以按下时先记一格,起拖时读它 —— 与
   * `DragSession` 里「走过阈值才问来源」的次序对得上。
   */
  const pending = useRef<string | null>(null)
  const leafRef = useRef(leaf)
  leafRef.current = leaf

  const start = useContentDrag({
    ref: () => {
      const id = pending.current
      if (!id) return null
      // 从这条檐上那几格里取 —— 认的是**这片叶此刻装着的**,不是一个裸字符串。
      const found = leafRef.current.tabs.find((tab) => parseRefId(id)?.key === tab.key
        && parseRefId(id)?.kind === tab.kind)
      return found ?? null
    },
  })

  return useCallback(
    (id: string, e: ReactPointerEvent<HTMLElement>) => {
      pending.current = id
      start(e)
    },
    [start],
  )
}
