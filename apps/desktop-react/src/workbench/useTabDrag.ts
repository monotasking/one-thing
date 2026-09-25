import { useCallback, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { TEAR_OFF_DISTANCE } from '../stage/transitions'
import { DRAG_START_X } from '../ui/drag'
import { tabStripChoreo } from '../ui/tab-reorder'
import { regionOfTarget, useContentDrag } from './useContentDrag'
import { reorderTab } from './drop-commit'
import { stripBandOf } from './drop-geometry'
import { parseRefId, refId } from './kinds'
import { canDetachTab, regionOfLeafIn, useWorkbenchStore } from './store'
import type { MessageKey } from '../i18n'
import type { TabStripChoreo } from '../ui/tab-reorder'
import type { DropTarget } from './drop'
import type { PaneLeafNode } from './tree'

/**
 * **一格 tab 就是一个拖拽来源**(W3 裁定 6;W3-b 改甲「浏览器式」;W6-b 按设计
 * `apps/desktop-react/docs/workbench-tabs-2026-09.md` §4.2 那张状态机重做;
 * U2 2026-09-08 删掉 onto 那一档、给取消补上滑回)。
 *
 * `ui/Tabs` 早就把「按住一格 tab」这件事透传出来了(`onTabPointerDown`),这只
 * hook 把那一口接到统一的拖拽上,于是三处 tab 一次全通:中央区顶栏那一组
 * (`TopBarTabs.LeafTabGroup`)、架子叶与浮窗根叶的檐、分屏出来的那几片叶
 * (`PaneLeaf.PaneLeafStrip`)。
 *
 * ── 状态机(U2 之后的样子)──────────────────────────────────────────────
 * ```
 * idle ──按下(**只认主键**)──▶ pressed(当场激活这一格;光标 grabbing;标签不动、不变色)
 * pressed ──松手,位移 < 6──▶ idle(一次点击,到此为止)
 * pressed ──|Δx| ≥ 6──▶ reorder          （DRAG_START_X）
 * pressed ──|Δy| ≥ 24──▶ tear            （TEAR_OFF_DISTANCE)
 * reorder ──y 超过条底缘 + 24(出带)──▶ tear ──回到带内──▶ reorder
 * reorder ──松手──▶ moveTab + 150ms 滑进新槽 + 落定闪一圈
 * tear ──松手──▶ 按 §5 的落点表落定
 * reorder ──Esc / pointercancel / 窗口失焦──▶ **150ms 滑回原位**,树一字不变
 * tear   ──Esc / pointercancel / 窗口失焦──▶ 原位展回(摘 `data-torn`),树一字不变
 * ```
 *
 * ── U2 删掉的那一档:onto(2026-09-08,用户裁定)────────────────────────
 * 从前 `reorder` 与 `tear` 之间还夹着一档 `onto`:指针压到条底缘下 6–24px
 * (`ONTO_FROM_PX` ~ `TEAR_OFF_DISTANCE`)时邻居的让位全部清零、指针底下那一格
 * 描一圈、浮影只剩一行「与「X」二合一」,松手就是 `pairIntoIndex`。
 *
 * **真机(09-08 离屏探针)量出来它是看不见的**:那一圈被抬起的那一格盖住 92%
 * —— 抬起那格 `z-index: 2`、底色不透明,而这一形里它照旧横向跟手,于是它正压在
 * 指针底下那一格上。设计 §4.2 自己就冲突(一边「邻居不再让位、指针底下那个标签
 * 描圈亮起」,一边「被拖那格照旧跟手」)。用户的裁定是**整条带删掉**:二合一只剩
 * 一种手势 —— 拖到内容区左右两侧(`PAIR_BAND` 28%);那一档 09-24 也退役,内容区四边
 * 改成分屏带(`drop.SPLIT_BAND`),二合一只剩右键菜单。
 *
 * **带的下沿一个字没动**(`bandSlack = TEAR_OFF_DISTANCE`):压到条底缘下 6–24px
 * 现在**仍是换序**,再往下才是撕下 —— 那条带整段并回了换序,不留死区。
 * 一起退役的是 `ONTO_FROM_PX` / `ui/tab-reorder` 的 `hover()` / `markPair()` /
 * `[data-pair-hot]` / `--drop-ring-line` / `DragPresentation` 的 `'hint'` 档,
 * 以及这只文件从前的 `pairIntoTab` / `pairHintFor` / `leaveOnto`。
 *
 * **「按下即激活」不在这只文件里**,在 `LeafStrip`:那一句是「切一格标签」的
 * 语义(它还要把焦点送进内容),而这只 hook 只管手势。两者在 `onTabPointerDown`
 * 那一口上前后脚发生 —— 判词与调用序(以及「只认主键」那一句)写在 `LeafStrip` 上。
 *
 * ── 一次手势,两种模式,一条会话(裁定 4/5;U2 从三种收成两种)──────────
 *   **换序**   指针在**本条的带内**(条的上下缘外扩 `TEAR_OFF_DISTANCE` 24),
 *              **而且没有真的落在别人那条条上**(见 `ownStripLeafId` 那一段)。
 *              那一格 tab 自己被抬起来横向跟手、邻居用 `transform` 让位,
 *              **浮影一个节点都不画**;松手 = 一次同叶 `reorderTab` + FLIP 滑入。
 *   **撕下**   指针离开带。抬起收掉,那一格在原位**折成 0 宽**(元素不卸载
 *              —— 树 / 面常驻铁律的拖拽版,也是零重挂断言盯的那一格),
 *              浮影换成一张 tab 形卡片,落点整件交给 §5 那张表。
 *
 * 两种模式**共用一条 `DragSession`**:模式由那一件唯一的「带」判据每帧报回来
 * (`DragBandState`),这里只是它的消费者。第二条会话会在 Esc / pointercancel /
 * 窗口失焦三条路上各漏一次归零 —— 而「Esc 之后 tab 还折着」是用户当场看得见的。
 *
 * ── 这一场的全部瞬态住在几格 ref 里,`endGesture()` 是唯一那口拆卸 ──────────
 * `useContentDrag` 的 `onEnd(reason)` 在**三条结束路径**上都叫(落定 / Esc /
 * 指针没了),所以拆卸只有一份、幂等。模块作用域里一个 `let` 都没有:那会是
 * 第二条会话,而且会活过一次热更(CLAUDE.md 那条「模块级副作用」的法)。
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
  /** 本条条的编舞(抬起 / 让位 / 折起 / 滑入)。造在起拖那一刻,`endGesture` 收。 */
  const own = useRef<TabStripChoreo | null>(null)
  /** 换序此刻算出来的落点下标(每帧由 `track` 交回来)。 */
  const at = useRef<number | null>(null)
  /** 自己那条条的 tablist(`band` 按它量那块地)。与 `own` 同生同死。 */
  const ownList = useRef<HTMLElement | null>(null)

  /**
   * **这一场留下的一切**。幂等,三条结束路径都走它;`reason` 决定那一格 tab
   * 怎么回去(U2)。
   *
   *   `drop`    落定那条路:`inline.drop` 已经先量后改、把滑入排好了
   *             (见下面 `drop()` 的判词),这里只负责把属性清干净。
   *   `cancel`  Esc / pointercancel / 窗口失焦。**还在带里**(编舞手上还抬着
   *             那一格)= 150ms 滑回原位;**已经撕下**(折着)= `reset()` 摘掉
   *             `data-torn`,那一格在原位展回来(卡片的弹回由 `DragSession` 的
   *             `landingRect` 管,与这里无关)。
   *
   * 「此刻在不在带里」问的是**编舞自己那格状态**(`lifted()`),不是这里另存一格
   * 布尔 —— 后者就是 `DragBandState` 文件头点名的那条「第二条会话」,而它恰好会在
   * 这三条路上各漏一次归零。
   */
  const endGesture = useCallback((reason: 'drop' | 'cancel') => {
    const choreo = own.current
    const held = choreo?.lifted() ?? null
    if (reason === 'cancel' && choreo && held !== null) {
      slideBack(choreo, held)
    } else {
      choreo?.reset()
    }
    own.current = null
    ownList.current = null
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
       * 中央区那一组标签住在窗口顶栏,DOM 上根本不在叶里(设计 v2 §2.2 的 D 稿)。
       * 从元素自己往上找是四个宿主唯一都成立的那条路。
       */
      const el = document.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(held.id)}"]`)
      const list = el?.closest<HTMLElement>('[role="tablist"]') ?? null
      own.current = list ? tabStripChoreo(list) : null
      ownList.current = list
      at.current = null
      return found
    },

    /**
     * **两轴两个数**(设计 v3 §4.2):横向 6px 起换序,竖向 24px 才撕下。
     * 判据是「任一轴走过它自己那个数」——不是欧氏距离,理由写在
     * `DragSourceSpec.threshold` 上。
     */
    threshold: { x: DRAG_START_X, y: TEAR_OFF_DISTANCE },

    /**
     * 带 = 这条条此刻收东西的那块地(每帧问一次 —— 条会横滚、会因让位重排)。
     *
     * **与落点判据量的是同一块地**(09-25,`drop-geometry.stripBandOf`):顶栏那条条
     * 一直铺到顶栏右缘。从前这里只量 tablist 自己,末格右边那片空白于是出了带 ——
     * 手一挪过去就从跟手换序切成浮影 + 插空位,同一条条上两种表现来回闪。现在那片
     * 空白也在带里:被抬起那格顶在条的右端(`lift` 的夹取),松手 = 挪到末位。
     */
    band: () => {
      const list = own.current ? ownList.current : null
      if (!list?.isConnected) return null
      const r = stripBandOf(list)
      return { left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height }
    },
    /**
     * 带的上下外扩 24 = `TEAR_OFF_DISTANCE`:越过它就是出带 = 撕下。
     *
     * U2 之前带的**下半截**还被切成两段(条底缘 + 6 到 + 24 是「放到标签上」);
     * 那一档删掉之后这条带只有一种解释 —— 在带里就是换序。
     */
    bandSlack: TEAR_OFF_DISTANCE,

    /**
     * **这条条是「自己那条」**(U2)。`useContentDrag` 拿它答一句话:指针真的
     * 落在**别人**那条条上时,自己的外扩带这一帧不算数(判词整段在
     * `useContentDrag.onForeignStrip` 上)。
     */
    ownStripLeafId: () => leafRef.current.id,

    /**
     * **这一场自己的规矩:常驻那一格不许被撕出它的家**(U3,2026-09-08)。
     *
     * 判据**不新写** —— `store.canDetachTab` 那一只(种类自述的 `resident`,
     * 加上 U3 那第四个参数「这片叶在哪个区域」)。「关得掉」与「挪得走」问的是
     * 同一句话:**这个区域里这一种还剩不剩第二格**;两处各写一遍就是两条会漂的
     * 判据,而漂开的那一天屏幕上会出现「✕ 画不出来,却拖得走」。
     *
     * 产地在这里是因为**只有这一层知道拖的是一格标签**:五种来源共用的那一只
     * (`useContentDrag`)手上只有一个 `ref`,答不出「它此刻是哪片叶的第几格」。
     *
     * 三档:
     *   落回自己那片叶(`back`)     → 放行(空动作,连拖都不算数)
     *   落点仍在**本区域**          → 放行(条内换序、同区域另一片叶,都不动家)
     *   其余(架子 / 浮窗 / 别的条) → 拒绝,一句 `drag.refuseResidentLeave`
     *
     * 落点算不出区域(`null`)一律当**离开**:一个我们指不出地方的落点,不该被
     * 当成「还在原地」放过去。
     */
    rules: { accepts: (target) => residentRefusal(leafRef.current, pending.current?.id ?? null, target) },

    inline: {
      enter: (pointer) => {
        const held = pending.current
        if (!held) return
        // 回到带里 = 折起来那一格展回来,再抬起。都幂等。
        own.current?.reset()
        own.current?.lift(held.id, held.x)
        follow(pointer)
      },
      // 包一层而不是直接把 `follow` 交出去:它是下面那个 `const`,直接写在对象
      // 字面量里就是一次 TDZ 读(这只 spec 在渲染中当场构造)。闭包读的永远是
      // 这一次渲染的那一只 —— `useContentDrag` 把 spec 存在 ref 里逐帧更新。
      move: (pointer) => follow(pointer),
      leave: () => {
        // 出带:把原位折成 0 宽 —— 邻居合拢,像它已经走了。
        const held = pending.current
        if (held) own.current?.tear(held.id)
        at.current = null
      },
      drop: () => {
        const held = pending.current
        if (!held) return true
        const next = at.current
        if (next === null) return true
        const from = leafRef.current.tabs.findIndex((tab) => refId(tab) === held.id)
        if (from < 0) return true
        /*
         * **收笔先量后改**:滑入那一程要的是「它此刻在手上的位置」,而
         * `reorderTab` 一改树 React 就把那一格挪走了。所以先量,再改,再交给
         * 编舞去 FLIP(它自己等一帧,判词在 `tabStripChoreo.settle` 上)。
         */
        const liveLeft = liveLeftOf(held.id)
        /*
         * **同一只 `reorderTab`**,菜单里的「左移 / 右移」走的也是它(裁定 8)。
         * 播报在那一只里,因为播报是**落定**的一部分:两条路各写一句,迟早分叉。
         */
        reorderTab(leafRef.current.id, from, next)
        if (liveLeft !== null) own.current?.settle(held.id, liveLeft)
        return true
      },
    },

    /**
     * **带外每一帧的保底:把源那一格折起来**(幂等)。
     *
     * 从前这一口还兼管「目标条腾一格空位」—— W6-b 把那件事整件搬进了
     * `useContentDrag`(五种来源统一,设计 §9 落差表那一行:文件行 / 会话行 /
     * 项目行 / Dock 瓦拖到标签条上从前屏幕上什么都不出现)。这里只剩折起来。
     *
     * 它非留不可:`inline.leave` 只在「从带里出来」那一刻叫得到,而一次手势
     * **不一定进过带** —— 把 tab 往下猛地一甩,过阈值那一帧指针已经在条外了。
     * 带外每一帧都走这里,所以它是那一形唯一到得了的地方。
     */
    onTarget: () => {
      const held = pending.current
      if (held) own.current?.tear(held.id)
    },

    onEnd: endGesture,
  })

  /**
   * **带内每一帧**:整条交给编舞。
   *
   * U2 之前这里还要先判「这一帧是换序还是放到标签上」(指针的 y 有没有低于条
   * 底缘 `ONTO_FROM_PX`),然后在两条分支里各写一次呈现、提示行与描圈。那一档
   * 删掉之后,带内**只剩一句话**:把这一帧交给 `track()`,它自己写跟手与让位,
   * 答落点下标。呈现与提示行都不归这里管了 —— 进带那一发由 `useContentDrag`
   * 写成 `inline` / `null`,带内每一帧一个字都不写(§4.5 第 3 条)。
   */
  const follow = useCallback((pointer: { x: number; y: number }) => {
    at.current = own.current?.track(pointer.x) ?? null
  }, [])

  return useCallback(
    (id: string, e: ReactPointerEvent<HTMLElement>) => {
      pending.current = { id, x: e.clientX }
      start(e)
    },
    [start],
  )
}

