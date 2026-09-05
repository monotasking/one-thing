import { nextFloatId } from '../stage/placement'
import { useStageStore } from '../stage/store'
import {
  defaultFloatRect,
  floatRectForGrab,
  FALLBACK_VIEWPORT,
} from '../stage/transitions'
import { flashLandedTab } from '../ui/tab-reorder'
import { announce } from '../ui/a11y/live-region'
import { t } from '../i18n'
import { focusIntoRefAfterCommit } from './focus-into'
import { contentKindOf, refId } from './kinds'
import { useLiveTitleStore } from '../stage/live-title'
import { edgeRegion, floatRegion } from './regions'
import { regionOfLeafIn, regionOfRefIn, useWorkbenchStore } from './store'
import { findLeaf, leavesOf } from './tree'
import type { DropTarget } from './drop'
import type { ContentRef } from './kinds'
import type { FloatRect, ShelfSide, Viewport } from '../stage/types'

/**
 * **落定 —— 一个事务动作,菜单与拖拽共用**(W3 裁定 5 + W4 合入后的修正)。
 *
 * ── 它为什么不长在 `workbench/store.ts` 里(与派工令的一处出入)──────────
 * 派工令写的是「`workbench/store.ts` 加 `dropRef(source, target)`」。真写下去
 * 会造一条 **import 环**:`workbench/store` → `stage/store` → `stage/placement`
 * → `workbench/store`。这台壳里同一种环有两处白纸黑字的病历(`workbench/store`
 * 文件头的「播种为什么是一句显式的 `startWorkbench()`」、`workspace/layout-scope`
 * 的「启动即 TDZ 崩溃」),两处的裁法一样:**把那句要同时认识两台机器的话搬出去,
 * 单独一个文件**。`content/viewer/open-target.ts` 是现成的同型先例(它同时认识
 * viewer / workbench / stage 三台,而谁都不认识它)。
 *
 * 派工令要的三件事一件不少:**一个动作**(这只函数)、**菜单与拖拽共用**
 * (`LeafActions` 的「移到 ▸」两组与拖拽落定调的是这一只)、**按 ref 种类分派
 * 但不枚举种类名** —— 这只文件里 grep `'file'` / `'panel'` / `'session'` 零命中,
 * 分派整件在 `stage/placement.placeRefIn`(它问的是 `panelIdOf(ref) !== null`)。
 *
 * ── 两条路,一处收口 ────────────────────────────────────────────────────
 *   瓦(`panel:<id>`)  → `placeRefIn` 自己转给 `placeAs`(位置记忆、架子展开、
 *                       独占格清理全在那条老路上)
 *   其余              → `placeRefIn` 走 `workbench.moveRef` + 架子展开 + 浮窗矩形
 *
 * ── 「落到某一片叶」为什么不走那条路 ────────────────────────────────────
 * `placeRefIn` 说的是**区域**(落在那个区域的焦点叶上),而拖拽的落点是
 * **屏幕上这一块** —— 一个区域分屏之后有好几片。所以叶那一支走
 * `workbench.moveRefIntoLeaf`(它自己是一次 `set`),再补一句宿主侧的展开。
 */

/** 落定要用到的视口,与形态机同一个口径(纯函数不许自己读 window)。 */
function viewport(): Viewport {
  if (typeof window === 'undefined') return FALLBACK_VIEWPORT
  return { w: window.innerWidth, h: window.innerHeight }
}

export interface DropCommitOptions {
  /**
   * 撕成浮窗时新窗落在哪儿。缺席 = 视口居中的默认矩形 —— 菜单那条路没有指针,
   * 而「撕成浮窗」这一项由键盘按出来时,窗子落在中间是唯一说得通的位置。
   * 给了指针就按「指针 = 标题栏中心」摆(`floatRectForGrab`,与从架子上撕一块瓦
   * 逐字同一只函数)。
   */
  pointer?: { x: number; y: number }
}

/**
 * 把一格内容落到一个落点上。
 *
 * **`refuse` 是空动作** —— 拒绝这件事在拖拽过程里已经说给用户听了(浮影变灰 +
 * 一句理由),落定时再弹一次是噪音。
 */
