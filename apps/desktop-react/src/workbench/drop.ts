import { SHELF_SIDES, SNAP_BAND } from '../stage/transitions'
import type { ShelfSide } from '../stage/types'
import type { MessageKey } from '../i18n'
import type { RegionId } from './regions'

/**
 * **落点判据**(W3,设计 `apps/desktop-react/docs/workbench-2026-09.md` §3.1)。
 *
 * 整只文件是**纯函数**:没有 React、没有 DOM、没有 store,而且**一个内容种类名
 * 都不出现**(grep `'file'` / `'panel'` / `'session'` 在这只文件里零命中)。
 * 它只认三样:指针在哪、屏幕上有哪几块矩形、这次拖拽自己声明的两条规矩。
 *
 * ── 几何是「起拖时量一次」,不是逐帧量(裁定 4)────────────────────────────
 * 拖拽期间树不变(落定才改,`store.dragging` 那道闸保证),所以叶的矩形在整场
 * 拖拽里是常数。逐帧 `getBoundingClientRect()` 一次拖拽就是上百次强制排版 ——
 * 而它们答的是同一个数。宿主起拖时量一次、`resize` 时重量,判据这一头只读。
 *
 * ── 次序即语义:窗口边带**优先于**叶的四带 ───────────────────────────────
 * 一片叶贴着窗口右缘时,右缘那 24px 同时落在「这片叶的东带」与「窗口的右边带」
 * 里。先问边带:用户把东西拖到屏幕最边上,想的是「钉到那条边去」,不是
 * 「在最右边那片叶里再切一刀」。反过来判会让右架子永远吸不到东西。
 *
 * ── 叶重叠时取最上 ──────────────────────────────────────────────────────
 * 浮窗会盖住中央区的叶。宿主按 DOM 序把矩形交进来(浮窗层排在主区之后),
 * 这里**从后往前**找第一个命中的 —— 屏幕上盖在最上面的那一片就是它。
 */

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

/** 一片叶此刻占的地方。`region` 由宿主从它所在那棵树的容器上读。 */
export interface LeafBox {
  region: RegionId
  leafId: string
  rect: Rect
}

export interface DropGeometry {
  /** 窗口(视口)矩形。边带贴着它的四条边算。 */
  window: Rect
  /** 每一片叶,**按 DOM 序**(靠后 = 盖在上面)。 */
  leaves: readonly LeafBox[]
}

export type DropZone = 'center' | 'n' | 's' | 'e' | 'w'

export type DropTarget =
  | { kind: 'leaf'; region: RegionId; leafId: string; zone: DropZone }
  | { kind: 'edge'; side: ShelfSide }
  | { kind: 'float' }
  | { kind: 'refuse'; reasonKey: MessageKey }

/**
 * 中心区是**内缩这么多的矩形**(设计 §3.1)。
 *
 * **只有这一个产地**,CSS 那边没有对应的变量 —— 派工令的 token 清单里列过一格
 * `--drop-inset: 25%`,施工时发现它**没有读者**:高亮的矩形不是 CSS 算的,是
 * `zoneRectOf` 算好之后由宿主整块递过去的(`ui/drag/DropOverlay` 消费
 * `ui/float` 的 `cover` 档,身量就是那块矩形)。两处各存一份同一个数,迟早分叉;
 * 而「高亮盖的就是判据用的那一块」这句话正是本批要保证的东西。所以那一格变量
 * 没有落地,出入记在交卷报告里。
 */
export const DROP_CENTER_INSET = 0.25

/** 这次拖拽自己的两条规矩。都缺席 = 「什么都能落,四带都开」。 */
export interface DropRules {
  /**
   * 分不分屏。`false` = 叶上只有中心区一格(四带不开)—— 会话行走的正是这一档:
   * 它落到中央只是「切换当前会话」,切一刀出来放什么都没有(裁定 7)。
   */
  split?: boolean
  /**
   * 这个落点这次拖拽收不收。答一句 `MessageKey` = 拒绝的理由,答 null = 收。
   * **判据由来源自述**,这只文件因此不必认识任何一种内容(裁定 7 的机械化)。
   */
  accepts?(target: DropTarget): MessageKey | null
}

/**
 * 指针在这儿,松手会发生什么。
 *
 * 四问,按序:
 *  ① 窗口四条**边带**(`SNAP_BAND` 24,判据复用形态机既有的 `snapSideAt`);
 *  ② 指针底下**最上面**那一片叶 → 中心区 / 四带;
 *  ③ 什么都没碰到 → 撕成浮窗;
 *  ④ 上面得到的那个落点交给 `rules.accepts` 复核,被拒就换成 `refuse`。
 */
export function dropTargetAt(
  pointer: { x: number; y: number },
  geometry: DropGeometry,
  rules: DropRules = {},
): DropTarget {
  return judge(rawTargetAt(pointer, geometry, rules.split !== false), rules)
}

function judge(target: DropTarget, rules: DropRules): DropTarget {
  if (target.kind === 'refuse') return target
  const reasonKey = rules.accepts?.(target) ?? null
  return reasonKey ? { kind: 'refuse', reasonKey } : target
}

