import { SHELF_SIDES, SNAP_BAND, TEAR_OFF_DISTANCE } from '../stage/transitions'
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
 * ── 次序即语义(W3-b 裁定 6 起是**四问**)────────────────────────────────
 *   ① **标签条**优先于一切。它是这套形态里唯一「指着一个下标」的落点,而条本身
 *      只有 34px 高 —— 谁也不会不小心把东西丢到一条 34px 的带子上。反过来判
 *      (先问叶)会让条永远吸不到东西:条压在叶的上边带里。
 *   ② **窗口边带**优先于叶的四带。一片叶贴着窗口右缘时,右缘那 24px 同时落在
 *      「这片叶的东带」与「窗口的右边带」里。用户把东西拖到屏幕最边上,想的是
 *      「钉到那条边去」,不是「在最右边那片叶里再切一刀」。反过来判会让右架子
 *      永远吸不到东西。
 *   ③ 叶的四条**边带**(`DROP_EDGE_PX` 16)= 在那一侧分屏。
 *   ④ 叶身其余部分 = **并入这片叶**。
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

/**
 * 一条**标签条**此刻占的地方,连同它此刻那几格各自的矩形(W3-b 裁定 6)。
 *
 * 每一格的矩形都要带上,因为「插到第几格」问的是**指针越过了几条 tab 的中线**,
 * 而那件事没有条自己的矩形回答得了。它们与叶的矩形一样是**起拖时量一次**的常数
 * (拖拽期间树冻住),所以判据这一头照旧只读、不量。
 */
export interface StripBox {
  leafId: string
  rect: Rect
  /** 这条条里那几格,**按次序**。 */
  tabs: readonly Rect[]
}

export interface DropGeometry {
  /** 窗口(视口)矩形。边带贴着它的四条边算。 */
  window: Rect
  /** 每一片叶,**按 DOM 序**(靠后 = 盖在上面)。 */
  leaves: readonly LeafBox[]
  /** 每一条标签条。缺席 = 这次拖拽不认标签条(与 W3 的行为逐字相同)。 */
  strips?: readonly StripBox[]
}

export type DropZone = 'center' | 'n' | 's' | 'e' | 'w'

export type DropTarget =
  /** 落到某片叶身上:`center` = 并入,四带 = 在那一侧分屏。 */
  | { kind: 'leaf'; region: RegionId; leafId: string; zone: DropZone }
  /** 落到某条标签条上,插到第 `at` 格(同叶 = 换序,异叶 = 搬过去)。 */
  | { kind: 'strip'; leafId: string; at: number }
  | { kind: 'edge'; side: ShelfSide }
  | { kind: 'float' }
  | { kind: 'refuse'; reasonKey: MessageKey }

/**
 * **叶的四条边带有多宽**(W3-b 裁定 6;09-05 用户选甲)。
 *
 * W3 那时是反过来的:中心区**内缩 25%**,其余全是分屏 —— 于是一片叶上有一多半
 * 面积会切一刀。用户的原话:「中心区只有内缩后的一小块,大半面积都是分屏」。
 * 甲把它倒过来:**整个叶身都是并入**,只有贴边那 16px 是分屏。误分屏因此从
 * 「一多半概率」变成「必须故意去够那条边」,而分屏本来就是低频动作。
 *
 * 16 与 `SNAP_BAND`(24,窗口边带)刻意**不相等**:它们量的是两条不同的边
 * (叶的边 / 窗口的边),而且窗口边带优先 —— 两个数相等会让「这一格是被哪条带
 * 接住的」在读代码时不再看得出来(裁定 3「三处三个名字」的同一条纪律)。
 *
 * 设计册上的登记是 `--drop-edge`,两边由 `__tests__/drop-tokens.test.ts` 钉成相等。
 */
export const DROP_EDGE_PX = 16

/**
 * 分屏预示那根杠有多厚(`--drop-bar-w` 的判据镜像)。
 *
 * 它必须住在判据这一头而不是只在 CSS 里,因为**高亮盖的就是判据算的那块矩形**
 * (`zoneRectOf`)—— 让 CSS 用 `min-width` 去撑那 4px 的话,东带那根杠会从叶的
 * 右缘往**外**长 4px,当场违反「高亮不撑破叶」(`gate:squeeze` 真机量着这一条)。
 */
