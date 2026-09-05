import { leavesOf } from '../workbench/tree'
import { edgeRegion, floatRegion } from '../workbench/regions'
import { panelIdOf, panelRef } from './panel-ref'
import { SHELF_SIDES } from './transitions'
import type { PaneLeafNode, PaneNode } from '../workbench/tree'
import type { RegionId } from '../workbench/regions'
import type { Placement, ShelfSide, ShelfState, StageState } from './types'

/**
 * **住处**(W4,设计 `apps/desktop-react/docs/workbench-2026-09.md` §1.3)。
 *
 * 一句话:**「这块瓦在哪儿」不再是存下来的一格,而是「它在哪棵树里」算出来的**。
 *
 * ── 为什么必须反过来 ────────────────────────────────────────────────────
 * W4 之前,一条架子上有什么由 `ShelfState.tabs: string[]`(一串瓦 id)说了算。
 * 那张表只装得下瓦 —— 于是「把一个文件钉到右边」在 W1-a 里只能禁灰,因为文件
 * 根本没有瓦 id。把架子的身子换成一棵拼贴树之后,那条边上装的是 `ContentRef`,
 * 瓦与文件在树里是**同一等公民**,五档「打开方式」于是自然解灰。
 *
 * 一旦树是真相,`placements` / `shelves[side].tabs` 就不能再是第二份事实 ——
 * 两份事实必然分叉,而分叉的第一处一定是「拖一个 tab 到另一条边」那种同时改到
 * 两处的手势。所以它们降格成**投影**:这只文件是那份投影的**唯一产地**,
 * `stage/store.ts` 里那条订阅是它**唯一的写者**。
 *
 * ── 投影都投什么 ────────────────────────────────────────────────────────
 *  · `placements[瓦 id]` —— 它在哪个区域(`edge:<side>` → 钉边;`float:<id>` → 浮窗);
 *    哪棵树都不在 = 缺席 = 收在 Dock 里(与 W4 之前逐字同一条约定);
 *  · `shelves[side].tabs / activeId / visible` —— 那条边那棵树里的瓦,按阅读序;
 *  · `floatOrder` —— 只留还有树的那些浮窗,新长出来的排到末位(末位最上)。
 *
 * ── 瞬态**不是**投影 ────────────────────────────────────────────────────
 * 舞台装的是「此刻在看的那一眼」,它不在任何一棵树里(设计 §1.3 把 `stage` /
 * `full` 单列成两格瞬态)。所以它是 stage 自己存的一格(`stageId`),投影时
 * **盖在**树那一份上面 —— 一块瓦上了舞台,它就不在架子上了
 * (`openAs` 会先把它从树里摘干净)。
 *
 * **另一格瞬态(全屏)根本不经过这里**(W2):它住在拼贴台那本账上
 * (`workbench.full`),而且树一个字没动 —— 一块内容进全屏,它在哪棵树里是不变的。
 * 所以投影表里没有它,「被全屏盖住了吗」由 `workbench.occludedByFull` 自己答。
 *
 * 整只文件是**纯函数**:没有 React、没有 store、没有 DOM。
 */

/* ── 区域 ⇄ 落点 ────────────────────────────────────────────────────────── */

const EDGE_PREFIX = 'edge:'
const FLOAT_PREFIX = 'float:'

/**
 * 一个区域对应形态机里的哪个落点。中央区答 `null` —— 它不是形态机的地方
 * (形态机管的是「摆到窗子边上/浮出来」,中央区是拼贴台自己的地)。
 */
export function placementOfRegion(region: string): Placement | null {
  if (region.startsWith(EDGE_PREFIX)) {
    const side = region.slice(EDGE_PREFIX.length) as ShelfSide
    return SHELF_SIDES.includes(side) ? { kind: 'edge', side } : null
  }
  if (region.startsWith(FLOAT_PREFIX)) return { kind: 'float' }
  return null
}

/** 这个区域是不是某扇浮窗;是就给出那扇窗的 id。 */
export function floatIdOfRegion(region: string): string | null {
  return region.startsWith(FLOAT_PREFIX) ? region.slice(FLOAT_PREFIX.length) : null
}

/**
 * 落点 → 区域。浮窗要一个**窗 id**:
 *  · 一块瓦浮出来时,窗 id **就是瓦 id** —— 于是 `floats[id]` 那张矩形表、
 *    `floatOrder` 那条置顶序、以及位置记忆里的 `{kind:'float', rect}`
 *    一个字都不用改(W4 之前它们本来就是按瓦 id 记的);
 *  · 别的内容(一个文件)浮出来时由调用方铸一个新 id(`nextFloatId`)。
 */
export function regionOfPlacement(placement: Placement, floatId: string): RegionId | null {
  if (placement.kind === 'edge') return edgeRegion(placement.side)
  if (placement.kind === 'float') return floatRegion(floatId)
  return null
}

/* ── 树上的查询 ─────────────────────────────────────────────────────────── */

/** 这棵树里的瓦 id,按阅读序(左→右 / 上→下)。 */
export function panelIdsOf(node: PaneNode): string[] {
  const out: string[] = []
  for (const leaf of leavesOf(node)) {
    for (const tab of leaf.tabs) {
      const id = panelIdOf(tab)
      if (id !== null) out.push(id)
    }
  }
  return out
}

/** 这棵树里**此刻显形**的那些瓦(每片叶各一格活动 tab)。 */
export function visiblePanelIdsOf(node: PaneNode): string[] {
  const out: string[] = []
  for (const leaf of leavesOf(node)) {
    const active = leaf.tabs[leaf.active]
    const id = active ? panelIdOf(active) : null
    if (id !== null) out.push(id)
  }
  return out
}

