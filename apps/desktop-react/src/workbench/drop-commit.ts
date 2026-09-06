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
import { contentKindOf, mayCloseContent, partsOfContent, refId } from './kinds'
import { useLiveTitleStore } from '../stage/live-title'
import { edgeRegion, floatRegion } from './regions'
import { canDetachTab, regionOfLeafIn, regionOfRefIn, useWorkbenchStore } from './store'
import * as T from './tree'
import { findLeaf, leavesOf } from './tree'
import type { DropTarget } from './drop'
import type { ContentRef } from './kinds'
import type { PaneNode } from './tree'
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

/**
 * **拆开**(W6-c,设计 v3 §7 那张表的第三行)——「菜单『拆开』;格头上的按钮」
 * 两条路的**唯一产地**。
 *
 * 判据整件仍在 `store.unpairAt`(右格拆成紧邻其后的新标签,焦点留原位);这一只
 * 只多做一件事:**把那句播报收进来**。它非收不可 —— W6-a 落地时播报写在
 * `LeafActions` 的那颗菜单项上,于是**格头上那颗「拆开」按下去一声不吭**:
 * 同一件事,两条路,一条说话一条不说,正是「两条路走两个动作迟早分叉」这条判例
 * 在播报上的长相(与 `reorderTab` / `pairIntoIndex` 逐字同源:播报是**落定**的
 * 一部分,不是菜单的装饰)。
 *
 * **引用恒等 = 什么都没换就不播报**:`unpairAt` 自己拦「这一格本来就不是两格」,
 * 那时读屏软件念一句「已拆开」而屏幕上什么都没发生是撒谎(与 `pairIntoIndex`
 * 末尾那一句同一条判词)。
 */
export function unpairTab(leafId: string, index: number): void {
  const store = useWorkbenchStore.getState()
  const region = regionOfLeafIn(store.regions, leafId)
  if (!region) return
  const before = store.regions[region]
  /* 拆完焦点进哪儿:**左格**(它留在原标签,而原标签仍旧是活动的 —— 设计 §6
   * 「左格留在原标签里,焦点留在原标签」)。要在拆之前取,拆完那一格 ref 就没了。 */
  const tab = findLeaf(before, leafId)?.tabs[index]
  const left = tab ? partsOfContent(tab)?.[0] : undefined
  store.unpairAt(leafId, index)
  if (useWorkbenchStore.getState().regions[region] === before) return
  announce(t('workbench.unpaired'))
  /*
   * **拆开也是一次落定,焦点跟过去**(W7-t / B11)。修前这里只播报不送焦点,
   * 于是拆完焦点掉在叶容器上 —— 与 `land()` 那半句(裁定 8「落定后焦点跟到新叶」)
   * 逐字同一条纪律,产地也是同一只 `focusIntoRefAfterCommit`。
   * 排一拍才送:这一刻新的那两层还没铺上来(判词整段在 `focus-into` 上)。
   */
  if (left) focusIntoRefAfterCommit(refId(left))
}

/**
 * **关两格标签里的一格**(W7-t / B7,设计 v3 §6:「关格头上的 ✕ 只关这一格,
 * 另一格变回一格标签」)。与 `unpairTab` 同产地、同体例。
 *
 * 三件事按序:**问那一格**(`beforeClose` —— 脏文件那一问,只问要走的那格,
 * 留下的那格什么都没发生)、**拆散**(`store.unpairAt`)、**关掉走的那一格**
 * (`store.closeTab`,判据 + 摘 + `dispose` 全在那一只里)。
 *
 * ── 病历:它为什么不是一次原位换 ref(09-06 审查逮到的账)──────────────
 * 修前这里走的是 `store.replaceRef(leafId, pair, staying)` —— 一次 `set`,
 * 屏幕上确实干净,可 `replaceRef` 的**非复合**那条路不归一 `pairRatios`
 * (只有「换的是复合标签里的一格」那一支才 `normalizePairRatios`)。于是那格
 * pair 的分栏比例在 ✕ 这条路上**留尾**:表里躺着一格谁也不认识的比例,而下一次
 * 同样两格再并起来读到的是一份陈年的比例。同一件事(把一格 pair 拆散)从此
 * **两处判据、两套记账** —— `unpairAt` 那条路 `delete` 得干干净净,这条路不。
 *
 * 治法是**这只函数一个 `T.*` 都不写**:拆散整件在 `store.unpairAt`(比例记账
 * 长在它身上),关掉整件在 `store.closeTab`(`canDetachTab` + `removeTab` +
 * `ContentKind.dispose` 长在它身上)。这里只负责**按序把两只现成的动作接起来**。
 *
 * 两次 `set` 会不会在屏幕上闪?不会。中间那一态是**合法的**(两格标签并排),
 * 不是「少一格」—— `unpairAt` 内部那句「分两次写中间少一格」说的是它自己那两步
 * (换 ref 与插 tab 之间树上真的少一格);而这两下同在一拍里(React 18 自动
 * 批处理),画面只提交一次。非 React 的那位订阅者(`stage/store` 的常驻同步)
 * 确实逐次看得见中间那一态,但它问的是「常驻的还在不在」——两格此刻都在场,
 * 答案与最终态相同。
 *
 * **第二步之前先复核**:拆没拆成要读回来看。拆不成时 `index` 上躺着的还是那格
 * pair,照着关下去会把**两格一起**关掉 —— 这是两步动作必须自己付的那笔税。
 *
 * 关得掉吗由 `canClosePairSide` 答,而它把判据借给 `canDetachTab` —— 判据只有
 * 一个产地(T0 拍点 2「最后一格常驻的关不掉」对 `pair(会话, 文件)` 里的会话
 * 同样成立)。屏幕上那颗 ✕ 因此**关不掉就不画**(与 `ui/Tabs` 那颗逐字同一条:
 * 一颗按不动的 ✕ 与「按了没反应」在屏幕上是同一件事);这里再问一遍是防手滑,
 * 走到就播报,不静默。第二步 `closeTab` 自己还会拿同一只判据再问一遍 ——
 * 三处问的是同一句话,不是三份判据。
 */
