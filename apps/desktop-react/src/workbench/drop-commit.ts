import { nextFloatId } from '../stage/placement'
import { useStageStore } from '../stage/store'
import {
  defaultFloatRect,
  floatRectForGrab,
  FALLBACK_VIEWPORT,
} from '../stage/transitions'
import { announce } from '../ui/a11y/live-region'
import { t } from '../i18n'
import { focusIntoRefAfterCommit } from './focus-into'
import { refId } from './kinds'
import { ZONE_SPLIT } from './drop'
import { edgeRegion, floatRegion } from './regions'
import { regionOfLeafIn, regionOfRefIn, useWorkbenchStore } from './store'
import { findLeaf, leavesOf } from './tree'
import type { DropTarget } from './drop'
import type { ContentRef } from './kinds'
import type { RegionId } from './regions'
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

  if (target.kind === 'leaf') {
    dropIntoLeaf(ref, target.region, target.leafId, target.zone)
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
 * **落到一条标签条上,插到第 `at` 格**(W3-b 裁定 6)。
 *
 * 一支两路,判据是「这一格本来在不在这条条上」:
 *   在  → `moveTab`,一次同叶换序(`at` 是对着**本来那张表**量的下标,
 *         那一只自己会收掉 splice 的那一格偏移)
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
  const id = refId(ref)
  const from = leaf.tabs.findIndex((tab) => refId(tab) === id)
  if (from >= 0) {
    reorderTab(leafId, from, at)
    return
  }
  store.moveRefIntoLeaf(ref, leafId, { at })
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
 * ── 为什么走 `moveRefIntoLeaf` 而不是给 store 加一口 `moveTab` ──────────────
 * 因为 `workbench/store.ts` 此刻是**并行批 W5-b 的改动面**,派工令点名不碰。
 * 而这一支不需要新口:`moveRefIntoLeaf` 就是「摘干净再插进这片叶的第 n 格」,
 * 一次 `set`、同一事务 —— 同叶换序与它的差别只有一个下标偏移(摘掉自己之后,
 * 原表里 `from` 右边的落点都往前收一格,也就是下面那句 `at > from ? at - 1 : at`,
 * 与 `tree.moveTab` 里那句注释说的是同一个 splice 双动作坑)。
 * **留账**:`tree.moveTab` 会把「预览」那一格身份跟着搬过去,这条路不会 ——
 * 换序一格预览 tab 会把它固定下来。W5-b 合树之后可以换回 `T.moveTab`。
 */
export function reorderTab(leafId: string, from: number, at: number): void {
  if (at === from || at === from + 1) return
  const store = useWorkbenchStore.getState()
  const region = regionOfLeafIn(store.regions, leafId)
  if (!region) return
  const leaf = findLeaf(store.regions[region], leafId)
  const ref = leaf?.tabs[from]
  if (!leaf || !ref || leaf.tabs.length < 2) return
  store.moveRefIntoLeaf(ref, leafId, { at: at > from ? at - 1 : at })
  const landed = findLeaf(useWorkbenchStore.getState().regions[region] ?? leaf, leafId)
  const now = landed?.tabs.findIndex((tab) => refId(tab) === refId(ref)) ?? -1
  // 一格都没挪(夹到了两端)= 不播报:读屏软件念一句「还在第 2 位」是噪音。
  if (now < 0 || now === from) return
  announce(t('drag.reordered', { at: now + 1, total: landed?.tabs.length ?? 0 }))
}

function dropIntoLeaf(
  ref: ContentRef,
  region: RegionId,
  leafId: string,
  zone: 'center' | 'n' | 's' | 'e' | 'w',
): void {
  const store = useWorkbenchStore.getState()
  const tree = store.regions[region]
  const leaf = tree ? findLeaf(tree, leafId) : null
  if (!leaf) return
  /*
   * **一片叶里唯一那一格拖到它自己身上 = 空动作**(不管落中心还是落四带)。
   * 树那一头自己也有这句判(`tree.splitLeaf`:「搬走之后原叶空了 = 这一次分屏
   * 没有意义」),但那一句救不了这里:走到那儿之前这一格已经被摘掉、这片叶已经
   * 被剪掉了,`splitLeaf` 只会答「没有这片叶」,而那一格就此从树上消失。
   */
  const id = refId(ref)
  if (leaf.tabs.length === 1 && refId(leaf.tabs[0]) === id) return

  if (zone === 'center') {
    store.moveRefIntoLeaf(ref, leafId)
  } else {
    /*
     * 四带 = 切一刀,新叶放那一侧,比例 50(`DEFAULT_SPLIT_RATIO`)。
     *
     * 次序:**先从每棵树里摘干净,再切**。`splitLeaf` 走的是「点名 ref」那条
     * 支路(`tree.ts` 的原话:「点名了 ref 是开新的不搬」),它不会替你摘 ——
     * 不先摘,拖一格 tab 到隔壁那片叶的东带会留下两份:原位一份、新叶一份。
     *
     * 也**不复用菜单那格 `canSplit = leaf.tabs.length > 1` 的闸**(裁定 5):
     * 那句闸说的是「把本叶的活动 tab 拉出去,原叶会不会空掉」;这里放进去的是
     * **另一格**,原叶一格都不会少。
     */
    const { dir, before } = ZONE_SPLIT[zone]
    store.detachRef(id)
    useWorkbenchStore.getState().splitLeaf(leafId, dir, ref, before)
  }
  // 落进架子里的那一片叶 = 那条架子该展开(与「新入架子顺手展开」同一句话)。
  const side = sideOfRegion(region)
  if (side) expandShelf(side)
  land(ref)
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
