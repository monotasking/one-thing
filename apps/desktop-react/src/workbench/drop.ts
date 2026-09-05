import { SHELF_SIDES, SNAP_BAND, TEAR_OFF_DISTANCE } from '../stage/transitions'
import { TAB_MIDDLE } from '../ui/drag/constants'
import type { ShelfSide } from '../stage/types'
import type { MessageKey } from '../i18n'
import type { RegionId } from './regions'

/**
 * **落点判据**(W6-b,设计 `apps/desktop-react/docs/workbench-tabs-2026-09.md` §5
 * 那张表;W3 的五区版被推翻)。
 *
 * 整只文件是**纯函数**:没有 React、没有 DOM、没有 store,而且**一个内容种类名
 * 都不出现**(grep `'file'` / `'panel'` / `'session'` / `'pair'` 在这只文件里零命中)。
 * 它只认四样:指针在哪、屏幕上有哪几块矩形、这次拖的东西**装了几份**、
 * 这次拖拽自己声明的那几条规矩。
 *
 * 「装了几份」是一个**数**(`slots`),不是「是不是两格标签」—— 判据认得出
 * 「这一格里有两份东西,所以它不能再并」,认不得 `pair` 这四个字母。同一条纪律
 * 让这只文件在下一种复合内容出现时一个字都不用改。
 *
 * ── 几何是「起拖时量一次」,不是逐帧量(裁定 4)────────────────────────────
 * 拖拽期间树不变(落定才改,`store.dragging` 那道闸保证),所以叶的矩形在整场
 * 拖拽里是常数。逐帧 `getBoundingClientRect()` 一次拖拽就是上百次强制排版 ——
 * 而它们答的是同一个数。宿主起拖时量一次、`resize` 时重量,判据这一头只读。
 *
 * ── 次序即语义(设计 v3 §5:「判定次序从上到下,先命中先赢」)────────────────
 *   ① **拒绝区**(红绿灯 / 顶栏尾格 / Dock)。它排第一,因为「这里不能放」是一句
 *      比任何落点都硬的话:红绿灯压在顶栏那条标签条的带里,先问条的话拖到关窗
 *      按钮上会变成「插到第 0 格」。
 *   ② **标签正中 44%** = 与它二合一。它优先于「标签之间」,两者共用同一条条 ——
 *      正中是它的中间那 44%,两侧各 28% 才是「落到它旁边」。
 *   ③ **标签之间** = 插到第 n 格。条只有 34px 高,谁也不会不小心把东西丢上去;
 *      反过来判(先问叶)会让条永远吸不到东西:条压在叶的上边带里。
 *   ④ **窗口边带**(`SNAP_BAND` 24)优先于叶。一片叶贴着窗口右缘时,右缘那 24px
 *      同时落在两者里;用户把东西拖到屏幕最边上,想的是「钉到那条边去」。
 *   ⑤ **内容区右带 28%** = 与活动标签并排(放右);
 *   ⑥ **左带 28%** = 并排(放左),**仅当活动标签还是一格**;
 *   ⑦ **内容区中间** = 末尾开成一格新标签;
 *   ⑧ **自己的内容区**(拖的就是这片叶的活动标签)= 放回,空动作;
 *   ⑨ 什么都没碰到 / 出了窗 = 撕成浮窗。
 *
 * ⑧ 在表上排在 ⑤⑥⑦ 后面(设计 §5 那张表的**阅读**顺序),但**判据里它必须先问**:
 * 「拖的是这片叶自己的活动标签」是对整片叶说的一句话,一旦成立,右带左带中间三格
 * 都是它 —— 排在后面就永远轮不到。出入记在交卷报里。
 *
 * ── 叶重叠时取最上 ──────────────────────────────────────────────────────
 * 浮窗会盖住中央区的叶。宿主按 DOM 序把矩形交进来(浮窗层排在主区之后),
 * 这里**从后往前**找第一个命中的 —— 屏幕上盖在最上面的那一片就是它。
 *
 * ── 退役(W6-b)──────────────────────────────────────────────────────────
 * `DropZone` / `zoneAt` / `zoneRectOf` / `ZONE_SPLIT` / `DROP_EDGE_PX` /
 * `DROP_BAR_PX` 与 `{kind:'leaf'}` 那一支整件删掉:**边带分屏没有了**
 * (单叶政策,设计 §2.1),叶的四带改判「二合一」与「开新标签」。设计册上
 * `--drop-edge` / `--drop-bar-w` 两格 token 留着当登记,判据这一头不再有读者。
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
 * 一条条上的一格标签。
 *
 * `slots` = 这一格里装了**几份**内容(1 或 2)。判据用它答两个问题:
 * 「拖着的这一格能不能再并」(`slots > 1` = 不能,设计 §6「不允许」)与
 * 「这片叶的活动标签还是不是一格」(左带只在它是一格时开,设计 §5)。
 * 它是个数不是种类名 —— 见文件头。
 */
