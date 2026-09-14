import { useWorkbenchStore } from '../workbench/store'
import { refId } from '../workbench/kinds'
import { edgeRegion, floatRegion } from '../workbench/regions'
import { findLeaf, leavesOf } from '../workbench/tree'
import { findItem, floatMinOfItem } from './items'
import { panelIdOf, panelRef } from './panel-ref'
import { floatIdOfRegion, leafIndexForPanelIndex, regionOfPanel } from './residency'
import {
  canNailShelf,
  clampFloatRect,
  EXCLUSIVE_FORMS,
  freshFloatRect as T_freshFloatRect,
  memoryOf,
  placementOf,
  SHELF_SIDES,
} from './transitions'
import type { PaneNode } from '../workbench/tree'
import type { RegionId } from '../workbench/regions'
import type { ContentRef, ContentRefId } from '../workbench/kinds'
import type {
  FloatRect,
  PlacementTarget,
  PlacementMemory,
  ShelfSide,
  StageState,
  Viewport,
} from './types'

/**
 * **住处的唯一写口**(W4;从 `stage/transitions.ts` 那一族纯函数搬过来的)。
 *
 * ── 为什么它不是纯函数了 ────────────────────────────────────────────────
 * 「一块瓦此刻在哪儿」这件事实从 W4 起住在**拼贴树**里(`workbench.regions`),
 * 而「它多大 / 排第几 / 上次放在哪」仍旧住在形态机里(`stage`:`floats` /
 * `floatOrder` / `memory` / 架子厚度)。一次落定要同时改两处,而两个 store 是
 * 两台独立的机器 —— 一个纯函数说不出「同时」。
 *
 * 所以这一层是**编排**:判据仍旧全在纯函数里(`resolveOpen` / `memoryOf` /
 * `isShelfTabVisible` / `leafIndexForPanelIndex`),这里只把它们按次序接起来。
 * 不变式因此一条都没搬家,只是落笔处换了:
 *  1. **一个 id 只在一处** —— 由 `workbench.moveRef` 保证(它先从每棵树里摘干净);
 *  2. **独占形态至多一个** —— 由类型保证:`stageId` 是一格,不再是「在表里扫一遍
 *     看有没有第二个」(W4 之前那条不变式的机器化);全屏同理,它是拼贴台那本账上
 *     的 `full` 一格(W2);
 *  3. **dock 是缺席** —— 哪棵树都不在 = 收在 Dock 里,不留一条 `{kind:'dock'}`;
 *  4. **落定即写记忆** —— 每一条路的最后一句都是 `remember`,与从前逐字相同
 *     (记忆是**折过之后**的那一份:edge 记真实插入位、float 记钳过的矩形)。
 *
 * ── 谁调它 ──────────────────────────────────────────────────────────────
 * 只有 `stage/store.ts`。组件一律经 store 的 action,与 W4 之前逐字相同。
 */

/** 一次落定要写回 stage 的那几格(住处不在其中 —— 它已经落在树上了)。 */
export type StagePatch = Partial<
  Pick<
    StageState,
    'stageId' | 'floats' | 'floatOrder' | 'memory' | 'shelves' | 'flashPinned' | 'flashSide'
  >
>

/** 编排要用到的两台机器。递进来而不是各自 import,好让这一层能脱开 React 测。 */
export interface PlacementDeps {
  /** 形态机此刻的读数(投影已经算好了 —— 读的人不必知道它是投影)。 */
  stage(): StageState
  /** 写回形态机那几格。 */
  patchStage(patch: StagePatch): void
  viewport(): Viewport
}

/* ── 树那一侧的三口 ─────────────────────────────────────────────────────── */

const workbench = () => useWorkbenchStore.getState()

/** 一块瓦此刻住在哪个区域。 */
function regionOfItem(id: string): RegionId | null {
  return regionOfPanel(workbench().regions, id)
}

/**
 * 把一块瓦插进某个区域。`panelIndex` = 「排在第几块瓦之前」(位置记忆记的那一格),
 * 翻成叶内下标由 `leafIndexForPanelIndex` 负责 —— 那条边上可能还夹着文件。
 */
function placeItemIn(id: string, region: RegionId, panelIndex?: number): void {
  const ref = panelRef(id)
  const at = panelIndex === undefined ? undefined : leafIndexAt(region, panelIndex)
  workbench().moveRef(ref, region, { at })
}