/** 这块瓦此刻在哪个区域(哪棵树都不在 = null)。 */
export function regionOfPanel(
  regions: Record<string, PaneNode>,
  id: string,
): RegionId | null {
  for (const [region, tree] of Object.entries(regions)) {
    if (panelIdsOf(tree).includes(id)) return region as RegionId
  }
  return null
}

/**
 * **「第 n 块瓦」在这片叶里排第几格**。
 *
 * 位置记忆记的是「它在那条边上排第几」(`PlacementMemory.edge.index`),而那一格
 * 数的是**瓦**;树里那片叶还可能夹着文件。所以放回去的时候要把「第 n 块瓦」翻成
 * 「叶内第几格」——不翻的话,一条混着两个文件的架子会把瓦插到错的位置上。
 *
 * n 超过瓦数 = 排到末尾(与 W4 之前 `clamp(index, 0, tabs.length)` 同一句话)。
 */
export function leafIndexForPanelIndex(leaf: PaneLeafNode, panelIndex: number): number {
  if (panelIndex <= 0) return 0
  let seen = 0
  for (let at = 0; at < leaf.tabs.length; at += 1) {
    if (panelIdOf(leaf.tabs[at]) === null) continue
    if (seen === panelIndex) return at
    seen += 1
  }
  return leaf.tabs.length
}

/** 一块瓦的内容引用(转发,免得调用方为一行翻译再 import 一个模块)。 */
export { panelRef, panelIdOf }

/* ── 投影 ───────────────────────────────────────────────────────────────── */

/** 投影出来的那三格。**只有 `stage/store.ts` 那条订阅该写它们。** */
export interface ResidencyProjection {
  placements: Record<string, Placement>
  shelves: Record<ShelfSide, ShelfState>
  floatOrder: string[]
}

/** 投影的输入里属于「瞬态」的那一半(它们不在树里,见文件头)。 */
export interface TransientForms {
  stageId: string | null
}

/**
 * 把树折成形态机读得懂的那三格。**幂等**,而且没变时**交回同一批对象** ——
 * 后者是订阅那一侧「没变就不 set」的判据(`sameProjection`)。
 */
export function projectResidency(
  regions: Record<string, PaneNode>,
  prev: Pick<StageState, 'shelves' | 'floatOrder'>,
  transient: TransientForms,
): ResidencyProjection {
  const placements: Record<string, Placement> = {}
  for (const [region, tree] of Object.entries(regions)) {
    const placement = placementOfRegion(region)
    if (!placement) continue
    for (const id of panelIdsOf(tree)) placements[id] = placement
  }
  /*
   * 瞬态**盖在**树那一份上面。理论上盖不到东西(上舞台之前会先从树里摘掉),
   * 写成「后写赢」是为了让不变式只有一个方向:**瞬态说了算**。
   */
  if (transient.stageId) placements[transient.stageId] = { kind: 'stage' }

  const shelves = {} as Record<ShelfSide, ShelfState>
  for (const side of SHELF_SIDES) {
    const tree = regions[edgeRegion(side)]
    const base = prev.shelves[side]
    shelves[side] = {
      ...base,
      tabs: tree ? panelIdsOf(tree) : [],
      // 「活动的那一个」= 第一片叶此刻活动的那格瓦(单叶架子上这就是全部真相)。
      visible: tree ? visiblePanelIdsOf(tree) : [],
      activeId: tree ? (visiblePanelIdsOf(tree)[0] ?? null) : null,
    }
  }

  /*
   * 置顶序:先剔掉已经没有树的那些窗(最后一格 tab 走了 = 那扇窗没了),
   * 再把新长出来的排到末位 —— 新开的窗在最上面,与 `openAs` 从前那句
   * `floatOrder: [...order, id]` 逐字同一个结果。
   */
  const alive = prev.floatOrder.filter((id) => regions[floatRegion(id)] !== undefined)
  const known = new Set(alive)
  const fresh: string[] = []
  for (const region of Object.keys(regions)) {
    const id = floatIdOfRegion(region)
    if (id !== null && !known.has(id)) fresh.push(id)
  }
  const floatOrder = fresh.length === 0 && alive.length === prev.floatOrder.length
    ? prev.floatOrder
    : [...alive, ...fresh]

  return { placements, shelves, floatOrder }
}

/** 投影前后一不一样。一样就不 set —— 一次无谓的 set 会让 Dock / 架子 / 浮窗全重渲。 */
export function sameProjection(
  a: ResidencyProjection,
  b: Pick<StageState, 'placements' | 'shelves' | 'floatOrder'>,
): boolean {
  if (!samePlacementTable(a.placements, b.placements)) return false
  if (a.floatOrder !== b.floatOrder && !sameIds(a.floatOrder, b.floatOrder)) return false
  for (const side of SHELF_SIDES) {
    const x = a.shelves[side]
    const y = b.shelves[side]
    if (!y) return false
    if (x.activeId !== y.activeId) return false
    if (!sameIds(x.tabs ?? [], y.tabs ?? [])) return false
    if (!sameIds(x.visible ?? [], y.visible ?? [])) return false
    if (x.thickness !== y.thickness || x.collapsed !== y.collapsed) return false
  }
  return true
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, at) => id === b[at])
}

function samePlacementTable(
  a: Record<string, Placement>,
  b: Record<string, Placement>,
): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  for (const key of keys) {
    const x = a[key]
    const y = b[key]
    if (!y || x.kind !== y.kind) return false
    if (x.kind === 'edge' && y.kind === 'edge' && x.side !== y.side) return false
  }
  return true
}