/**
 * **这一下会不会把常驻那一格撕出它的家**(U3;判词整段在 `rules` 那一格上)。
 *
 * 纯读:store 只 `getState()` 不订阅 —— 落点判据跑在 pointermove 里,那是事件
 * 不是渲染。拖拽期间树被 `dragging` 那道闸冻住,所以这一读与起拖那一刻逐字相同。
 */
export function residentRefusal(
  leaf: PaneLeafNode,
  draggedId: string | null,
  target: DropTarget,
): MessageKey | null {
  if (!draggedId || target.kind === 'back') return null
  const regions = useWorkbenchStore.getState().regions
  const region = regionOfLeafIn(regions, leaf.id)
  const tree = region ? regions[region] : undefined
  if (!region || !tree) return null
  const index = leaf.tabs.findIndex((tab) => refId(tab) === draggedId)
  if (index < 0) return null
  // 关得掉 = 挪得走。这一只是那句话的唯一产地(`store.canDetachTab`)。
  if (canDetachTab(tree, leaf.id, index, region)) return null
  const to = regionOfTarget(target, (id) => regionOfLeafIn(regions, id))
  return to === region ? null : 'drag.refuseResidentLeave'
}

/** 那一格 tab 此刻在手上的左缘(收笔那一程的起点)。摘不到就答 null。 */
const liveLeftOf = (id: string): number | null =>
  document.querySelector(`[data-tab-id="${CSS.escape(id)}"]`)?.getBoundingClientRect().left
  ?? null

/**
 * **树一个字不变,那一格 150ms 滑回原位**(U2:Esc / pointercancel / 窗口失焦)。
 *
 * 设计 §4.2 最后一行写的就是「任何态 ── Esc / pointercancel / 窗口失焦 ──▶ 滑回
 * 原位(150ms),树一字不变」,而 U2 之前**这三条路都是瞬移**:`endGesture` 只
 * `reset()` 不 `settle()`,一摘 transform 那一格 5ms 就到家、连 `data-settle` 都
 * 不挂一次(09-08 真机探针读到的正是这个)。
 *
 * 收法与换序落定同一只 `settle()`:**先量它此刻在手上的位置**,再 `reset()`
 * 摘掉抬起与 transform,`settle` 自己排在一帧之后把它 FLIP 回去(判词在
 * `tabStripChoreo.settle` 上)。次序不能反 —— reset 之后再量,量到的是它已经
 * 回到原位的样子,FLIP 的位移是 0,屏幕上还是瞬移。
 */
function slideBack(choreo: TabStripChoreo, id: string): void {
  const from = liveLeftOf(id)
  choreo.reset()
  if (from !== null) choreo.settle(id, from)
}