function rawTargetAt(
  pointer: { x: number; y: number },
  geometry: DropGeometry,
  split: boolean,
): DropTarget {
  const side = snapSideIn(pointer, geometry.window)
  if (side) return { kind: 'edge', side }
  /*
   * 从后往前 —— 宿主按 DOM 序交进来,靠后的盖在上面(见文件头)。
   */
  for (let i = geometry.leaves.length - 1; i >= 0; i -= 1) {
    const box = geometry.leaves[i]
    if (!within(pointer, box.rect)) continue
    return {
      kind: 'leaf',
      region: box.region,
      leafId: box.leafId,
      zone: split ? zoneAt(pointer, box.rect) : 'center',
    }
  }
  return { kind: 'float' }
}

/**
 * 边带:复用形态机那只 `snapSideAt`(裁定 3「三处三个名字」的另一半 —— 这里
 * 一个新常数都不造)。它是按**视口**算的,而门与用例里窗口矩形未必从 0 起,
 * 所以先把指针折回视口坐标系再问。
 */
function snapSideIn(pointer: { x: number; y: number }, win: Rect): ShelfSide | null {
  const local = { x: pointer.x - win.left, y: pointer.y - win.top }
  if (local.x < 0 || local.y < 0 || local.x > win.width || local.y > win.height) return null
  let best: ShelfSide | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const side of SHELF_SIDES) {
    const d = edgeDistance(side, local, win)
    if (d > SNAP_BAND) continue
    // 严格小于才换人 —— 平手优先左右,与 `snapSideAt` 逐字同一条(竖架子是主力形态)。
    if (d < bestDistance) {
      best = side
      bestDistance = d
    }
  }
  return best
}

function edgeDistance(side: ShelfSide, p: { x: number; y: number }, win: Rect): number {
  if (side === 'left') return p.x
  if (side === 'right') return win.width - p.x
  if (side === 'top') return p.y
  return win.height - p.y
}

function within(p: { x: number; y: number }, r: Rect): boolean {
  return p.x >= r.left && p.x <= r.left + r.width && p.y >= r.top && p.y <= r.top + r.height
}

/**
 * 指针落在这片叶的哪一区。
 *
 * 中心 = 内缩 25% 的矩形(**闭区间**:指针正好压在 25% 那条线上算中心 ——
 * 四带是「其余」,而「其余」不含边界。判据得有一头是闭的,否则线上那一像素
 * 谁都不认领)。四带按指针离哪条边最近判,平手时**优先左右**(与 `snapSideAt`
 * 那条判例同向:竖着切是主力)。
 */
export function zoneAt(pointer: { x: number; y: number }, rect: Rect): DropZone {
  const inset = DROP_CENTER_INSET
  const dx = rect.width * inset
  const dy = rect.height * inset
  const inCenterX = pointer.x >= rect.left + dx && pointer.x <= rect.left + rect.width - dx
  const inCenterY = pointer.y >= rect.top + dy && pointer.y <= rect.top + rect.height - dy
  if (inCenterX && inCenterY) return 'center'
  const west = pointer.x - rect.left
  const east = rect.left + rect.width - pointer.x
  const north = pointer.y - rect.top
  const south = rect.top + rect.height - pointer.y
  const min = Math.min(west, east, north, south)
  if (west === min) return 'w'
  if (east === min) return 'e'
  if (north === min) return 'n'
  return 's'
}

/** 一片叶里某一区的矩形 —— **高亮画的就是它**(见 `DROP_CENTER_INSET` 的判词)。 */
export function zoneRectOf(rect: Rect, zone: DropZone): Rect {
  if (zone === 'center') return rect
  const halfW = rect.width / 2
  const halfH = rect.height / 2
  if (zone === 'w') return { ...rect, width: halfW }
  if (zone === 'e') return { left: rect.left + halfW, top: rect.top, width: halfW, height: rect.height }
  if (zone === 'n') return { ...rect, height: halfH }
  return { left: rect.left, top: rect.top + halfH, width: rect.width, height: halfH }
}

/** 一条边带在窗口上的矩形(架子会长在这条带子那一侧,所以带子就是它的预示)。 */
export function edgeRectOf(win: Rect, side: ShelfSide, band: number = SNAP_BAND): Rect {
  if (side === 'left') return { ...win, width: band }
  if (side === 'right') return { left: win.left + win.width - band, top: win.top, width: band, height: win.height }
  if (side === 'top') return { ...win, height: band }
  return { left: win.left, top: win.top + win.height - band, width: win.width, height: band }
}

/**
 * 一个落点该把高亮画在哪儿。答 null = 这一帧没有可指的地方(撕浮窗那一形由
 * 宿主自己给一块窗子轮廓 —— 那块矩形要问形态机的 `floatRectForGrab`,不属于
 * 这只纯函数的知识范围)。
 */
export function targetRectOf(target: DropTarget, geometry: DropGeometry): Rect | null {
  if (target.kind === 'edge') return edgeRectOf(geometry.window, target.side)
  if (target.kind === 'leaf') {
    const box = geometry.leaves.find(
      (leaf) => leaf.leafId === target.leafId && leaf.region === target.region,
    )
    return box ? zoneRectOf(box.rect, target.zone) : null
  }
  return null
}

/** 四带各自切出来的方向。**一张表**,不是四处 if(与 `SPLIT_CHOICES` 同一条纪律)。 */
export const ZONE_SPLIT: Readonly<
  Record<Exclude<DropZone, 'center'>, { dir: 'row' | 'col'; before: boolean }>
> = {
  w: { dir: 'row', before: true },
  e: { dir: 'row', before: false },
  n: { dir: 'col', before: true },
  s: { dir: 'col', before: false },
}