function leafIndexAt(region: RegionId, panelIndex: number): number | undefined {
  const tree = workbench().regions[region]
  if (!tree) return undefined
  const leaf = leavesOf(tree)[0]
  return leaf ? leafIndexForPanelIndex(leaf, panelIndex) : undefined
}

/** 把一块瓦从每棵树里摘掉(= 收回 Dock 那一步的树侧动作)。 */
function detachItem(id: string): void {
  workbench().detachRef(refId(panelRef(id)))
}

/* ── 记忆 ──────────────────────────────────────────────────────────────── */

/** 写一条记忆。null = 无可记(在 Dock 里),此时什么都不做 —— 归档不擦旧记忆。 */
function remember(deps: PlacementDeps, id: string, m: PlacementMemory | null): void {
  if (!m) return
  deps.patchStage({ memory: { ...deps.stage().memory, [id]: m } })
}

/**
 * **落定之后**把此刻的落点折成一条记忆并写下。
 *
 * 折的是**落定后**那一份读数(所以 edge 记的是真实插入位、float 记的是钳过的矩形)
 * —— 与 W4 之前 `openAs` 最后那一句 `remember(next, id, memoryOf(next, id))` 逐字同义。
 * 差别只有一处:那一刻投影还没跑,所以这里不读投影,直接问树。
 */
function rememberLanding(deps: PlacementDeps, id: string): void {
  const region = regionOfItem(id)
  const state = deps.stage()
  if (region === null) {
    // 舞台不在树里,它的记忆由自己那一路写;全屏同理(记忆由 `placeAs` 当场写)。
    if (state.stageId === id) remember(deps, id, { kind: 'stage' })
    return
  }
  if (region.startsWith('float:')) {
    const rect = state.floats[id] ?? freshFloatRect(deps, id)
    remember(deps, id, { kind: 'float', rect })
    return
  }
  const side = sideOfRegion(region)
  if (!side) return
  remember(deps, id, { kind: 'edge', side, index: panelIndexOf(region, id) })
}

function sideOfRegion(region: RegionId): ShelfSide | null {
  const side = region.startsWith('edge:') ? (region.slice(5) as ShelfSide) : null
  return side && SHELF_SIDES.includes(side) ? side : null
}

/** 这块瓦在这个区域里排第几块**瓦**(记忆记的就是这一格)。 */
function panelIndexOf(region: RegionId, id: string): number {
  const tree = workbench().regions[region]
  if (!tree) return 0
  let seen = 0
  for (const leaf of leavesOf(tree)) {
    for (const tab of leaf.tabs) {
      const panel = panelIdOf(tab)
      if (panel === null) continue
      if (panel === id) return seen
      seen += 1
    }
  }
  return seen
}

/* ── 落点变更 ───────────────────────────────────────────────────────────── */

/**
 * **一扇新窗开在哪**(W7-p 裁定 5;修一轮把判据与读数装配一起收进纯函数)。
 *
 * 这一层只剩两句话:把此刻的形态机读数交给唯一那只产地
 * (`transitions.freshFloatRect` —— 锚在中央区右上角 + 按已开窗数层叠),
 * 外加**读一次表**(W7-d 裁定 1):`itemId` 那块瓦自述了浮窗最小身量就一并递进去。
 * 「这一格是谁」是壳这一侧的问题,纯函数只收一对数 —— 判词在
 * `stage/items.floatMinOfItem` 与 `transitions.floatRectAt` 上。
 * `itemId` 缺席(窗号是 `win-…` 那种、装的不是一块瓦)= 没有自述,听默认身量的。
 */
function freshFloatRect(deps: PlacementDeps, itemId?: string | null): FloatRect {
  return T_freshFloatRect(deps.stage(), deps.viewport(), floatMinOfItem(itemId ?? null))
}

/**
 * 一次落定的**外溢结果**(W2)。
 *
 * 除了全屏那一档,落定的全部效果都写在这两台 store 上,调用方什么都不必接。
 * 全屏是例外:它不是一个住处,落地要**另一台机器**动手
 * (`workbench.enterFull`)—— 而这一层不许 import 那台 store 的 action
 * (`PlacementDeps` 只交出形态机那两口,判词在文件头)。所以它把这件事**说出去**,
 * 由 store 那一层派工。写成可辨识联合而不是一个布尔:下一个「落定之后还要别人
 * 做一件事」的档位加一格 kind 就行。
 */