export function dropRef(ref: ContentRef, target: DropTarget, opts: DropCommitOptions = {}): void {
  if (target.kind === 'refuse') return

  /*
   * **落定之前先把全屏收掉**(W2×W3 合树接缝 b)。排在 `refuse` 之后:被拒绝的
   * 那一下什么都没发生,不该顺手改形态。
   *
   * 理由与拖拽起手那道闸是同一句话的另一半:落定会改树(插一格 / 切一刀 / 撕一扇
   * 窗),而全屏层正盖着整棵树。不收,用户做完这一下看见的还是那块铺满的面,
   * 而且 `land()` 的焦点会送进一片被 `inert` 盖着的叶里 —— 那是「按了没反应」。
   *
   * 收这个动作只此一份(`workbench/store.exitFullIfOpen`),Dock 那两处 toggle
   * 调的是同一只。这里**不问是哪一块**在全屏:任何一块盖着,树都看不见。
   */
  useWorkbenchStore.getState().exitFullIfOpen()

  if (target.kind === 'strip') {
    dropIntoStrip(ref, target.leafId, target.at)
    return
  }

  /*
   * **落回自己那片叶 = 空动作**(设计 v3 §5 最后一行「自己的内容区……松手放回
   * 标签条」)。与 `refuse` 同一条判词:这一下什么都没发生,连全屏都不该顺手收
   * —— 但它排在 `exitFullIfOpen` 之后,因为「拖到自己身上」这一下用户确实做过
   * 一次拖拽,而拒绝那一下连拖都不成立。
   */
  if (target.kind === 'back') return

  /** **与这片叶的活动标签并排**(§5 的内容区左右带)。 */
  if (target.kind === 'pair') {
    pairIntoActive(ref, target.leafId, target.side)
    return
  }

  /** **落到某一格标签正中 = 与它二合一**(§5 的「标签正中 44%」)。 */
  if (target.kind === 'pairTab') {
    pairIntoIndex(ref, target.leafId, target.at, 'right')
    return
  }

  /** **内容区中间 = 在那条条的末尾开成一格新标签**(§5)。 */
  if (target.kind === 'open') {
    dropIntoStrip(ref, target.leafId, Number.POSITIVE_INFINITY)
    return
  }

  if (target.kind === 'edge') {
    useStageStore.getState().placeRef(ref, edgeRegion(target.side))
    land(ref)
    return
  }

  // 撕成浮窗。**窗 id 由 `nextFloatId` 铸**(W4 留账 2 的了结:从前只有瓦撕得
  // 出去,因为浮窗的三张表按瓦 id 记;现在窗号自己铸,任何一种 ref 都撕得出来)。
  const already = regionOfRefIn(useWorkbenchStore.getState().regions, refId(ref))
  const winId = already?.startsWith('float:') ? already.slice('float:'.length) : nextFloatId()
  const size = useStageStore.getState().floats[winId] ?? defaultFloatRect(viewport())
  const rect: FloatRect = opts.pointer ? floatRectForGrab(opts.pointer, size, viewport()) : size
  useStageStore.getState().placeRef(ref, floatRegion(winId), { rect })
  land(ref)
}

/**
 * **落到一条标签条上,插到第 `at` 格**(W3-b 裁定 6;W6-b 添了「末尾」这一档)。
 *
 * `at` 传 `Infinity` = **末尾**(内容区中间那一档:「开成新标签」,设计 v3 §5)。
 * 它在这里就地夹到 `leaf.tabs.length`,而不是让判据那一头去数格数 —— 「这条条
 * 此刻有几格」是 store 的事实,判据读的是起拖时量的那份几何,两者在拖拽期间
 * 恰好相同、在菜单那条路上未必。
 *
 * 一支两路,判据是「这一格本来在不在这条条上」:
 *   在  → `store.moveTab`,一次同叶换序(`at` 是对着**本来那张表**量的下标,
 *         `tree.moveTab` 自己会收掉 splice 的那一格偏移,并且预览那一格的身份
 *         跟着搬 —— 换位子不等于「保留」)
 *   不在 → `moveRefIntoLeaf`,从别处搬进来插在第 `at` 格(那一只先摘干净再插,
 *         而摘的是**另一片叶**里的那一格,所以本叶的下标不受影响)
 *
 * 两路各自都是**一次 `set`**,中间没有「屏幕上少一格」的那一拍。
 */
