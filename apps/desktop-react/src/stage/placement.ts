import { useWorkbenchStore } from '../workbench/store'
import { refId } from '../workbench/kinds'
import { edgeRegion, floatRegion } from '../workbench/regions'
import { findLeaf, leavesOf } from '../workbench/tree'
import { panelIdOf, panelRef } from './panel-ref'
import { leafIndexForPanelIndex, regionOfPanel } from './residency'
import {
  clampFloatRect,
  defaultFloatRect,
  EXCLUSIVE_FORMS,
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
    const rect = state.floats[id] ?? defaultFloatRect(deps.viewport())
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
 * 一次落定的**外溢结果**(W2)。
 *
 * 除了全屏那一档,落定的全部效果都写在这两台 store 上,调用方什么都不必接。
 * 全屏是例外:它不是一个住处,落地要**另一台机器**动手
 * (`workbench.enterFull`)—— 而这一层不许 import 那台 store 的 action
 * (`PlacementDeps` 只交出形态机那两口,判词在文件头)。所以它把这件事**说出去**,
 * 由 store 那一层派工。写成可辨识联合而不是一个布尔:下一个「落定之后还要别人
 * 做一件事」的档位加一格 kind 就行。
 */
export type PlacementOutcome = { kind: 'full' } | null

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
     * **全屏**(W2,拍点 ② 接替「盖」那一档)。三步,与「上舞台」同型:
     *  ① 从每棵树里摘干净 —— 这块瓦此刻不住在任何区域里(它铺满窗子);
     *  ② 记忆当场写下(落定即写,与别的档逐字同一条纪律);
     *  ③ 把「谁去铺」这件事说给 store 听 —— 真正的那一格瞬态住在拼贴台那本账上。
     * 「至多一个」由那一格字段本身保证:后来的那块把前一块顶掉,前一块回 Dock
     * (它已经不在树里 = 缺席 = dock,与舞台那一路逐字同义)。
     */
    clearTransientOf(deps, id)
    detachItem(id)
    remember(deps, id, { kind: 'full' })
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
  const rect = clampFloatRect(deps.stage().floats[id] ?? defaultFloatRect(viewport), viewport)
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
  remember(deps, id, memoryOf(before, id, deps.viewport()))
  clearTransientOf(deps, id)
  detachItem(id)
}

/**
 * 按一条记忆把 id 放回去。三种形态各自要补的那一件事都在这里(与 W4 之前的
 * `openFromMemory` 逐字同义):
 *  · edge:插回记忆里那一格次序(越界由树自己钳);
 *  · float:矩形先过**与拖拽落定同一把**视口钳制;
 *  · stage / full:没有第二个参数(全屏那一档把落地说给 store 听,见 `PlacementOutcome`)。
 */
export function openFromMemory(
  deps: PlacementDeps,
  id: string,
  m: PlacementMemory,
): PlacementOutcome {
  if (m.kind === 'stage') return placeAs(deps, id, { kind: 'stage' })
  if (m.kind === 'full') return placeAs(deps, id, { kind: 'full' })
  if (m.kind === 'edge') return placeAs(deps, id, { kind: 'edge', side: m.side }, m.index)
  const rect = clampFloatRect(m.rect, deps.viewport())
  deps.patchStage({ floats: { ...deps.stage().floats, [id]: rect } })
  return placeAs(deps, id, { kind: 'float' })
}

/* ── 手势 ──────────────────────────────────────────────────────────────── */

/**
 * 点 Dock 图标。先问「它现在在哪」,再决定这一下是什么意思(判据表与 W4 之前
 * 逐字相同,只是读的是投影、写的是树):
 *  - 在舞台上 → 关掉(再点一次收回去)。**「正在全屏」那一形不在这里判** ——
 *    它不是一种 Placement,判据在 store 那一层(它同时看得见拼贴台那本账)
 *  - 在架子上 → 不新开:看不见就点名 + 展开 + 闪一下;看得见就收起整栏
 *  - 已是浮窗 → 置顶它
 *  - 在 Dock 里 → 按解析出的记忆开
 */
export function clickDockIcon(
  deps: PlacementDeps,
  id: string,
  open: PlacementMemory,
): PlacementOutcome {
  const state = deps.stage()
  const current = placementOf(state, id)

  if (EXCLUSIVE_FORMS.includes(current.kind)) {
    closeToDock(deps, id)
    return null
  }

  if (current.kind === 'edge') {
    const shelf = state.shelves[current.side]
    // 判据读**那一只**共用的查询,不在这里再抄一句(见 `isShelfTabVisible`)。
    if (!shelf.collapsed && (shelf.visible ?? []).includes(id)) {
      setShelfCollapsed(deps, current.side, true)
      return null
    }
    activateInLeaf(edgeRegion(current.side), id)
    setShelfCollapsed(deps, current.side, false)
    // 闪一下告诉用户「你要的东西已经在这儿了」。
    deps.patchStage({ flashPinned: state.flashPinned + 1, flashSide: current.side })
    return null
  }

  if (current.kind === 'float') {
    focusFloatIn(deps, id)
    return null
  }

  return openFromMemory(deps, id, open)
}

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
    const m = memoryOf(before, id, deps.viewport())
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
    const m = memoryOf(before, id, deps.viewport())
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
): void {
  const id = panelIdOf(ref)
  if (id !== null) {
    // 瓦仍旧走形态机那条路 —— 记忆、闪烁、独占都在那儿。
    const side = sideOfRegion(region)
    // 这两档 `placeAs` 恒答 null(只有全屏那一档会说话),所以这里不接结果。
    if (side) {
      placeAs(deps, id, { kind: 'edge', side })
      return
    }
    if (region.startsWith('float:')) {
      placeAs(deps, id, { kind: 'float' })
      return
    }
  }
  workbench().moveRef(ref, region)
  const side = sideOfRegion(region)
  if (side) {
    setShelfCollapsed(deps, side, false)
    return
  }
  const floatId = region.startsWith('float:') ? region.slice('float:'.length) : null
  if (floatId === null) return
  const viewport = deps.viewport()
  const rect = clampFloatRect(opts.rect ?? deps.stage().floats[floatId] ?? defaultFloatRect(viewport), viewport)
  deps.patchStage({ floats: { ...deps.stage().floats, [floatId]: rect } })
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