export type PlacementOutcome =
  | { kind: 'full' }
  /**
   * **这条边摆不下**(W7-p 裁定 3)。四条边与中央区分同一块地(`shelfThicknessBudget`),
   * 空着的那条边在预算不够时**整个动作拒绝**、一格状态都不写 —— 不是「钳到最小塞进去」
   * (那会把中央区压成 0,正是审计 A 的 A3)。拒绝**要说话**:播报那一句由 store 那层
   * 发(纯函数与编排层都碰不到 DOM),这一格只负责把「拒了、为了这条边」说出去。
   */
  | { kind: 'refused'; reason: 'shelf-budget'; side: ShelfSide }
  | null

/**
 * 把一块瓦放到某个落点。**全系统唯一改住处的入口**(W4 之前叫 `transitions.openAs`)。
 *
 * `edgeIndex` 只在 `edge` 那一支有意义:缺省 = 排到末尾(新来的排最后),
 * 给了 = 按记忆插回去(树自己会把越界的钳进 [0, 叶长])。
 *
 * 返回 `PlacementOutcome`:今天只有全屏那一档会说话(见上)。
 */
export function placeAs(
  deps: PlacementDeps,
  id: string,
  placement: PlacementTarget,
  edgeIndex?: number,
): PlacementOutcome {
  const viewport = deps.viewport()

  if (placement.kind === 'dock') {
    closeToDock(deps, id)
    return null
  }

  if (placement.kind === 'full') {
    /*
     * **全屏是瞬态,不是住处**(W7-p 裁定 2,审计 A 的 A2;设计 §1.3 原话:
     * 「树一个字没动,那一格 tab 仍旧住在它原来那片叶里」)。
     *
     * ── 病历 ────────────────────────────────────────────────────────────
     * W2 这一支照「上舞台」的样子写了三步:摘树 → `remember({kind:'full'})` →
     * 说给 store 听。前两步都是错的,而且是**同一个错**的两半:全屏被当成了一种
     * 住处。真机后果两条,都致命:
     *  ① 一块钉在右边的瓦全屏一次,记忆被改写成 `full` —— 退出后它回了 Dock,
     *     此后**点它永远进全屏**,右架子再也回不来(用户没有任何一步能撤销它);
     *  ② 摘树 = 那条架子上少了一格,只剩它一格的架子当场整条没了。
     *
     * ── 今天:三步全删,一个字都不写 ──────────────────────────────────────
     * 剩下的唯一一句是「把谁去铺说给 store 听」。落地那一句
     * (`stage/store.land`)不再递 `from: null`,改成**让拼贴台自己问树** ——
     * 它此刻在哪一格,退出就回哪一格,而「回」本身不需要动作:它从来没离开过。
     * 舞台那一格瞬态同样不动(`clearTransientOf` 也删了):全屏盖在它上面,
     * 退出即露出,与架子那一形逐字同一条理由。
     *
     * 「出厂就是全屏」的那些瓦(`defaultPlacement: {kind:'full'}`,今天只有
     * 「所有应用」)照旧:它们本来就不在任何一棵树里,`enterFull` 问树问不到 =
     * `from: null` = 退出即回 Dock —— 与 W2 逐字相同的行为,只是不再靠这里
     * 主动摘一次树来制造那个 null。
     */
    return { kind: 'full' }
  }

  if (EXCLUSIVE_FORMS.includes(placement.kind)) {
    /*
     * 瞬态**不在树里**(设计 §1.3),所以上台的第一件事是从树上摘干净;
     * 「至多一个」由那一格字段本身保证 —— 旧的那块自动落回 Dock。
     */
    detachItem(id)
    deps.patchStage({ stageId: id })
    remember(deps, id, { kind: 'stage' })
    return null
  }

  /*
   * 摆不下就整个拒绝(W7-p 裁定 3)——**在动手之前**问,不许写一半再回滚。
   *
   * 这一句必须排在 `clearTransientOf` **之前**(W7-p 修一轮补的次序):它从前排在
   * 后面,于是「舞台上的面 → 钉到右边 → 右边摆不下」这条路把它从舞台上踢了下来
   * 又没钉上去 —— 屏幕上那块面凭空消失,而用户点的是「钉到右边」。
   * 「拒绝 = 一格状态都不写」是这条裁定的原话,所以判据要站在所有写之前。
   */
  if (placement.kind === 'edge' && !canNailShelf(deps.stage(), placement.side, viewport)) {
    return { kind: 'refused', reason: 'shelf-budget', side: placement.side }
  }

  // 离开瞬态那一格(它可能正在舞台上)。
  clearTransientOf(deps, id)

  if (placement.kind === 'edge') {
    placeItemIn(id, edgeRegion(placement.side), edgeIndex)
    // 新入架子顺手展开:用户的动作意图是「让它看得见」(与 W4 之前逐字相同)。
    setShelfCollapsed(deps, placement.side, false)
    activateInLeaf(edgeRegion(placement.side), id)
    rememberLanding(deps, id)
    return null
  }

  /*
   * 浮窗:**窗 id 就是瓦 id**(判词在 `residency.regionOfPlacement`),于是矩形表、
   * 置顶序与位置记忆一个字都不用改。矩形在建窗之前先钳好 —— 投影器随后把这扇窗
   * 排进 `floatOrder` 的末位(末位最上)。
   */
  const rect = clampFloatRect(deps.stage().floats[id] ?? freshFloatRect(deps, id), viewport)
  deps.patchStage({ floats: { ...deps.stage().floats, [id]: rect } })
  placeItemIn(id, floatRegion(id))
  rememberLanding(deps, id)
  return null
}