export interface TabBox extends Rect {
  id: string
  slots: number
}

/**
 * 一条**标签条**此刻占的地方,连同它此刻那几格各自的矩形。
 *
 * 每一格的矩形都要带上,因为「插到第几格」问的是**指针越过了几条 tab 的中线**,
 * 而「落到哪一格头上」问的是它在不在某一格的正中 44% 里 —— 两件事都没有条自己的
 * 矩形回答得了。它们与叶的矩形一样是**起拖时量一次**的常数(拖拽期间树冻住),
 * 所以判据这一头照旧只读、不量。
 */
export interface StripBox {
  region: RegionId
  leafId: string
  rect: Rect
  /** 这条条里那几格,**按次序**。 */
  tabs: readonly TabBox[]
  /** 哪一格是活动的(`aria-selected`)。-1 = 一格都没有。 */
  activeAt: number
}

export interface DropGeometry {
  /** 窗口(视口)矩形。边带贴着它的四条边算。 */
  window: Rect
  /** 每一片叶,**按 DOM 序**(靠后 = 盖在上面)。 */
  leaves: readonly LeafBox[]
  /** 每一条标签条。缺席 = 这次拖拽不认标签条(与 W3 的行为逐字相同)。 */
  strips?: readonly StripBox[]
  /**
   * **这几块地方一律不收**(设计 v3 §5 第一行:红绿灯 / 顶栏尾格 / Dock)。
   *
   * 它是**一组矩形**而不是判据里的三个 if:那三处各自在 DOM 上自述一格
   * `data-nodrop`,量法照着扫一遍。于是「再多一处不能放的地方」= 在那个元素上
   * 加一格属性,这只文件一个字都不改(CLAUDE.md 那条「按能力枚举 → 能力自述」)。
   */
  nodrop?: readonly Rect[]
}

export type DropTarget =
  /** 落到某条条的第 `at` 格标签**正中** = 与那一格二合一。 */
  | { kind: 'pairTab'; region: RegionId; leafId: string; at: number }
  /** 落到某条标签条上,插到第 `at` 格(同叶 = 换序,异叶 = 搬过去)。 */
  | { kind: 'strip'; leafId: string; at: number }
  | { kind: 'edge'; side: ShelfSide }
  /** 与这片叶的活动标签并排,放在这一侧。 */
  | { kind: 'pair'; region: RegionId; leafId: string; side: 'left' | 'right' }
  /** 在这片叶的标签条**末尾**开成一格新标签。 */
  | { kind: 'open'; region: RegionId; leafId: string }
  /** 拖的就是这片叶的活动标签,松手 = 放回,空动作。 */
  | { kind: 'back' }
  | { kind: 'float' }
  | { kind: 'refuse'; reasonKey: MessageKey }

/**
 * **内容区左右各多宽算「与它并排」**(设计 v3 §4.1 `PAIR_BAND` 28%)。
 *
 * 它是**比例**不是像素,与 `TAB_MIDDLE` 同一条理由:内容区的宽从一扇 320px 的
 * 浮窗到一整块 1600px 的中央区都有,固定像素在两头各错一次。28 + 44 + 28 = 100
 * 也不是巧合 —— 标签上的「正中 / 两侧」与内容区的「中间 / 左右带」是同一张比例表,
 * 用户在两处学的是同一件事。
 */
export const PAIR_BAND = 0.28

/** 这次拖拽自己的规矩。全缺席 = 「什么都能落」。 */
export interface DropRules {
  /**
   * 拖的是**哪一格、装了几份**。判据只用它答两件事:
   * 「这一格是不是就是脚底下那一格」(是 = `back` / 不算 `pairTab` 的目标)、
   * 「它能不能再并」(`slots > 1` = 不能)。缺席 = 两条都不问。
   */
  dragged?: { id: string; slots: number }
  /**
   * **这几片叶这次不接**(设计 v3 §8:「从浮窗里拖东西出去时,浮窗自身矩形不再是
   * 落点 —— 拖的东西来自它,它不该接住自己;指针在窗内时按窗底下的那片叶判」)。
   *
   * 只挡**叶**,不挡它的**条**:条那一头是「插到第几格」,把一格标签在自己那扇
   * 浮窗的条上换个位子是天天要做的事,连它一起挡掉等于把换序也挡了。
   */
  excludeLeaves?: readonly string[]
  /**
   * 这个落点这次拖拽收不收。答一句 `MessageKey` = 拒绝的理由,答 null = 收。
   * **判据由来源自述**,这只文件因此不必认识任何一种内容。
   */
  accepts?(target: DropTarget): MessageKey | null
}