function dropIntoStrip(ref: ContentRef, leafId: string, at: number): void {
  const store = useWorkbenchStore.getState()
  const region = regionOfLeafIn(store.regions, leafId)
  if (!region) return
  const leaf = findLeaf(store.regions[region], leafId)
  if (!leaf) return
  const to = Number.isFinite(at) ? at : leaf.tabs.length
  const id = refId(ref)
  const from = leaf.tabs.findIndex((tab) => refId(tab) === id)
  if (from >= 0) {
    reorderTab(leafId, from, to)
    return
  }
  store.moveRefIntoLeaf(ref, leafId, { at: to })
  const side = sideOfRegion(region)
  if (side) expandShelf(side)
  land(ref)
}

/**
 * **换序这一下的唯一产地**(裁定 4 的落定 + 裁定 8 的「左移 / 右移」)。
 *
 * 拖着走完与按菜单里那两项走完,做的必须是同一件事、说的必须是同一句话 ——
 * 播报是**落定**的一部分,不是菜单的装饰(与 `dropRef` 那三组的判词逐字同源)。
 * 报的是**第几位**而不是「左移了」:键盘用户听完要知道自己此刻在哪儿,而
 * 「左移」在第一格上是一句空话。
 *
 * ── `at` 的坐标系:**插到第 at 格之前**,对着**没摘掉任何东西**的那张原始表 ──
 * 与 `workbench/drop.ts` 的 `stripIndexAt` / `ui/tab-reorder` 的 `track()` 同一个。
 * 所以「原地不动」有两种写法(`at === from` 与 `at === from + 1`)—— 它们说的是
 * 同一件事:落点前后就是自己。两种都当场返回,理由是**引用恒等**:走下去会得到
 * 一份内容相同、身份不同的树,订阅者照样重渲一遍,而条内换序里「手抖了一下又放
 * 回去」是最常发生的一下。
 *
 * ── 它走 `store.moveTab`(W5-b 合树接缝 a:W3-b 那笔留账的了结)──────────────
 * W3-b 落地时 `workbench/store.ts` 是并行批 W5-b 的改动面,派工令点名不碰,
 * 所以这一支借道 `moveRefIntoLeaf`(摘干净再插)。它换出来的树**少一样东西**:
 * `removeTab` 会把 `preview` 清成 null,于是**换一格预览 tab 的位子等于顺手把它
 * 固定下来** —— 用户没要过的一次「保留」。W5-b 合树之后 `store.ts` 解禁,那一口
 * `store.moveTab` 补上了(判据本体照旧是纯函数 `tree.moveTab`,它自己收 splice
 * 的下标偏移、并且把预览那一格的身份随着搬过去),这条路改走它。
 * 用例 `leaf-actions-drag-parity` 的「预览 tab 换序之后仍然是预览」钉住这一条。
 */
export function reorderTab(leafId: string, from: number, at: number): void {
  if (at === from || at === from + 1) return
  const store = useWorkbenchStore.getState()
  const region = regionOfLeafIn(store.regions, leafId)
  if (!region) return
  const leaf = findLeaf(store.regions[region], leafId)
  const ref = leaf?.tabs[from]
  if (!leaf || !ref || leaf.tabs.length < 2) return
  store.moveTab(leafId, from, at)
  const landed = findLeaf(useWorkbenchStore.getState().regions[region] ?? leaf, leafId)
  const now = landed?.tabs.findIndex((tab) => refId(tab) === refId(ref)) ?? -1
  // 一格都没挪(夹到了两端)= 不播报:读屏软件念一句「还在第 2 位」是噪音。
  if (now < 0 || now === from) return
  announce(t('drag.reordered', { at: now + 1, total: landed?.tabs.length ?? 0 }))
}

/**
 * **二合一**(W6-b,设计 v3 §5 / §6):把 `ref` 并进这片叶第 `at` 格的 `side` 侧。
 *
 * 判据整件在 `store.pairRefs`(它自己拦「拖回自己身上」「两格的不能再并」「并不
 * 出来」三条),这里只做两件事:**把落点翻译成它的签名**(叶 + 下标 + ref + 哪一侧)
 * 与**收笔**(架子展开 + 点成活动 + 焦点跟过去)。
 *
 * 「一格都没并成」也走 `land()`:那一下要么是空动作(拖回自己身上),要么被
 * `pairRefs` 拦了 —— 两种都不该顺手把焦点丢在别处,而 `land()` 对一格没搬动的
 * ref 是幂等的(它只是把它在**它此刻那片叶**里点成活动的)。
 */