/** 这块瓦如果正占着某个瞬态格,把那一格清掉。 */
function clearTransientOf(deps: PlacementDeps, id: string): void {
  const state = deps.stage()
  if (state.stageId === id) deps.patchStage({ stageId: null })
}

/** 把这块瓦在它那片叶里点成活动的(新来的一格该看得见)。 */
function activateInLeaf(region: RegionId, id: string): void {
  activateRefIn(region, refId(panelRef(id)))
}

/** 同一句话的内容版:把这一格(任何一种 ref)在它那片叶里点成活动的。 */
function activateRefIn(region: RegionId, target: ContentRefId): void {
  const store = workbench()
  const tree = store.regions[region]
  if (!tree) return
  for (const leaf of leavesOf(tree)) {
    const at = leaf.tabs.findIndex((tab) => refId(tab) === target)
    if (at >= 0) {
      store.activateTab(leaf.id, at)
      return
    }
  }
}

/**
 * 收回 Dock。**关闭是归档,不是删除**:先把当下的落点折成记忆,再摘活表 ——
 * 顺序反了就什么都记不到。已经在 Dock 里的是空动作。
 */
export function closeToDock(deps: PlacementDeps, id: string): void {
  const before = deps.stage()
  if (placementOf(before, id).kind === 'dock') return
  remember(deps, id, memoryOf(before, id))
  clearTransientOf(deps, id)
  detachItem(id)
}

/**
 * 按一条记忆把 id 放回去。三种形态各自要补的那一件事都在这里(与 W4 之前的
 * `openFromMemory` 逐字同义):
 *  · edge:插回记忆里那一格次序(越界由树自己钳);
 *  · float:**记忆里有矩形才写**,先过与拖拽落定同一把视口钳制;
 *  · stage / full:没有第二个参数(全屏那一档把落地说给 store 听,见 `PlacementOutcome`)。
 *
 * ── 浮窗那一档为什么要分「有没有矩形」(W7-p 修一轮裁定 1)──────────────────
 * 从前这里无条件写一格 `floats[id]`,而记忆里那个矩形是 `completeMemory` 当场编的
 * 恒定值 —— 于是 `placeAs` 看到「已经有矩形了」,跳过唯一那只产地 `freshFloatRect`,
 * 点瓦开出来的四扇窗一模一样地叠在一起。**没有矩形就什么都不写**,让 `placeAs`
 * 去问产地:锚与层叠因此在**每一条**开窗路上都成立,不只右键菜单那一条。
 */
export function openFromMemory(
  deps: PlacementDeps,
  id: string,
  m: PlacementMemory,
): PlacementOutcome {
  if (m.kind === 'stage') return placeAs(deps, id, { kind: 'stage' })
  if (m.kind === 'full') return placeAs(deps, id, { kind: 'full' })
  if (m.kind === 'edge') return placeAs(deps, id, { kind: 'edge', side: m.side }, m.index)
  if (m.rect) {
    const rect = clampFloatRect(m.rect, deps.viewport())
    deps.patchStage({ floats: { ...deps.stage().floats, [id]: rect } })
  }
  return placeAs(deps, id, { kind: 'float' })
}

