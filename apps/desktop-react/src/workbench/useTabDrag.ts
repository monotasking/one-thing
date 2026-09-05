import { useCallback, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { TEAR_OFF_DISTANCE } from '../stage/transitions'
import { tabStripChoreo } from '../ui/tab-reorder'
import { useContentDrag } from './useContentDrag'
import { reorderTab } from './drop-commit'
import { parseRefId, refId } from './kinds'
import type { TabStripChoreo } from '../ui/tab-reorder'
import type { PaneLeafNode } from './tree'

/**
 * **一格 tab 就是一个拖拽来源**(W3 裁定 6;W3-b 改甲「浏览器式」)。
 *
 * `ui/Tabs` 早就把「按住一格 tab」这件事透传出来了(`onTabPointerDown`,W4 为
 * 架子的撕出立的口),这只 hook 把那一口接到统一的拖拽上,于是三处 tab 一次全通:
 *   中央区顶栏那一组(`TopBarTabs.LeafTabGroup`)
 *   架子叶与浮窗根叶的檐(`PaneLeaf.PaneLeafStrip`)
 *   分屏出来的那几片叶(同上 —— 它们画的是同一件檐)
 *
 * ── W3-b:一次手势,两种模式,一条会话(裁定 4/5)──────────────────────
 *
 * 用户 09-05 看真机后的两句话定死了这只文件的形:**「换序做不到」**(拖一格 tab
 * 只会冒出一枚浮影,松手什么都不发生 —— 最常做的那一下没有实现)与**「手和东西
 * 是分开的」**(手按着 tab,动的却是旁边一枚芯片)。所以:
 *
 *   **换序模式**  指针在**本条的带内**(条的上下缘外扩 `TEAR_OFF_DISTANCE` 24)。
 *                 那一格 tab 自己被抬起来横向跟手、邻居用 `transform` 让位,
 *                 **浮影一个节点都不画**;松手 = 一次同叶 `reorderTab` + 播报。
 *   **撕下模式**  指针离开带。抬起收掉,那一格在原位**折成 0 宽**(元素不卸载
 *                 —— 树 / 面常驻铁律的拖拽版,也是零重挂断言盯的那一格),
 *                 浮影换成一张 tab 形卡片;回到**任何一条**标签条的带里,
 *                 那条条就腾出一格空位,松手插到那个下标。
 *
 * 两种模式**共用一条 `DragSession`**:模式由那一件唯一的「带」判据每帧报回来
 * (`DragBandState`),这里只是它的消费者。第二条会话会在 Esc / pointercancel /
 * 窗口失焦三条路上各漏一次归零 —— 而「Esc 之后 tab 还折着」是用户当场看得见的。
 *
 * ── 这一场的全部瞬态住在三格 ref 里,`endGesture()` 是唯一那口拆卸 ──────────
 * `useContentDrag` 的 `onEnd` 在**三条结束路径**上都叫(落定 / Esc / 指针没了),
 * 所以拆卸只有一份、幂等。模块作用域里一个 `let` 都没有:那会是第二条会话,
 * 而且会活过一次热更(CLAUDE.md 那条「模块级副作用」的法)。
 *
 * ── 被拖的 tab 不离开这条檐 ─────────────────────────────────────────────
 * 这只 hook 一个字都不改树 —— 落定那一刻才改。撕下时那一格只是**折起来**,
 * 属性一摘就原样展回;Esc 之后树逐字不变(`gate:drag` 场景守着这一条)。
 */
export function useTabDrag(leaf: PaneLeafNode): (id: string, e: ReactPointerEvent<HTMLElement>) => void {
  /*
   * 按下的是**哪一格**要在起拖那一刻答得出来,而 `useContentDrag` 的 `ref()`
   * 是无参的(它不认识 tab 条)。所以按下时先记一格,起拖时读它 —— 与
   * `DragSession` 里「走过阈值才问来源」的次序对得上。
   */
  const pending = useRef<{ id: string; x: number } | null>(null)
  const leafRef = useRef(leaf)
  leafRef.current = leaf
  /** 本条条的编舞(抬起 / 让位 / 折起)。造在起拖那一刻,`endGesture` 收。 */
  const own = useRef<TabStripChoreo | null>(null)
  /** 落在**别人**那条条上时,那条条的编舞(只用来腾空位)。 */
  const foreign = useRef<{ list: HTMLElement; choreo: TabStripChoreo } | null>(null)
  /** 换序此刻算出来的落点下标(每帧由 `track` 交回来)。 */
  const at = useRef<number | null>(null)

  /** 这一场留下的一切。**幂等**,三条结束路径都走它。 */
  const endGesture = useCallback(() => {
    own.current?.reset()
    own.current = null
    foreign.current?.choreo.clearGap()
    foreign.current = null
    at.current = null
  }, [])

  const start = useContentDrag({
    ref: () => {
      const held = pending.current
      if (!held) return null
      // 从这条檐上那几格里取 —— 认的是**这片叶此刻装着的**,不是一个裸字符串。
      const parsed = parseRefId(held.id)
      const found = leafRef.current.tabs.find(
        (tab) => parsed?.key === tab.key && parsed?.kind === tab.kind,
      )
      if (!found) return null
      /*
       * 编舞认的是**这一格 tab 元素所在的那条 tablist**,不是「这片叶的檐」——
       * 中央区那一组标签住在窗口顶栏,DOM 上根本不在叶里(设计 §2.2 的 D 稿)。
       * 从元素自己往上找是四个宿主唯一都成立的那条路。
       */
      const el = document.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(held.id)}"]`)
      const list = el?.closest<HTMLElement>('[role="tablist"]') ?? null
      own.current = list ? tabStripChoreo(list) : null
      at.current = null
      return found
    },

    /** 带 = 这条条自己此刻的矩形(每帧问一次 —— 条会横滚、会因让位重排)。 */
    band: () => own.current?.rect() ?? null,
    bandSlack: TEAR_OFF_DISTANCE,

    inline: {
      enter: (pointer) => {
        const held = pending.current
        if (!held) return
        // 回到带里 = 折起来那一格展回来、别人那格空位收掉,再抬起。都幂等。
        foreign.current?.choreo.clearGap()
        foreign.current = null
        own.current?.reset()
        own.current?.lift(held.id, held.x)
        at.current = own.current?.track(pointer.x) ?? null
      },
      move: (pointer) => {
        at.current = own.current?.track(pointer.x) ?? null
      },
      leave: () => {
        // 出带:抬起收掉,原位折成 0 宽 —— 邻居合拢,像它已经走了。
        const held = pending.current
        if (held) own.current?.tear(held.id)
        at.current = null
      },
      drop: () => {
        const held = pending.current
        const next = at.current
        if (!held || next === null) return true
        const from = leafRef.current.tabs.findIndex((tab) => refId(tab) === held.id)
        if (from < 0) return true
        /*
         * **同一只 `reorderTab`**,菜单里的「左移 / 右移」走的也是它(裁定 8)。
         * 播报在那一只里,因为播报是**落定**的一部分:两条路各写一句,迟早分叉。
         */
        reorderTab(leafRef.current.id, from, next)
        return true
      },
    },

    /**
     * 撕下模式下,指针回到**任何一条**标签条的带内时,那条条腾出一格空位。
     * 「哪条条、第几格」整件是纯函数 `./drop` 算的,这里只把那个结论画出来 ——
     * 于是预示与松手的结果在结构上不可能对不上。
     */
    onTarget: (target) => {
      /*
       * **折起来这一下在这里保底**(幂等):`inline.leave` 只在「从带里出来」那一刻
       * 叫得到,而一次手势**不一定进过带** —— 把 tab 往下猛地一甩,过阈值那一帧
       * 指针已经在条外了。带外每一帧都走这里,所以它是那一形唯一到得了的地方。
       */
      const held = pending.current
      if (held) own.current?.tear(held.id)
      if (target.kind !== 'strip') {
        foreign.current?.choreo.clearGap()
        foreign.current = null
        return
      }
      const list = document.querySelector<HTMLElement>(
        `[data-pane-chrome="${CSS.escape(target.leafId)}"] [role="tablist"]`,
      )
      if (!list) return
      if (foreign.current?.list !== list) {
        foreign.current?.choreo.clearGap()
        foreign.current = { list, choreo: tabStripChoreo(list) }
      }
      /*
       * 空位多宽:照那条条上第一格 tab 的宽。用「卡片自己的宽」也说得通,但卡片
       * 在**这条**条上不一定是这个宽(每条条的 `--tab-max-w` 夹紧点不同),
       * 拿目标条自己的尺寸量才是「它落进来会占多少」。
       */
      const sample = list.querySelector<HTMLElement>('[data-tab-id]')
      foreign.current.choreo.gapAt(target.at, sample?.getBoundingClientRect().width ?? 0)
    },

    onEnd: endGesture,
  })

  return useCallback(
    (id: string, e: ReactPointerEvent<HTMLElement>) => {
      pending.current = { id, x: e.clientX }
      start(e)
    },
    [start],
  )
}
