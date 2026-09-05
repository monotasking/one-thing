import { nextFloatId } from '../stage/placement'
import { useStageStore } from '../stage/store'
import {
  defaultFloatRect,
  floatRectForGrab,
  FALLBACK_VIEWPORT,
} from '../stage/transitions'
import { focusIntoRefAfterCommit } from './focus-into'
import { refId } from './kinds'
import { ZONE_SPLIT } from './drop'
import { edgeRegion, floatRegion } from './regions'
import { regionOfRefIn, useWorkbenchStore } from './store'
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