/* ── 手势 ──────────────────────────────────────────────────────────────── */

/*
 * ── `clickDockIcon` 整只删了(W7-p 裁定 6,审计 A 的 A7/A8)────────────────
 * 它是「点 Dock 瓦这一下什么意思」的**第二台机器**:四条 if,与召唤那四态讲两种
 * 语言。同一块浮窗已经在最上面时,它答「再置顶一次」(零反馈,用户以为点坏了),
 * 召唤答「送焦点」;再点一下它还是零反馈,召唤收起来。用户只有一套心智,所以
 * 只该有一台机器。
 *
 * 今天两个入口都走 `stage/store.summonItem` → `summon.summonFromSituation`。
 * 这只函数**不留门面**:留一个转发就是留一个「下一个人往里加特例」的位子。
 * 它当年那几件事一件没丢 —— 架子闪烁搬进了 store 的 reveal 支(那里对两个入口
 * 同时成立),`openFromMemory` 是召唤第一态的落点,收整条架子是第四态的落点。
 */

/** 置顶:挪到 `floatOrder` 末位。不是浮窗、或已经在末位,都是空动作。 */
export function focusFloatIn(deps: PlacementDeps, id: string): void {
  const order = deps.stage().floatOrder
  const at = order.indexOf(id)
  if (at < 0 || at === order.length - 1) return
  deps.patchStage({ floatOrder: [...order.filter((x) => x !== id), id] })
}

/**
 * 点名一条边上的那一格。**不在这条边上、或已经是活动的,都是空动作**
 * (与 W4 之前的 `transitions.activateShelfTab` 逐字同一句话,只是落在树上)。
 */
export function activateShelfTabIn(_deps: PlacementDeps, side: ShelfSide, id: string): void {
  activateInLeaf(edgeRegion(side), id)
}

/** 收 / 展整条架子。tab 次序与活动 tab 一个都不动 —— 收起的是栏,不是内容。 */
export function setShelfCollapsed(deps: PlacementDeps, side: ShelfSide, collapsed: boolean): void {
  const shelves = deps.stage().shelves
  if (shelves[side].collapsed === collapsed && shelves[side].collapsedBy === undefined) return
  /*
   * **`collapsedBy` 一并清掉**(W7-d 裁定 2,与 `transitions.setShelfCollapsed` 逐字
   * 同一条)。这条路是「往这条边上放了一格东西,顺手展开它」—— 那是**用户的动作
   * 意图**,所以从这一刻起这条架子归用户管,预算不许再替他收展。
   */
  deps.patchStage({
    shelves: { ...shelves, [side]: { ...shelves[side], collapsed, collapsedBy: undefined } },
  })
}

/**
 * **让一个区域看得见**(2026-09-14 报障「点击文件打不开了,选择的是 Pinned right」)。
 *
 * 真机读数:右架子 `collapsed` 且把手 `hidden`(宽 0px),树里已经躺着 8 个文件
 * tab —— 每一次单击都真的开进去了,只是没人把架子展开。瓦钉到边那条路(上面
 * `placeRefIn` 的 `setShelfCollapsed(false)`)与拖拽落定那条路(`drop-commit`)
 * 各自写过一遍「新入架子顺手展开」,文件按「打开方式」落进 `edge:*` 那条路漏了
 * —— 三处两份产地,第三处就没有。所以并成**这一句**:落点是哪个区域,就让那个
 * 区域露脸。边 = 展开架子(把手藏着也照旧展开:藏的是把手不是架子,判词在
 * `ShelfRail`);浮窗 = 置顶那扇窗;中央区永远看得见,空动作。
 *
 * 它不问「区域里有什么」,所以内容种类一个名字都不出现 —— 第三种内容要落进
 * 架子时不必再动这只文件。
 */
export function revealRegionIn(deps: PlacementDeps, region: RegionId): void {
  const side = sideOfRegion(region)
  if (side) {
    setShelfCollapsed(deps, side, false)
    return
  }
  const floatId = floatIdOfRegion(region)
  if (floatId !== null) focusFloatIn(deps, floatId)
}

/* ── 整栏 / 整扇 ───────────────────────────────────────────────────────── */