/** 「这里不能放」——拒绝区那一句。 */
const REFUSE_HERE: MessageKey = 'drag.refuseHere'
/** 「两格的标签不能再并」(设计 §6「不允许」)。 */
const REFUSE_PAIR_NEST: MessageKey = 'drag.refusePairNest'

/** 指针在这儿,松手会发生什么(次序见文件头)。 */
export function dropTargetAt(
  pointer: { x: number; y: number },
  geometry: DropGeometry,
  rules: DropRules = {},
): DropTarget {
  return judge(rawTargetAt(pointer, geometry, rules), rules)
}

function judge(target: DropTarget, rules: DropRules): DropTarget {
  if (target.kind === 'refuse') return target
  const reasonKey = rules.accepts?.(target) ?? null
  return reasonKey ? { kind: 'refuse', reasonKey } : target
}

function rawTargetAt(
  pointer: { x: number; y: number },
  geometry: DropGeometry,
  rules: DropRules,
): DropTarget {
  // ① 拒绝区:先命中先赢,而且赢得最硬。
  for (const rect of geometry.nodrop ?? []) {
    if (within(pointer, rect)) return { kind: 'refuse', reasonKey: REFUSE_HERE }
  }
  // ②③ 标签条(正中 = 二合一,其余 = 插到第几格)。
  const strip = stripAt(pointer, geometry.strips, rules)
  if (strip) return strip
  // ④ 窗口边带。
  const side = snapSideIn(pointer, geometry.window)
  if (side) return { kind: 'edge', side }
  // ⑤⑥⑦⑧ 内容区。从后往前 —— 宿主按 DOM 序交进来,靠后的盖在上面(见文件头)。
  for (let i = geometry.leaves.length - 1; i >= 0; i -= 1) {
    const box = geometry.leaves[i]
    if (rules.excludeLeaves?.includes(box.leafId)) continue
    if (!within(pointer, box.rect)) continue
    return leafTargetAt(pointer, box, geometry, rules)
  }
  // ⑨ 什么都没碰到 / 出了窗。
  return { kind: 'float' }
}

/**
 * 一片叶身上的四种落点(设计 v3 §5 的后四行)。
 *
 * 「这片叶的活动标签是谁」从**它那条条**上查(`activeAt`),不是从叶上 —— 中央区
 * 那条条住在窗口顶栏,DOM 上根本不在叶里(设计 v2 §2.2 的 D 稿),所以叶自己
 * 答不出这个问题。查不到条(比如一片还没画出檐的叶)= 只剩「开成新标签」那一档:
 * 没有 host 就没有「与谁并排」可言。
 */
function leafTargetAt(
  pointer: { x: number; y: number },
  box: LeafBox,
  geometry: DropGeometry,
  rules: DropRules,
): DropTarget {
  const strip = geometry.strips?.find((s) => s.leafId === box.leafId) ?? null
  const host = strip && strip.activeAt >= 0 ? (strip.tabs[strip.activeAt] ?? null) : null
  const open: DropTarget = { kind: 'open', region: box.region, leafId: box.leafId }
  if (!host) return open
  // ⑧ 拖的就是这片叶的活动标签 —— 整片叶都是「放回」(判据里它必须先问,见文件头)。
  if (rules.dragged && rules.dragged.id === host.id) return { kind: 'back' }
  const fx = box.rect.width > 0 ? (pointer.x - box.rect.left) / box.rect.width : 0.5
  const inBand = fx >= 1 - PAIR_BAND || (fx <= PAIR_BAND && host.slots === 1)
  // 两格的标签不能再并:两条并排带对它是拒绝,**中间那一格照旧收**
  // (把它整片叶都拒掉的话,一格两格标签就再也搬不进别的叶了)。
  if (inBand && (rules.dragged?.slots ?? 1) > 1) {
    return { kind: 'refuse', reasonKey: REFUSE_PAIR_NEST }
  }
  // ⑤ 右带。
  if (fx >= 1 - PAIR_BAND) return { kind: 'pair', region: box.region, leafId: box.leafId, side: 'right' }
  // ⑥ 左带,**仅当活动标签还是一格**(两格的话它已经满了,左边没地方放)。
  if (fx <= PAIR_BAND && host.slots === 1) {
    return { kind: 'pair', region: box.region, leafId: box.leafId, side: 'left' }
  }
  // ⑦ 中间。
  return open
}