export function pairIntoIndex(
  ref: ContentRef,
  leafId: string,
  at: number,
  side: 'left' | 'right',
): void {
  const store = useWorkbenchStore.getState()
  const region = regionOfLeafIn(store.regions, leafId)
  if (!region) return
  const leaf = findLeaf(store.regions[region], leafId)
  const host = leaf?.tabs[at]
  if (!leaf || !host || at < 0 || at >= leaf.tabs.length) return
  const before = store.regions[region]
  store.pairRefs(leafId, at, ref, side)
  const shelfSide = sideOfRegion(region)
  if (shelfSide) expandShelf(shelfSide)
  land(ref)
  /*
   * **播报是落定的一部分**(设计 §7,与 `reorderTab` 那一只逐字同源):三条路
   * (拖拽落定 /「放到标签上」松手 / 右键菜单「与右边的标签二合一」)走完必须说同一句话。
   * 引用恒等 = 那一下什么都没换(拖回自己身上 / 被 `pairRefs` 的三条判据拦了)
   * —— 读屏软件念一句「已与 X 并排」而屏幕上什么都没发生是撒谎。
   */
  if (useWorkbenchStore.getState().regions[region] === before) return
  announce(t('workbench.pairedWith', { name: titleOfRef(host) }))
}

/** 一格内容此刻的名字(活的盖静的 —— 与标签条读的是同一份)。 */
function titleOfRef(ref: ContentRef): string {
  const id = refId(ref)
  return (
    useLiveTitleStore.getState().titles[id]?.text
    ?? contentKindOf(ref.kind)?.title(ref).text
    ?? ref.key
  )
}

/** 与这片叶**活动那一格**并排(内容区左右带说的就是「与你正在看的那个并排」)。 */
function pairIntoActive(ref: ContentRef, leafId: string, side: 'left' | 'right'): void {
  const store = useWorkbenchStore.getState()
  const region = regionOfLeafIn(store.regions, leafId)
  if (!region) return
  const leaf = findLeaf(store.regions[region], leafId)
  if (!leaf) return
  pairIntoIndex(ref, leafId, leaf.active, side)
}

function sideOfRegion(region: string): ShelfSide | null {
  if (!region.startsWith('edge:')) return null
  const side = region.slice('edge:'.length)
  return side === 'left' || side === 'right' || side === 'top' || side === 'bottom' ? side : null
}

/** 展开一条架子。形态机那一口是**切换**(`toggleShelfCollapsed`),所以先问再切。 */
function expandShelf(side: ShelfSide): void {
  const stage = useStageStore.getState()
  if (stage.shelves[side].collapsed) stage.toggleShelfCollapsed(side)
}

/**
 * 落定的收笔:**点成活动的** + **焦点跟过去**(裁定 8)。
 *
 * 后半句与 W4 合树时裁定的「tab 激活 → 焦点进内容」是同一句话 —— 落定就是一次
 * 激活,所以它调的是同一只 `focusIntoRef`(产地 `workbench/focus-into.ts`),
 * 四个宿主的 tab 条与这条路一个字都不分叉。
 */
function land(ref: ContentRef): void {
  activateRefInItsLeaf(ref)
  focusIntoRefAfterCommit(refId(ref))
  /*
   * **落定闪一圈**(W6-b,设计 v3 §5「落定卡片飞入空位 + 新标签闪圈」)。
   * 卡片飞进空位那一半由 `ui/drag` 做(它有那格瞬态);这一句是它的下半句 ——
   * 卡片消失在哪儿,那一格标签就在哪儿亮一下。两者接在同一条时间线上。
   */
  flashLandedTab(refId(ref))
}

/** 把这一格在它此刻那片叶里点成活动的(搬过去的东西该看得见)。 */
function activateRefInItsLeaf(ref: ContentRef): void {
  const store = useWorkbenchStore.getState()
  const id = refId(ref)
  for (const tree of Object.values(store.regions)) {
    for (const leaf of leavesOf(tree)) {
      const at = leaf.tabs.findIndex((tab) => refId(tab) === id)
      if (at >= 0) {
        store.activateTab(leaf.id, at)
        return
      }
    }
  }
}