/**
 * 整栏关闭:这条边上的**瓦**逐个收回 Dock,**别的内容**(文件)藏起来 ——
 * 它们的家不在 Dock 上,收回 Dock 对它们没有意义(设计 §2.3:能回来的那条路
 * 叫隐藏)。
 *
 * 次序要在**动手之前**整条拓下来:逐个收会让后面的次序一路往前塌,那样记下的
 * 就是塌过的次序 —— 整栏关掉再一个个开回来,三块瓦会挤成一摞。
 */
export function closeShelf(deps: PlacementDeps, side: ShelfSide): void {
  const region = edgeRegion(side)
  const tree = workbench().regions[region]
  if (!tree) return
  const before = deps.stage()
  const items = panelsOf(tree)
  const memory = { ...before.memory }
  for (const id of items) {
    const m = memoryOf(before, id)
    if (m) memory[id] = m
  }
  // 先把整条边藏起来(文件那些格因此拿得回来),再把瓦那几格从隐藏表里摘掉:
  // 瓦的「回来的路」是 Dock + 位置记忆,不该在隐藏表里再留一条。
  workbench().hideRegion(region)
  if (items.length > 0) {
    const gone = new Set(items.map((id) => refId(panelRef(id))))
    useWorkbenchStore.setState((s) => ({
      hidden: s.hidden.filter((entry) => !gone.has(refId(entry.ref))),
    }))
  }
  deps.patchStage({ memory })
}

/**
 * 关一扇浮窗 = **把里面的 tab 全部隐藏**(设计 §2.2:「窗子没了,内容还在」)。
 *
 * 与「收回 Dock」的差别是一句话:收回 Dock 只对**瓦**说得通(它的家在 Dock 上),
 * 而一扇窗里可能装着文件 —— 文件没有 Dock 可回,隐藏才是它回得来的那条路。
 * 瓦也一起进隐藏表:它于是有两条回来的路(Dock 与「隐藏的标签 ⋯」),两条都对。
 */
export function closeFloat(deps: PlacementDeps, floatId: string): void {
  const region = floatRegion(floatId)
  const tree = workbench().regions[region]
  if (!tree) return
  const before = deps.stage()
  const memory = { ...before.memory }
  for (const id of panelsOf(tree)) {
    const m = memoryOf(before, id)
    if (m) memory[id] = m
  }
  workbench().hideRegion(region)
  deps.patchStage({ memory })
}

function panelsOf(tree: PaneNode): string[] {
  const out: string[] = []
  for (const leaf of leavesOf(tree)) {
    for (const tab of leaf.tabs) {
      const id = panelIdOf(tab)
      if (id !== null) out.push(id)
    }
  }
  return out
}

/* ── 瞬态那两格 ─────────────────────────────────────────────────────────── */

export function closeStage(deps: PlacementDeps): void {
  const id = deps.stage().stageId
  if (id === null) return
  closeToDock(deps, id)
}

/* ── 内容级的搬家(不只是瓦)──────────────────────────────────────────────── */

/**
 * **把任意一块内容摆到某个区域**(W4 解灰「打开方式」那五档要的那一口)。
 *
 * 与 `placeAs` 的分工:那一只说的是**瓦**的形态语言(`Placement`),这一只说的是
 * **内容**的区域语言(`RegionId`)。文件没有 Dock、没有位置记忆,所以它不折记忆;
 * 它要的只是「插进那棵树,并把宿主该展开的展开」。
 */
