import { useCallback, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { TEAR_OFF_DISTANCE } from '../stage/transitions'
import { DRAG_START_X, ONTO_FROM_PX, setDragPresentation, setDropFeedback } from '../ui/drag'
import { tabStripChoreo } from '../ui/tab-reorder'
import { useT } from '../i18n'
import { useLiveTitleStore } from '../stage/live-title'
import { useContentDrag } from './useContentDrag'
import { pairIntoIndex, reorderTab } from './drop-commit'
import { contentKindOf, parseRefId, partsOfContent, refId } from './kinds'
import { regionOfLeafIn, useWorkbenchStore } from './store'
import { findLeaf } from './tree'
import type { TabStripChoreo } from '../ui/tab-reorder'
import type { PaneLeafNode } from './tree'

/**
 * **一格 tab 就是一个拖拽来源**(W3 裁定 6;W3-b 改甲「浏览器式」;W6-b 按设计
 * `apps/desktop-react/docs/workbench-tabs-2026-09.md` §4.2 那张状态机重做)。
 *
 * `ui/Tabs` 早就把「按住一格 tab」这件事透传出来了(`onTabPointerDown`),这只
 * hook 把那一口接到统一的拖拽上,于是三处 tab 一次全通:中央区顶栏那一组
 * (`TopBarTabs.LeafTabGroup`)、架子叶与浮窗根叶的檐、分屏出来的那几片叶
 * (`PaneLeaf.PaneLeafStrip`)。
 *
 * ── 状态机(设计 v3 §4.2 的字面实现)────────────────────────────────────────
 * ```
 * idle ──按下──▶ pressed(**当场激活这一格**;光标 grabbing;标签本身不动、不变色)
 * pressed ──松手,位移 < 6──▶ idle(一次点击,到此为止)
 * pressed ──|Δx| ≥ 6──▶ reorder          （DRAG_START_X）
 * pressed ──|Δy| ≥ 24──▶ tear            （TEAR_OFF_DISTANCE)
 * reorder ──指针压到条底缘下 6–24px──▶ onto        （ONTO_FROM_PX ~ TEAR_OFF_DISTANCE）
 * onto ──回到条内(y ≤ 底缘 + 6)──▶ reorder
 * reorder / onto ──y 超过底缘 + 24(出带)──▶ tear ──回到带内──▶ reorder
 * reorder ──松手──▶ moveTab + 150ms 滑进新槽 + 落定闪一圈
 * onto ──松手,指针底下有标签──▶ pairIntoTab(并进它的右格;它已是两格则替换右格)
 * onto ──松手,指针底下没有标签──▶ 滑回原位,**树一个字不变**
 * tear ──松手──▶ 按 §5 的落点表落定
 * 任何态 ──Esc / pointercancel / 窗口失焦──▶ 滑回原位,树一字不变
 * ```
 *
 * **二合一改成位置判据是 W6-b 二修**(设计 §4.1 `ONTO_FROM` / §11 第 4 条):第一版
 * 是「停在某个邻居正中 300ms」,真机上换序途中稍一停顿就误并 —— 而「拖到一半停下来
 * 想想」是人的常态。位置判据把两件事分在两条带里,先例是 Finder 拖**进**文件夹与插到
 * 两项**之间**。按时间判的那一套(时长门槛 / 手抖上界 / 它的 `--dur-*` token)整件退役。
 *
 * **「按下即激活」不在这只文件里**,在 `LeafStrip`:那一句是「切一格标签」的
 * 语义(它还要把焦点送进内容),而这只 hook 只管手势。两者在 `onTabPointerDown`
 * 那一口上前后脚发生 —— 判词与调用序写在 `LeafStrip` 上。
 *
 * ── 一次手势,三种模式,一条会话(裁定 4/5)──────────────────────────────
 *   **换序**   指针在**本条的带内**(条的上下缘外扩 `TEAR_OFF_DISTANCE` 24)。
 *              那一格 tab 自己被抬起来横向跟手、邻居用 `transform` 让位,
 *              **浮影一个节点都不画**;松手 = 一次同叶 `reorderTab` + FLIP 滑入。
 *   **压下去** 指针压到标签条底缘下 6–24px:被拖那格照旧横向跟手,**邻居的让位
 *              全部清零**,指针底下那一格描一圈,浮影只剩下面那行「与「X」二合一」
 *              (`presentation: 'hint'`);松手 = `pairIntoIndex`。指针底下没有标签
 *              就写「松手放回」,松手树一个字不变;被拖的**自己就是两格**时是
 *              拒绝态(§6 末行:两格的标签不能再并)。
 *   **撕下**   指针离开带。抬起收掉,那一格在原位**折成 0 宽**(元素不卸载
 *              —— 树 / 面常驻铁律的拖拽版,也是零重挂断言盯的那一格),
 *              浮影换成一张 tab 形卡片,落点整件交给 §5 那张表。
 *
 * 三种模式**共用一条 `DragSession`**:模式由那一件唯一的「带」判据每帧报回来
 * (`DragBandState`),这里只是它的消费者。第二条会话会在 Esc / pointercancel /
 * 窗口失焦三条路上各漏一次归零 —— 而「Esc 之后 tab 还折着」是用户当场看得见的。
 *
 * ── 这一场的全部瞬态住在几格 ref 里,`endGesture()` 是唯一那口拆卸 ──────────
 * `useContentDrag` 的 `onEnd` 在**三条结束路径**上都叫(落定 / Esc / 指针没了),
 * 所以拆卸只有一份、幂等。模块作用域里一个 `let` 都没有:那会是第二条会话,
 * 而且会活过一次热更(CLAUDE.md 那条「模块级副作用」的法)。
 *
 * ── 被拖的 tab 不离开这条檐 ─────────────────────────────────────────────
 * 这只 hook 一个字都不改树 —— 落定那一刻才改。撕下时那一格只是**折起来**,
 * 属性一摘就原样展回;Esc 之后树逐字不变(`gate:drag` 场景守着这一条)。
 */
export function useTabDrag(leaf: PaneLeafNode): (id: string, e: ReactPointerEvent<HTMLElement>) => void {
  const t = useT()
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
  /** 落在**别人**那条条上时,那条条的编舞(只用来腾空位)。 */
  const foreign = useRef<{ list: HTMLElement; choreo: TabStripChoreo } | null>(null)
  /** 换序此刻算出来的落点下标(每帧由 `track` 交回来)。 */
  const at = useRef<number | null>(null)
  /**
   * **这一帧是换序还是「放到标签上」**(§4.2 那两行跃迁)。判据只有一句:
   * 指针的 y 有没有低于标签条底缘 `ONTO_FROM_PX`。
   *
   * 它是一格 ref 而不是 state:每一发 pointermove 都要读它,而它的变化**不该**
   * 让 React 重渲这条条 —— 这一形改的是几格 `transform` 与一格属性,语义(树)
   * 一个字都没变(与 `ui/tab-reorder` 那段「不改语义的东西不必经过 React」同源)。
   */
  const mode = useRef<'reorder' | 'onto'>('reorder')
  /**
   * onto 态里**上一帧描的是谁**。三个值是三件事,不许合并:
   *   `undefined` 这一趟 onto 还一帧都没画过(刚从换序转进来)
   *   `null`      画过了,而指针底下没有标签(那一形写「松手放回」)
   *   `string`    指针底下那一格的 id
   * 把前两个挤成一个值的话,「转进 onto 那一帧指针正好压在空白上」会被当成
   * 「跟上一帧一样」而一个字都不写,于是屏幕上留着换序那一形的读数。
   */
  const onto = useRef<string | null | undefined>(undefined)
  /**
   * 被拖的这一格**自己装着几份**(1 = 普通标签,2 = 两格的 pair)。起拖那一刻问
   * 一次就够 —— 拖拽期间树是冻住的(`workbench/store.dragging` 那道闸)。
   * 两格的标签压下去是**拒绝态**(设计 §6 末行:两格的标签不能再并)。
   */
  const slots = useRef(1)
  /**
   * 这一帧那条条的矩形。`band()` 每帧问一次量下来,`inline.move` 读它 ——
   * **一帧一次量,两处用**。不这样的话 onto 的判据要自己再 `rect()` 一次,而那一句
   * 紧跟在「刚给几格写完 transform」之后就是一次强制排版(`gate:perf` 场景 ⑤c
   * 当场量到过:p95 316 → 508ms)。`DragSession` 保证 `band()` 就排在 `onMove`
   * 前一句(见它 `move()` 里 `bandPhaseAt` 与 `onMove` 的次序),所以它永远是这一帧的。
   */
  const bandRect = useRef<DOMRect | null>(null)

  /** 从「放到标签上」退回换序:圈灭、提示行撤掉。让位由下一帧的 `track` 自己写回来。**幂等**。 */
  const leaveOnto = useCallback(() => {
    if (mode.current === 'reorder') return
    mode.current = 'reorder'
    onto.current = undefined
    own.current?.markPair(null)
    setDragPresentation('inline')
    setDropFeedback(null)
  }, [])

  /** 这一场留下的一切。**幂等**,三条结束路径都走它。 */
  const endGesture = useCallback(() => {
    leaveOnto()
    own.current?.reset()
    own.current = null
    foreign.current?.choreo.clearGap()
    foreign.current = null
    at.current = null
    bandRect.current = null
  }, [leaveOnto])

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
      at.current = null
      mode.current = 'reorder'
      onto.current = undefined
      // 起拖那一刻问一次「它自己装着几份」—— 拖拽期间树冻着,这个数不会变。
      slots.current = partsOfContent(found)?.length ?? 1
      return found
    },

    /**
     * **两轴两个数**(设计 v3 §4.2):横向 6px 起换序,竖向 24px 才撕下。
     * 判据是「任一轴走过它自己那个数」——不是欧氏距离,理由写在
     * `DragSourceSpec.threshold` 上。
     */
    threshold: { x: DRAG_START_X, y: TEAR_OFF_DISTANCE },

    /**
     * 带 = 这条条自己此刻的矩形(每帧问一次 —— 条会横滚、会因让位重排)。
     * 量下来的这一份同时喂给 onto 的判据(判词在 `bandRect` 上)。
     */
    band: () => {
      bandRect.current = own.current?.rect() ?? null
      return bandRect.current
    },
    /**
     * 带的上下外扩 24 = `TEAR_OFF_DISTANCE`,而 onto 带的下沿**就是它**
     * (§4.1:条底缘 + 6 到 + 24)。两处读同一个常量,「越过下沿 = 出带 = 撕下」
     * 才是一句真话 —— 第二个 24 会长出一条既不二合一也不撕下的死区。
     */
    bandSlack: TEAR_OFF_DISTANCE,

    inline: {
      enter: (pointer) => {
        const held = pending.current
        if (!held) return
        // 回到带里 = 折起来那一格展回来、别人那格空位收掉,再抬起。都幂等。
        leaveOnto()
        foreign.current?.choreo.clearGap()
        foreign.current = null
        own.current?.reset()
        own.current?.lift(held.id, held.x)
        follow(pointer)
      },
      // 包一层而不是直接把 `follow` 交出去:它是下面那个 `const`,直接写在对象
      // 字面量里就是一次 TDZ 读(这只 spec 在渲染中当场构造)。闭包读的永远是
      // 这一次渲染的那一只 —— `useContentDrag` 把 spec 存在 ref 里逐帧更新。
      move: (pointer) => follow(pointer),
      leave: () => {
        // 出带:onto 先清干净(圈灭、提示撤掉),再把原位折成 0 宽 —— 邻居合拢,
        // 像它已经走了。次序不能反:`tear()` 会把抬起收掉,之后 `markPair(null)`
        // 摘的还是同一格属性,但「这一场此刻是 onto」这句谎会一直留到松手。
        leaveOnto()
        const held = pending.current
        if (held) own.current?.tear(held.id)
        at.current = null
      },
      drop: () => {
        const held = pending.current
        if (!held) return true
        /*
         * **onto 排在换序之前**(§4.2:`onto ──松手──▶ 二合一`)。两者共用同一场
         * 手势,而 onto 是它明确说过「我不是要换序」的那一形 —— 手已经压到条的
         * 下面了。指针底下没有标签(或被拖的自己是两格,那一形 `onto.current`
         * 恒为 null)= **空动作**:树一个字不变,那一格滑回原位。
         */
        if (mode.current === 'onto') {
          const target = onto.current ?? null
          if (target === null) {
            slideBack(held.id)
            return true
          }
          return pairIntoTab(leafRef.current.id, held.id, target)
        }
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
   * **带内每一帧**:先判这一帧是换序还是「放到标签上」,再把这一帧交给编舞。
   *
   * 判据只有一句(§4.2):指针的 y 低于标签条底缘 `ONTO_FROM_PX` 就是 onto。
   * 下沿不在这里判 —— 越过 `bandSlack`(= `TEAR_OFF_DISTANCE`)那一刻 `DragSession`
   * 自己就把这一帧派成出带了,`inline.leave` 接手去撕下。所以这只函数**只看上沿**,
   * 「带的下沿就是撕下的门槛」这句话因此只写在一处。
   *
   * ── 只在**跃迁**那一刻切呈现与描圈(§4.5 第 3 条)────────────────────────
   * `setDragPresentation` / `setDropFeedback` / `markPair` 都只在「模式变了」或
   * 「目标换人了」那一帧写。每帧重设是同一件事说 N 遍:呈现那一格会让
   * `DragLayer` 每帧重渲,描圈那一格会让浏览器每帧重新起一次那圈的过渡 ——
   * 屏幕上正是用户报的「闪」。
   */
  const follow = useCallback(
    (pointer: { x: number; y: number }) => {
      const choreo = own.current
      if (!choreo) return
      const bottom = bandRect.current?.bottom
      if (bottom === undefined || pointer.y <= bottom + ONTO_FROM_PX) {
        leaveOnto()
        at.current = choreo.track(pointer.x)
        return
      }
      if (mode.current === 'reorder') {
        mode.current = 'onto'
        onto.current = undefined
        /*
         * onto 那一形:**卡片仍旧不画**,只多出下面那行字(§4.2「浮影只剩一行
         * 『与 X 二合一』」)。屏幕上动的东西还是只有那一格标签。
         */
        setDragPresentation('hint')
      }
      at.current = null
      /*
       * `hover()` 每帧都叫:它除了答「指针底下是谁」,还负责这一形里那一格的
       * 跟手与「邻居让位清零」。答案只在**换人**那一帧往下写。
       */
      const under = choreo.hover(pointer.x)
      // 被拖的自己就是两格 = 拒绝态,谁都不描(§6:两格的标签不能再并)。
      const target = slots.current > 1 ? null : under
      if (target === onto.current) return
      onto.current = target
      choreo.markPair(target)
      if (slots.current > 1) {
        setDropFeedback({ rect: null, tone: 'refuse', hint: t('drag.refusePairNest') })
        return
      }
      setDropFeedback(
        target === null
          // 指针底下没有标签:松手什么都不会发生 —— 但这句话必须说出口(§5 贯穿规则 2)。
          ? { rect: null, tone: 'accept', hint: t('drag.hint.back') }
          : { rect: null, tone: 'accept', hint: pairHintFor(target, t) },
      )
    },
    [leaveOnto, t],
  )

  /** 那一格 tab 此刻在手上的左缘(收笔那一程的起点)。摘不到就答 null。 */
  const liveLeftOf = (id: string): number | null =>
    document.querySelector(`[data-tab-id="${CSS.escape(id)}"]`)?.getBoundingClientRect().left
    ?? null

  /**
   * **树一个字不变,那一格滑回原位**(onto 松手在空白上 / 拒绝态松手)。
   *
   * 它走的是与换序落定同一只 `settle()`:先量它此刻在手上的位置,再让编舞
   * FLIP 回去 —— 不这样的话 `reset()` 一摘 transform,那一格是**瞬移**回原位的。
   * `settle` 自己排在 `reset()` 之后一帧,判词在 `tabStripChoreo.settle` 上。
   */
  const slideBack = (id: string): void => {
    const from = liveLeftOf(id)
    if (from !== null) own.current?.settle(id, from)
  }

  return useCallback(
    (id: string, e: ReactPointerEvent<HTMLElement>) => {
      pending.current = { id, x: e.clientX }
      start(e)
    },
    [start],
  )
}

/**
 * 「放到标签上」落定:把被拖那一格并进 `targetId` 那一格的右格(§4.2 的
 * `onto ──松手──▶ 二合一` 那一行)。
 *
 * 签名对着 `store.pairRefs(leafId, hostIndex, ref, side)` —— 它收的是**叶 + 下标**
 * 而不是两个 refId(同一格内容可能在别处也开着,而这一下说的是「屏幕上这一格」),
 * 所以这里现查一次下标。查不到 = 空动作(那一格在这一帧被别人搬走了)。
 *
 * 「哪个区域 / 哪片叶」走既有的两只(`regionOfLeafIn` / `findLeaf`),不另写遍历:
 * 这条查法在 `drop-commit` 与 store 里各有一处,再抄一份就是第三份会漂的账。
 */
function pairIntoTab(leafId: string, draggedId: string, targetId: string): boolean {
  const store = useWorkbenchStore.getState()
  const dragged = parseRefId(draggedId)
  if (!dragged) return true
  const region = regionOfLeafIn(store.regions, leafId)
  const leaf = region ? findLeaf(store.regions[region], leafId) : null
  const hostIndex = leaf?.tabs.findIndex((tab) => refId(tab) === targetId) ?? -1
  if (hostIndex < 0) return true
  /*
   * **走 `drop-commit.pairIntoIndex`,不直接调 store**(与 `reorderTab` 同一条
   * 纪律):落定不止是改树 —— 还有架子展开、点成活动、焦点跟过去、播报那一句。
   * 三条路(拖到内容区左右带 /「放到标签上」松手 / 右键菜单)走完必须是同一件事、
   * 说同一句话,而那件事只有一个产地。
   */
  pairIntoIndex(dragged, leafId, hostIndex, 'right')
  return true
}

/** 「与「X」二合一」/「替换「X 的右格」」—— 与 `useContentDrag` 那一处同一张表。 */
function pairHintFor(id: string, t: ReturnType<typeof useT>): string {
  const parsed = parseRefId(id)
  const live = useLiveTitleStore.getState().titles[id]
  const name = live?.text ?? (parsed ? contentKindOf(parsed.kind)?.title(parsed)?.text : null) ?? id
  const slots = parsed ? (partsOfContent(parsed)?.length ?? 1) : 1
  return t(slots > 1 ? 'drag.hint.replaceRight' : 'drag.hint.pairRight', { name })
}