/**
 * 哪一条标签条接得住这一点,以及落在它的哪儿。
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
  rules: DropRules,
): DropTarget | null {
  if (!strips) return null
  for (let i = strips.length - 1; i >= 0; i -= 1) {
    const box = strips[i]
    const r = box.rect
    if (pointer.x < r.left || pointer.x > r.left + r.width) continue
    if (pointer.y < r.top - TEAR_OFF_DISTANCE || pointer.y > r.top + r.height + TEAR_OFF_DISTANCE) {
      continue
    }
    const at = tabMiddleAt(pointer.x, box, rules.dragged?.id)
    if (at >= 0) {
      // 两格的标签不能再并(设计 §6「不允许」)—— 这里说得出理由,不是静默改判。
      if ((rules.dragged?.slots ?? 1) > 1) return { kind: 'refuse', reasonKey: REFUSE_PAIR_NEST }
      return { kind: 'pairTab', region: box.region, leafId: box.leafId, at }
    }
    return { kind: 'strip', leafId: box.leafId, at: stripIndexAt(pointer.x, box) }
  }
  return null
}

/**
 * 指针落在**哪一格的正中**(中间 `TAB_MIDDLE` 44%)。答 -1 = 没落在谁的正中。
 *
 * `skipId` 是被拖的那一格自己 —— 把一格标签拖到它自己头上不是一次并(设计 §2.3
 * 不变量 3 的前半句),它该落回「标签之间」那一档去。
 */
export function tabMiddleAt(x: number, box: StripBox, skipId?: string): number {
  const side = (1 - TAB_MIDDLE) / 2
  for (let i = 0; i < box.tabs.length; i += 1) {
    const tab = box.tabs[i]
    if (tab.width <= 0) continue
    if (skipId !== undefined && tab.id === skipId) continue
    if (x >= tab.left + tab.width * side && x <= tab.left + tab.width * (1 - side)) return i
  }
  return -1
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
 * **落下后占的那一半**(`pair` 那一档的高亮矩形)。
 *
 * 它按**当前分隔位**切吗?不 —— 切在正中。理由:并进去之后那条分隔杆落在缺省的
 * 50%(`PAIR_RATIO_DEFAULT`),所以「一半」说的就是它将来真的会占的地方;
 * 按 host 此刻的比例切会预示一个不会发生的布局。
 */
export function pairRectOf(rect: Rect, side: 'left' | 'right'): Rect {
  const half = rect.width / 2
  if (side === 'left') return { ...rect, width: half }
  return { left: rect.left + half, top: rect.top, width: half, height: rect.height }
}

/** 一条边带在窗口上的矩形(架子会长在这条带子那一侧,所以带子就是它的预示)。 */
export function edgeRectOf(win: Rect, side: ShelfSide, band: number = SNAP_BAND): Rect {
  if (side === 'left') return { ...win, width: band }
  if (side === 'right') return { left: win.left + win.width - band, top: win.top, width: band, height: win.height }
  if (side === 'top') return { ...win, height: band }
  return { left: win.left, top: win.top + win.height - band, width: win.width, height: band }
}

/**
 * 一个落点该把高亮画在哪儿。答 null = 这一帧没有可指的地方。
 *
 * 三处**故意不答矩形**:标签条那两档(`strip` / `pairTab`)的预示是条自己腾出来的
 * 一格空位与那一格上的一圈(`ui/tab-reorder`),`back` 什么都不画(设计 §5:
 * 「不画」),`float` 那扇窗的轮廓要问形态机的 `floatRectForGrab`(不属于这只纯
 * 函数的知识范围)。两样一起画就是同一件事说两遍,而这一批治的正是「说三遍」。
 */
export function targetRectOf(target: DropTarget, geometry: DropGeometry): Rect | null {
  if (target.kind === 'edge') return edgeRectOf(geometry.window, target.side)
  if (target.kind === 'open') return leafRectOf(target.leafId, target.region, geometry)
  if (target.kind === 'pair') {
    const rect = leafRectOf(target.leafId, target.region, geometry)
    return rect ? pairRectOf(rect, target.side) : null
  }
  return null
}

function leafRectOf(leafId: string, region: RegionId, geometry: DropGeometry): Rect | null {
  return (
    geometry.leaves.find((leaf) => leaf.leafId === leafId && leaf.region === region)?.rect ?? null
  )
}

/**
 * **能放的地方有哪几块**(设计 v3 §5 贯穿规则 1 的氛围层)。
 *
 * 三类,一张表:每片叶的身子、每条标签条、窗口四条边带。它**不问指针在哪**
 * —— 氛围是「起拖那一刻」铺一次的底,整场不变(所以宿主也只算一次);
 * 「悬到的那一处亮到实」由 `targetRectOf` 那一块盖在上面完成。
 *
 * 被 `excludeLeaves` 挡掉的叶不进这张表:说「这里能放」而松手落不进去,比不说更糟。
 */
export function ambientRectsOf(geometry: DropGeometry, rules: DropRules = {}): Rect[] {
  const out: Rect[] = []
  for (const leaf of geometry.leaves) {
    if (rules.excludeLeaves?.includes(leaf.leafId)) continue
    out.push(leaf.rect)
  }
  for (const strip of geometry.strips ?? []) out.push(strip.rect)
  for (const side of SHELF_SIDES) out.push(edgeRectOf(geometry.window, side))
  return out
}