export function placeRefIn(
  deps: PlacementDeps,
  ref: ContentRef,
  region: RegionId,
  opts: { rect?: FloatRect; activate?: boolean } = {},
): PlacementOutcome {
  const id = panelIdOf(ref)
  if (id !== null) {
    // 瓦仍旧走形态机那条路 —— 记忆、闪烁、独占都在那儿。
    const side = sideOfRegion(region)
    // 这两档 `placeAs` 答不出全屏,但**答得出拒绝**(W7-p 裁定 3),所以结果要接住。
    if (side) return placeAs(deps, id, { kind: 'edge', side })
    if (region.startsWith('float:')) return placeAs(deps, id, { kind: 'float' })
  }
  const side = sideOfRegion(region)
  /*
   * **文件走同一条预算**(W7-p 裁定 3)。判据在瓦那条路之外再问一次而不是并到
   * `placeAs` 里,是因为这一支根本不经过它:`placeAs` 说的是瓦的形态语言,
   * 而一个文件钉到边上是内容的区域语言(判词在这只函数的头上)。同一个纯函数、
   * 同一个答案,所以不是第二把尺。
   */
  if (side && !canNailShelf(deps.stage(), side, deps.viewport())) {
    return { kind: 'refused', reason: 'shelf-budget', side }
  }
  // `activate: false` 是后台开那一档(⌘-click):摆进去,但那个区域里人正看着的
  // 那一格不换。缺席 = 照旧激活。
  workbench().moveRef(ref, region, opts.activate === undefined ? {} : { activate: opts.activate })
  if (side) {
    setShelfCollapsed(deps, side, false)
    return null
  }
  const floatId = region.startsWith('float:') ? region.slice('float:'.length) : null
  if (floatId === null) return null
  const viewport = deps.viewport()
  /* 窗号(`win-…`)不是瓦 id —— 自述要从**这一格装的内容**上问(`panelIdOf`:
   * 不是一块瓦就是 null,那就没有自述)。判词在 `freshFloatRect` 的头上。 */
  const rect = clampFloatRect(
    opts.rect ?? deps.stage().floats[floatId] ?? freshFloatRect(deps, panelIdOf(ref)),
    viewport,
  )
  deps.patchStage({ floats: { ...deps.stage().floats, [floatId]: rect } })
  return null
}

/**
 * **整扇浮窗塌进一条边的架子**(2026-09-14;`FloatWindow` 文件头状态表 ① 那一行
 * 「换宿主 —— 吸到边上:树整棵搬进 `edge:<side>`,这扇窗随之卸载」的落定本体)。
 *
 * ── 病历:浏览器窗拖到四条边上都滑回原位 ────────────────────────────────────
 * 拖窗那条路的落定从前写的是 `floatToEdge(id, side)`,而 `id` 递的是**窗号**。
 * `floatToEdge` 说的是**瓦**的形态语言:它先问 `placementOf(state, id).kind === 'float'`,
 * 而 `placements` 那张表只按瓦 id 记 —— 一扇装着浏览器 / 终端 / 文件 / diff 的窗,
 * 窗号是 `nextFloatId` 铸的 `win-…`,表里查无此人,那一句当场 `return`,一格状态都
 * 没写,松手后屏幕上的窗回到 `stored` 那一份。瓦撕出来的窗**窗号就是瓦 id**
 * (`residency.regionOfPlacement` 的判词),所以只有它们钉得上去,用户在浏览器上
 * 第一个踩到。
 *
 * ── 治法:说窗的话,不说瓦的话 ─────────────────────────────────────────────
 * 这一只收的是**窗号**,做的是「这扇窗里每一格都搬进那条边」:一格是瓦就走
 * `placeAs`(记忆 / 瞬态 / 独占都在那条老路上),其余走 `moveRef` —— 两条路
 * 本来就合在 `placeRefIn` 里,这里只是按**阅读序**逐格调它,所以架子上的次序与
 * 窗里逐字相同(`insertTab` 缺 `at` = 追加到末尾)。这只函数里 grep `'browser'` /
 * `'file'` / `'terminal'` 零命中:再多一种能撕成浮窗的内容,这条路一个字不改。
 *
 *  · 预算**先问一次**再动手(W7-p 裁定 3「拒绝 = 一格状态都不写」):判据与逐格那
 *    一次读的是同一只 `canNailShelf`,而对侧架子在整个循环里不变,所以要么全进
 *    要么全拒,不会进一半;
 *  · 活动那一格**搬完再点回来**:逐格搬时每一格都把自己点成活动的(那是「新来的
 *    一格该看得见」那条老规矩),但用户拖的是整扇窗,松手后看着的该还是松手前
 *    看着的那一格;
 *  · 窗号不是瓦 id 时,`floats[窗号]` 那格矩形随窗一起退役 —— 没有任何一条路会
 *    再拿这个窗号开窗(下一次撕出来是新号),留着只是账上一格死数。瓦的那一格
 *    照旧留着,它是 `edgeToFloat` 的记忆。
 */