export function closePairSide(leafId: string, index: number, side: 'left' | 'right'): void {
  const store = useWorkbenchStore.getState()
  const region = regionOfLeafIn(store.regions, leafId)
  if (!region) return
  const tree = store.regions[region]
  const tab = findLeaf(tree, leafId)?.tabs[index]
  const parts = tab ? partsOfContent(tab) : null
  if (!tab || !parts || parts.length < 2) return
  const going = side === 'left' ? parts[0] : parts[1]
  const staying = side === 'left' ? parts[1] : parts[0]
  if (!canClosePairSide(tree, leafId, index, side)) {
    announce(t('workbench.tabNotClosable'))
    return
  }
  void (async () => {
    if (!(await mayCloseContent(going))) return
    /* await 之后重新定位:那一问是异步的,回来时下标可能已经不指着同一格
     * (病历与 `leaf-tabs.useCloseLeafTab` 逐字同源)。 */
    const live = useWorkbenchStore.getState()
    const at = regionOfLeafIn(live.regions, leafId)
    if (!at) return
    const now = findLeaf(live.regions[at], leafId)?.tabs[index]
    if (!now || refId(now) !== refId(tab)) return
    // ① 拆散(比例记账在这一只里)。② 复核。③ 关掉走的那一格(dispose 在那一只里)。
    live.unpairAt(leafId, index)
    const goingAt = side === 'left' ? index : index + 1
    const after = useWorkbenchStore.getState()
    const region2 = regionOfLeafIn(after.regions, leafId)
    const split = region2 ? findLeaf(after.regions[region2], leafId)?.tabs[goingAt] : undefined
    if (!split || refId(split) !== refId(going)) return
    after.closeTab(leafId, goingAt)
    focusIntoRefAfterCommit(refId(staying))
  })()
}

/**
 * **两格标签里这一格关得掉吗**(W7-t / B7)。格头那颗 ✕ 画不画、按下去做不做,
 * 读的都是这一只。
 *
 * 判据**不新写**:把这一格拆开之后再问 `canDetachTab` —— 那正是「关掉之后这个
 * 区域里还剩不剩同种常驻的」那句话(T0 拍点 2),与 `closePairSide` 第二步里
 * `store.closeTab` 自己问的是同一只。
 *
 * 它算的是一棵**假想的**树:这一问要在渲染里答(画不画那颗 ✕),所以只能是纯的
 * —— 一个字都不许落到 store 上。假想那一步预演的正是 `closePairSide` 的第一步
 * `store.unpairAt`。
 *
 * ── 预演与真拆读的是**同一只**(09-06 审查那笔留账的了结)────────────────
 * 从前这里手抄了 `store.unpairAt` 里那两句 `T.replaceRef` + `T.insertTab`,于是
 * 同一个树变换有两处产地 —— 改一处漏一处的下场是那颗 ✕ 按下去做的事,与它画出来
 * 时预演的不是同一件。现在两头读的都是纯函数 `tree.unpair`(判词在那只函数上):
 * 真拆那条路多做的只有**记账**(`pairRatios`),而账搬不进一次只读的预演里。
 *
 * **引用恒等 = 拆不动**,`canDetachTab` 因此在一棵原样的树上作答 —— 而上面那三句
 * 守卫已经把「不是复合的」挡在门外了,走到这里的必定拆得动。
 */
export function canClosePairSide(
  tree: PaneNode,
  leafId: string,
  index: number,
  side: 'left' | 'right',
): boolean {
  const tab = findLeaf(tree, leafId)?.tabs[index]
  const parts = tab ? partsOfContent(tab) : null
  if (!tab || !parts || parts.length < 2) return false
  return canDetachTab(T.unpair(tree, leafId, index), leafId, side === 'left' ? index : index + 1)
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