export const DROP_BAR_PX = 4

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
 * 五问,按序(见文件头「次序即语义」):
 *  ① 哪一条**标签条**接得住(条的上下各外扩 `TEAR_OFF_DISTANCE`)→ 插到第几格;
 *  ② 窗口四条**边带**(`SNAP_BAND` 24,判据复用形态机既有的 `snapSideAt`);
 *  ③ 指针底下**最上面**那一片叶 → 四条 16px 的边带 / 其余全是叶身;
 *  ④ 什么都没碰到 → 撕成浮窗;
 *  ⑤ 上面得到的那个落点交给 `rules.accepts` 复核,被拒就换成 `refuse`。
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
  const strip = stripAt(pointer, geometry.strips)
  if (strip) return strip
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
 * 哪一条标签条接得住这一点。
 *
 * **带**的口径与「条内换序」那一头逐字相同(`TEAR_OFF_DISTANCE` 24 的上下外扩,
 * 判词在 `DragSession.DragBandState` 上):拖到自己那条条的带里是换序,拖到别人
 * 那条条的带里就该是「插到那条条的第几格」—— 同一句话,两个方向。横向**不外扩**:
 * 条的矩形本来就铺满那片叶的整段跨度,末格右边那一大片空白已经在条里了。
 *
 * 条重叠时(浮窗盖着中央叶)取**最后交进来的那一条** —— 与叶那一头同一条纪律:
 * 宿主按 DOM 序交,靠后 = 盖在上面。
 */
function stripAt(
  pointer: { x: number; y: number },
  strips: readonly StripBox[] | undefined,
): DropTarget | null {
  if (!strips) return null
  for (let i = strips.length - 1; i >= 0; i -= 1) {
    const box = strips[i]
    const r = box.rect
    if (pointer.x < r.left || pointer.x > r.left + r.width) continue
    if (pointer.y < r.top - TEAR_OFF_DISTANCE || pointer.y > r.top + r.height + TEAR_OFF_DISTANCE) {
      continue
    }
    return { kind: 'strip', leafId: box.leafId, at: stripIndexAt(pointer.x, box) }
  }
  return null
}

/**
 * 插到第几格 = 指针越过了几条 tab 的**中线**。
 *
 * 量的是**起拖时**那份几何,不是此刻的 DOM —— 落一个空位进去会把后面那几格往右
 * 推,而用推完之后的矩形再判一次,下标就会自己晃回来(空位收掉 → 下标变回去 →
 * 空位又插到别处),一帧一次来回。这是同一条判例在条上的第二格:
 * `ui/tab-reorder.track()` 用的也是起手量的那份。
 */
export function stripIndexAt(x: number, box: StripBox): number {
  let at = 0
  for (const tab of box.tabs) {
    if (x > tab.left + tab.width / 2) at += 1
  }
  return at
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
 * 指针落在这片叶的哪一区(W3-b 裁定 6:**整个叶身都是并入,只有贴边那 16px 分屏**)。
 *
 * 边带是**开区间**、中心是闭的:指针正好压在离边 16px 那条线上算 `center` ——
 * 判据得有一头是闭的,否则线上那一像素谁都不认领。这与 W3 的口径一字不差,
 * 换的只是「哪一边是『其余』」。
 *
 * 四条带在小叶上会互相重叠(一片 20px 高的叶上下带撞在一起),所以次序即答案:
 * 西 → 东 → 北 → 南,**平手优先左右**(与 `snapSideAt` 那条判例同向:竖着切是主力)。
 */
export function zoneAt(pointer: { x: number; y: number }, rect: Rect): DropZone {
  if (pointer.x - rect.left < DROP_EDGE_PX) return 'w'
  if (rect.left + rect.width - pointer.x < DROP_EDGE_PX) return 'e'
  if (pointer.y - rect.top < DROP_EDGE_PX) return 'n'
  if (rect.top + rect.height - pointer.y < DROP_EDGE_PX) return 's'
  return 'center'
}

/**
 * 一片叶里某一区的**高亮矩形** —— 高亮画的就是它(裁定 7)。
 *
 * `center` → 整片叶(`ring` 档在它里面描一圈细环);四带 → **贴着那条边的一根
 * `DROP_BAR_PX` 厚的杠**(`bar` 档),不再是「落下后占的那一半」。
 *
 * 改这一句的理由是用户看真机后的原话:落点反馈太重。画出那一半等于提前把屏幕
 * 改了一遍,而分屏这件事本来只需要说清楚「往哪边切」——一根杠说得完。
 * **杠永远在叶里**(左/上贴内缘、右/下往里收一个杠厚),所以「高亮不撑破叶」
 * 这句话在几何上成立,不靠 CSS 兜。
 */
export function zoneRectOf(rect: Rect, zone: DropZone): Rect {
  if (zone === 'center') return rect
  const bar = Math.min(DROP_BAR_PX, rect.width, rect.height)
  if (zone === 'w') return { ...rect, width: bar }
  if (zone === 'e') {
    return { left: rect.left + rect.width - bar, top: rect.top, width: bar, height: rect.height }
  }
  if (zone === 'n') return { ...rect, height: bar }
  return { left: rect.left, top: rect.top + rect.height - bar, width: rect.width, height: bar }
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
  /*
   * 标签条那一档**故意不答矩形**:它的预示是那条条自己腾出来的一格空位
   * (`ui/tab-reorder.gap()`),不是盖一块高亮。两样一起画就是同一件事说两遍,
   * 而这一批治的正是「说三遍」。
   */
  if (target.kind === 'strip') return null
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