export function placeFloatIn(deps: PlacementDeps, winId: string, side: ShelfSide): PlacementOutcome {
  const region = floatRegion(winId)
  const tree = workbench().regions[region]
  if (!tree) return null
  const leaves = leavesOf(tree)
  const refs = leaves.flatMap((leaf) => leaf.tabs)
  if (refs.length === 0) return null
  const first = leaves[0]
  const active = first?.tabs[first.active] ?? refs[0]
  if (!canNailShelf(deps.stage(), side, deps.viewport())) {
    return { kind: 'refused', reason: 'shelf-budget', side }
  }
  for (const ref of refs) placeRefIn(deps, ref, edgeRegion(side))
  activateRefIn(edgeRegion(side), refId(active))
  if (!findItem(winId) && winId in deps.stage().floats) {
    const { [winId]: _gone, ...floats } = deps.stage().floats
    deps.patchStage({ floats })
  }
  return null
}

/**
 * **整条架子弹成一扇浮窗**(2026-09-14;`placeFloatIn` 的反向,同一个病的另一半)。
 *
 * 架子檐菜单里「弹出 X 为浮窗」从前调 `edgeToFloat(根叶活动格的瓦 id)`,于是一条
 * 装着浏览器 / 文件的架子那一行整个灰着 —— 判据还是瓦的话。这一只收的是**边**,
 * 做的是「这条架子上每一格都搬进一扇窗」:
 *  · 窗号:架子上**第一块瓦**的 id(瓦撕出来的窗窗号就是瓦 id,矩形 / 置顶 / 记忆
 *    三张表都按它记,一个字不用改);一块瓦都没有就铸一个 `win-…`;
 *  · 第一块瓦经 `placeRefIn` → `placeAs`(记忆 / 瞬态一件不少),其余每一格
 *    (别的瓦也算)经 `moveRef` 搬进**同一扇**窗 —— 直接调 `placeRefIn` 的话
 *    第二块瓦会按自己的 id 另开一扇,而用户点的是「弹出**这条架子**」;
 *    这些瓦的位置记忆因此不在这里改写(它们下次从 Dock 开出来仍按旧记忆,可接受:
 *    记忆说的是「上次自己在哪」,而它们这次不是自己走的);
 *  · 活动那一格搬完点回来,新窗置顶(投影把新长出来的窗排末位 = 最上)。
 * 架子空了,`moveRef` 里的 `pruneRegions` 会把那棵树收掉,`shelves[side]` 的投影
 * 随之清空 —— 与瓦那条老路留下的架子状态逐字相同。
 */
export function placeShelfInFloat(deps: PlacementDeps, side: ShelfSide): PlacementOutcome {
  const region = edgeRegion(side)
  const tree = workbench().regions[region]
  if (!tree) return null
  const leaves = leavesOf(tree)
  const refs = leaves.flatMap((leaf) => leaf.tabs)
  if (refs.length === 0) return null
  const first = leaves[0]
  const active = first?.tabs[first.active] ?? refs[0]
  const anchor = refs.find((ref) => panelIdOf(ref) !== null)
  const winId = anchor ? panelIdOf(anchor)! : nextFloatId()
  const floatAt = floatRegion(winId)
  if (anchor) placeRefIn(deps, anchor, floatAt)
  for (const ref of refs) {
    if (ref === anchor) continue
    if (anchor) workbench().moveRef(ref, floatAt)
    else placeRefIn(deps, ref, floatAt)
  }
  activateRefIn(floatAt, refId(active))
  focusFloatIn(deps, winId)
  return null
}

/** 一扇新窗的 id。**单调计数 + 启动戳**,理由与 `workbench/ids` 逐字相同。 */
let floatSeq = 0
const floatBoot = Date.now().toString(36).slice(-5)

export function nextFloatId(): string {
  floatSeq += 1
  return `win-${floatBoot}-${floatSeq}`
}

/** 树上还剩不剩这个 leafId(浮窗宿主判「我这扇窗还在不在」用)。 */
export function regionHasLeaf(region: RegionId, leafId: string): boolean {
  const tree = workbench().regions[region]
  return tree ? findLeaf(tree, leafId) !== null : false
}

/** 一块瓦此刻在哪个区域 —— 给外面(测试 / 门)读的那一口。 */
export { regionOfItem }

/*
 * 模块级可变状态(那格窗号计数)= 这个模块实例的寿命,配一段 HMR 退役
 * (CLAUDE.md 那条法)。幂等;生产构建里 `import.meta.hot` 是 undefined,
 * 整段被 tree-shake 掉。**计数归零是安全的** —— 启动戳那一段保证跨模块实例不撞。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    floatSeq = 0
  })
}
