import { useWorkbenchStore } from '../workbench/store'
import { refId } from '../workbench/kinds'
import { edgeRegion, floatRegion } from '../workbench/regions'
import { findLeaf, leavesOf } from '../workbench/tree'
import { panelIdOf, panelRef } from './panel-ref'
import { leafIndexForPanelIndex, regionOfPanel } from './residency'
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
import type { ContentRef } from '../workbench/kinds'
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
    const rect = state.floats[id] ?? freshFloatRect(deps)
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
 * 这一层只剩一句话:把此刻的形态机读数交给唯一那只产地
 * (`transitions.freshFloatRect` —— 锚在中央区右上角 + 按已开窗数层叠)。
 * 从前「中央区矩形 + 已开窗数」这两句在这里与 `stage/store.ensureFloatRect` 里
 * **各写了一遍**,收成 `transitions.floatSpawnContext` 一只之后两处调同一个。
 */
function freshFloatRect(deps: PlacementDeps): FloatRect {
  return T_freshFloatRect(deps.stage(), deps.viewport())
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
  const rect = clampFloatRect(deps.stage().floats[id] ?? freshFloatRect(deps), viewport)
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
  const store = workbench()
  const tree = store.regions[region]
  if (!tree) return
  const target = refId(panelRef(id))
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
  if (shelves[side].collapsed === collapsed) return
  deps.patchStage({ shelves: { ...shelves, [side]: { ...shelves[side], collapsed } } })
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
  opts: { rect?: FloatRect } = {},
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
  workbench().moveRef(ref, region)
  if (side) {
    setShelfCollapsed(deps, side, false)
    return null
  }
  const floatId = region.startsWith('float:') ? region.slice('float:'.length) : null
  if (floatId === null) return null
  const viewport = deps.viewport()
  const rect = clampFloatRect(
    opts.rect ?? deps.stage().floats[floatId] ?? freshFloatRect(deps),
    viewport,
  )
  deps.patchStage({ floats: { ...deps.stage().floats, [floatId]: rect } })
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
