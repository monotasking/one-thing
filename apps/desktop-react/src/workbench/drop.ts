import { SHELF_SIDES, TEAR_OFF_DISTANCE } from '../stage/transitions'
import type { ShelfSide } from '../stage/types'
import type { MessageKey } from '../i18n'
import type { RegionId } from './regions'
import type { SplitSide } from './tree'

/**
 * **落点判据**(W6-b 立;U1 / 2026-09-08 按用户拍板的拖拽 v4 改了三处,设计
 * `apps/desktop-react/docs/workbench-tabs-2026-09.md` §5 那张表随后另立单更新)。
 *
 * 整只文件是**纯函数**:没有 React、没有 DOM、没有 store,而且**一个内容种类名
 * 都不出现**(grep `'file'` / `'panel'` / `'session'` / `'pair'` 在这只文件里零命中)。
 * 它只认五样:指针在哪、屏幕上有哪几块矩形、此刻活布局与那份基准差了什么、
 * 这次拖的东西**装了几份**、这次拖拽自己声明的那几条规矩。
 *
 * 「装了几份」是一个**数**(`slots`),不是「是不是两格标签」—— 判据认得出
 * 「这一格里有两份东西,所以它不能再并」,认不得 `pair` 这四个字母。同一条纪律
 * 让这只文件在下一种复合内容出现时一个字都不用改。
 *
 * ── 几何是「起拖时量一次」,活布局的位移**算出来**不量(裁定 4 + U1)────────
 * 拖拽期间树不变(落定才改,`store.dragging` 那道闸保证),所以叶的矩形在整场
 * 拖拽里是常数。逐帧 `getBoundingClientRect()` 一次拖拽就是上百次强制排版 ——
 * 而它们答的是同一个数。宿主起拖时量一次、`resize` 时重量,判据这一头只读。
 *
 * 唯一在拖拽期间真的会动的是**那一格空位**:它一插进去,它右边那几格标签就整体
 * 右移一个空位宽。U1 之前判据一律按基准量,于是屏幕上的格与判据心里的格差一格宽
 * —— 用户看到指针明明压在第 2 格上,读数却说「放到第 3 位」。修法**不是**改回
 * 逐帧量 DOM(那是把强制排版请回来,而且读到的是正在过渡中的位置),是把那一格
 * 位移当成**一格入参**(`DropLive.gap`)算进去:活位置 = 基准矩形 + 空位位移。
 *
 * ── 次序即语义(先命中先赢)——09-24 用户令重写 ────────────────────────────
 * 用户原话:「窗口不再支持 top 架子,从窗口的角度分为三个加载,分别是左右下;架子的空间
 * 占窗口的 30% 左右(无架子时),中间没有涉及到的区域为浮窗区;有架子时,允许上下左右分屏
 * (30% 拖拽区域),如果有铺满只能通过放在 tab 上」,随后补「主区域也能分屏」。
 *   ① **拒绝区**(红绿灯 / 顶栏尾格 / Dock)。
 *   ② **标签条** = 插到第 n 格。**要「铺满」(并进一片叶)只有这一条路。**
 *   ③ **浮窗里的叶**:浮窗盖在一切之上,它身上的分屏带先于身子底下那条边的架子带。
 *   ④ **新架子带**:还没有架子的左 / 右 / 下三条边,各占窗口那条轴的 30%
 *      (`NEW_SHELF_ZONE`)。它先于中央区的叶 —— 没有架子时中央区铺满整扇窗,它的
 *      左右下 30% 与架子带完全重合,让叶先问就再也拖不出一条架子。
 *   ⑤ **任意一片叶的四边 30%**(`SPLIT_BAND`,按叶自己的宽高算)= 在那一侧分屏。
 *   ⑥ **自己那片叶**(拖的就是它唯一那格,或指针在它中间)= 放回,空动作。
 *   ⑦ 其余一切(叶的中间、出了窗、什么都没碰到)= 撕成浮窗。
 *
 * 「叶中间 = 追加成一格标签」与「左右 28% = 与活动标签并排」两档随这次重写退役:
 * 前者被 ② 接走(用户说铺满只走 tab),后者被 ⑤ 的分屏取代。`pair` / `open` 两种
 * 落点**类型**留着 —— 会话行右键菜单「在右侧打开」那几条是直接点名它们落定的,
 * 只是拖拽判据不再产生它们。

 * ── 叶重叠时取最上 ──────────────────────────────────────────────────────
 * 浮窗会盖住中央区的叶。宿主按 DOM 序把矩形交进来(浮窗层排在主区之后),
 * 这里**从后往前**找第一个命中的 —— 屏幕上盖在最上面的那一片就是它。
 *
 * ── 退役 ────────────────────────────────────────────────────────────────
 * W6-b:`DropZone` / `zoneAt` / `zoneRectOf` / `ZONE_SPLIT` / `DROP_EDGE_PX` /
 * `DROP_BAR_PX` 与 `{kind:'leaf'}` 那一支整件删掉(边带分屏没有了)。
 *
 * U1(2026-09-08,用户真机报障「从会话行拖到顶栏标签正中闪烁」):
 *  · **`pairTab` 那一档整件删掉**,连同 `tabMiddleAt` 与它读的 `TAB_MIDDLE` 44%。
 *    病历:外来来源落到同一条条上有两种落点交替 —— 正中 44% 是描圈、两侧各 28%
 *    是空位;每过一次 28% 线,宿主就 `clearGap()` 删掉占位再 `insertBefore` 一个
 *    新的(宽度从 0 起动画),右侧标签整排跳一格宽。真机 MutationObserver 读数:
 *    三个来回 18 次 DOM 变动。**它不是画法问题,是这条条上根本不该有两种落点**
 *    ——「把一格标签压到另一格上 = 二合一」是**条内**那一形的手势(手已经压到条
 *    的下面了,`useTabDrag` 的 onto 带),从外面拖一样东西过来时用户要的只有一件
 *    事:插到哪儿。二合一从外面走的是**内容区左右带**那两档。
 *  · **`ambientRectsOf` 整件删掉**(设计 §5 贯穿规则 1 的氛围层)。用户原话是
 *    「一拖整窗变色」:所有能放的地方各铺 6% 的主题色,屏幕上同时亮五六块,读成
 *    的不是「这些地方能放」而是「出问题了」。今天只画**这一帧真的会落进去的
 *    那一处**。
 *  · `SNAP_BAND`(24)不再是这只文件的读者 —— 边带的宽换成了 `NEW_SHELF_BAND`。
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
 * 而条自己的矩形答不了。它们与叶的矩形一样是**起拖时量一次**的常数(拖拽期间树
 * 冻住),所以判据这一头照旧只读、不量;活布局与它差的那一格空位由 `DropLive.gap`
 * 补上(见文件头)。
 */
export interface StripBox {
  region: RegionId
  leafId: string
  rect: Rect
  /** 这条条里那几格,**按次序**。 */
  tabs: readonly TabBox[]
  /** 哪一格是活动的(`aria-selected`)。-1 = 一格都没有。 */
  activeAt: number
  /**
   * 这条条画的是**内容自带的头**(`ContentKind.stripHeader`),那唯一一格就是头自己。
   * 判据不看它 —— 落点、插到第几格照旧;看它的只有「怎么画预示」:标签那一档的预示是
   * 条腾出来的一格空位,而头上没有格可腾,所以那一档改画一层薄膜(`useContentDrag`)。
   */
  header?: boolean
}

export interface DropGeometry {
  /** 窗口(视口)矩形。边带贴着它的四条边算。 */
  window: Rect
  /** 每一片叶,**按 DOM 序**(靠后 = 盖在上面)。 */
  leaves: readonly LeafBox[]
  /**
   * **此刻哪几条边上已经有架子了**(含收起成细梁的那一形 —— 它仍旧站在那条边上)。
   *
   * 判据只拿它答一句话:那条边的 12px 窄带还成不成立(见文件头 ③)。它是**一张
   * 表**而不是四个布尔,理由与 `nodrop` 同源:边有哪几条是 `ShelfSide` 自己的事,
   * 这只文件不必为每一条各开一格。
   *
   * 它**不是可选的**:漏交一次就等于「四条边都没有架子」,而那正好是用户报的
   * 「莫名钉边」——一格静默的缺省会把这条判据变回它治的那个病。
   */
  shelves: readonly ShelfSide[]
  /** 每一条标签条。缺席 = 这次拖拽不认标签条(与 W3 的行为逐字相同)。 */
  strips?: readonly StripBox[]
  /**
   * **这几块地方一律不收**(红绿灯 / 顶栏尾格 / Dock)。
   *
   * 它是**一组矩形**而不是判据里的三个 if:那三处各自在 DOM 上自述一格
   * `data-nodrop`,量法照着扫一遍。于是「再多一处不能放的地方」= 在那个元素上
   * 加一格属性,这只文件一个字都不改(CLAUDE.md 那条「按能力枚举 → 能力自述」)。
   */
  nodrop?: readonly Rect[]
}

export type DropTarget =
  /** 落到某条标签条上,插到第 `at` 格(同叶 = 换序,异叶 = 搬过去)。 */
  | { kind: 'strip'; leafId: string; at: number }
  | { kind: 'edge'; side: ShelfSide }
  /** 在这片叶的 `side` 那一侧切出一片新叶装它(09-24,拖拽的四边分屏带)。 */
  | { kind: 'split'; region: RegionId; leafId: string; side: SplitSide }
  /** 与这片叶的活动标签并排,放在这一侧。**拖拽不再产生**,只给菜单直接点名。 */
  | { kind: 'pair'; region: RegionId; leafId: string; side: 'left' | 'right' }
  /** 在这片叶的标签条**末尾**开成一格新标签。**拖拽不再产生**,只给菜单直接点名。 */
  | { kind: 'open'; region: RegionId; leafId: string }
  /** 拖的就是这片叶的活动标签,松手 = 放回,空动作。 */
  | { kind: 'back' }
  | { kind: 'float' }
  | { kind: 'refuse'; reasonKey: MessageKey }

/**
 * **新架子带占窗口那条轴的多少**(09-24,30%)。左右两条按窗宽算,底边按窗高算。
 *
 * 它同时是**预示的大小**:落下之后那条新架子开出来就是这么厚(`stage/transitions`
 * 的 `newShelfThickness` 读同一个数),所以拖拽时那块膜画的就是架子将来占的地方。
 */
export const NEW_SHELF_ZONE = 0.3

/**
 * **一片叶四边各多宽算「在这一侧分屏」**(09-24,30%)。按叶**自己**的宽高算 —— 叶
 * 从一扇 320px 的浮窗到一整块中央区都有,固定像素在两头各错一次。
 */
export const SPLIT_BAND = 0.3

/** 这次拖拽自己的规矩。全缺席 = 「什么都能落」。 */
export interface DropRules {
  /**
   * 拖的是**哪一格、装了几份**。判据只用它答两件事:
   * 「这一格是不是就是脚底下那一格」(是 = `back`)、「它能不能再并」
   * (`slots > 1` = 不能)。缺席 = 两条都不问。
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

/**
 * **此刻活布局与那份基准差了什么**(U1)。今天只差一样:某条条上开着的那一格空位。
 *
 * 它是**入参**不是量出来的:宿主自己画的那格空位,宽多少、插在第几格,只有宿主
 * 知道,而它知道得比 DOM 早一帧(那一格还在跑宽度过渡)。判据拿这两个数就能把
 * 活位置算出来 —— 一次 `getBoundingClientRect` 都不必有。
 */
export interface DropLive {
  /**
   * `leafId` 那条条上,第 `at` 格之前开着一格 `width` 宽的空位。
   * 别的条不受影响(空位只有一格,它在哪条条上是宿主说的)。
   */
  gap?: { leafId: string; at: number; width: number }
}

/** 「这里不能放」——拒绝区那一句。 */
const REFUSE_HERE: MessageKey = 'drag.refuseHere'

/** 指针在这儿,松手会发生什么(次序见文件头)。 */
export function dropTargetAt(
  pointer: { x: number; y: number },
  geometry: DropGeometry,
  rules: DropRules = {},
  live: DropLive = {},
): DropTarget {
  return judge(rawTargetAt(pointer, geometry, rules, live), rules)
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
  live: DropLive,
): DropTarget {
  // ① 拒绝区:先命中先赢,而且赢得最硬。
  for (const rect of geometry.nodrop ?? []) {
    if (within(pointer, rect)) return { kind: 'refuse', reasonKey: REFUSE_HERE }
  }
  // ② 标签条(插到第几格)—— 「铺满」唯一的路。
  const strip = stripAt(pointer, geometry.strips, live)
  if (strip) return strip
  // ③ 浮窗里的叶:盖在架子带之上。
  const floating = leafAt(pointer, geometry, rules, (box) => isFloatRegion(box.region))
  if (floating) return leafTargetAt(pointer, floating, geometry, rules)
  // ④ 新架子带 —— 只对**还没有架子**的那一边成立。
  const side = newShelfSideIn(pointer, geometry)
  if (side) return { kind: 'edge', side }
  // ⑤⑥⑦ 其余的叶(中央区、架子)。
  const box = leafAt(pointer, geometry, rules, (b) => !isFloatRegion(b.region))
  if (box) return leafTargetAt(pointer, box, geometry, rules)
  // ⑦ 什么都没碰到 / 出了窗。
  return { kind: 'float' }
}

function isFloatRegion(region: RegionId): boolean {
  return region.startsWith('float:')
}

/** 指针下最上面那片叶(宿主按 DOM 序交进来,靠后的盖在上面 —— 所以从后往前找)。 */
function leafAt(
  pointer: { x: number; y: number },
  geometry: DropGeometry,
  rules: DropRules,
  accept: (box: LeafBox) => boolean,
): LeafBox | null {
  for (let i = geometry.leaves.length - 1; i >= 0; i -= 1) {
    const box = geometry.leaves[i]
    if (rules.excludeLeaves?.includes(box.leafId)) continue
    if (!accept(box) || !within(pointer, box.rect)) continue
    return box
  }
  return null
}

/**
 * 一片叶身上的落点:四边分屏带 / 放回 / 浮窗。
 *
 * 「拖的是不是这片叶自己的东西」从**它那条条**上查(`activeAt` 与格数):拖的是它
 * **唯一**那一格 → 整片叶都是放回(从自己身上切一刀出来,切完原叶是空的,那一刀没有
 * 意义);拖的是它的活动格、而它还有别的格 → 四边照样能分屏(把这一格拆到旁边去看),
 * 只有中间是放回。
 */
function leafTargetAt(
  pointer: { x: number; y: number },
  box: LeafBox,
  geometry: DropGeometry,
  rules: DropRules,
): DropTarget {
  const strip = geometry.strips?.find((s) => s.leafId === box.leafId) ?? null
  const host = strip && strip.activeAt >= 0 ? (strip.tabs[strip.activeAt] ?? null) : null
  const own = !!rules.dragged && !!host && rules.dragged.id === host.id
  // ⑥ 拖的是这片叶唯一那一格:整片叶都是放回。
  if (own && (strip?.tabs.length ?? 0) <= 1) return { kind: 'back' }
  // ⑤ 四边分屏带。
  const side = splitSideAt(pointer, box.rect)
  if (side) return { kind: 'split', region: box.region, leafId: box.leafId, side }
  // ⑥ 自己那片叶的中间 = 放回;别人那片叶的中间 = 浮窗区。
  return own ? { kind: 'back' } : { kind: 'float' }
}

/**
 * 指针落在这块矩形哪一侧的分屏带里(没有 = null)。四条带在角上重叠时,取**离得最近**
 * 的那一侧 —— 距离按那一侧自己那条轴归一(宽的叶上 30% 是一大段,扁的叶上是一小段,
 * 按像素比会让扁叶永远只剩上下两条)。平手优先左右(竖切是主力形态,与架子那条同)。
 */
export function splitSideAt(pointer: { x: number; y: number }, rect: Rect): SplitSide | null {
  if (rect.width <= 0 || rect.height <= 0) return null
  const fx = (pointer.x - rect.left) / rect.width
  const fy = (pointer.y - rect.top) / rect.height
  const candidates: [SplitSide, number][] = [
    ['left', fx],
    ['right', 1 - fx],
    ['top', fy],
    ['bottom', 1 - fy],
  ]
  let best: SplitSide | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const [side, d] of candidates) {
    if (d > SPLIT_BAND) continue
    if (d < bestDistance) {
      best = side
      bestDistance = d
    }
  }
  return best
}

/**
 * 哪一条标签条接得住这一点,以及插到它的第几格。
 *
 * **带**的口径与「条内换序」那一头逐字相同(`TEAR_OFF_DISTANCE` 24 的上下外扩,
 * 判词在 `DragSession.DragBandState` 上):拖到自己那条条的带里是换序,拖到别人
 * 那条条的带里就该是「插到那条条的第几格」—— 同一句话,两个方向。横向**不外扩**:
 * 条的矩形止于它自己的右缘,而末格右边那一片空白**由量法负责铺进来**
 * (`drop-geometry` 把顶栏那一组的右缘铺到顶栏标签带的右缘 —— 那片空白就是
 * 「插到末尾」,用户报的「顶栏末格右边空白不能放」正是它从前不在条里)。
 *
 * 条重叠时(浮窗盖着中央叶)取**最后交进来的那一条** —— 与叶那一头同一条纪律:
 * 宿主按 DOM 序交,靠后 = 盖在上面。
 */
function stripAt(
  pointer: { x: number; y: number },
  strips: readonly StripBox[] | undefined,
  live: DropLive,
): DropTarget | null {
  if (!strips) return null
  /*
   * ── **落在条上的赢过只是够得着的**(W7-c)────────────────────────────────
   * 上面那 24px 的上下外扩是「瞄准附近也算」;它**永远不许赢过一条指针真的落在
   * 上面的条**。两者从前不分先后,因为屏幕上不可能有两条条挨这么近 —— W7-c 裁定 1
   * 把顶栏标签改成从红绿灯右边起排之后,它与**左架子那条条**横向重叠了(从前顶栏
   * 那一组坐在中央叶的正上方,而中央叶在架子右边),而架子那条条的 24px 外扩正好
   * 够到顶栏里:于是指针明明在顶栏第 0 格上,判据交回的是「插进左架子第 1 位」。
   *
   * 修法不是把外扩改小(那是拿一个魔法数去躲另一个),是把这句话写成**两遍扫描**:
   * 先找真的含住这一点的,没有再找够得着的。两遍都按 DOM 逆序(条重叠时靠后的
   * 盖在上面 —— 那条纪律一个字没变)。
   */
  const box = scanStrips(pointer, strips, 0) ?? scanStrips(pointer, strips, TEAR_OFF_DISTANCE)
  if (!box) return null
  // 空位只在它自己那条条上算数(别的条上那几格一个像素都没动过)。
  const gap = live.gap && live.gap.leafId === box.leafId ? live.gap : undefined
  return { kind: 'strip', leafId: box.leafId, at: stripIndexAt(pointer.x, box, gap) }
}

/**
 * 一遍扫描:哪条条在**这个上下容差**里接得住这一点。DOM 逆序 —— 条重叠时
 * 靠后的盖在上面(宿主按 DOM 序交,那条纪律与叶那一头同源)。
 */
function scanStrips(
  pointer: { x: number; y: number },
  strips: readonly StripBox[],
  slack: number,
): StripBox | null {
  for (let i = strips.length - 1; i >= 0; i -= 1) {
    const box = strips[i]
    const r = box.rect
    if (pointer.x < r.left || pointer.x > r.left + r.width) continue
    if (pointer.y < r.top - slack || pointer.y > r.top + r.height + slack) continue
    return box
  }
  return null
}

/**
 * 插到第几格 = 指针越过了几条 tab 的**中线**。
 *
 * ── 量的是**活位置**,而活位置是算出来的不是量出来的(U1)────────────────
 * `box.tabs` 是起拖时量的那份基准;此刻屏幕上,空位左边那几格一动没动,空位
 * **右边(下标 ≥ `gap.at`)那几格整体右移了一个空位宽**。所以活中线 =
 * 基准中线 + (i ≥ gap.at ? gap.width : 0),一次 `getBoundingClientRect` 都不必有
 * —— 而且读到的不是正在跑过渡的中间态,是它停稳之后的位置。
 *
 * ── 这条判据**自稳**(旧判词说反了,这里改成事实)────────────────────────
 * 从前这儿写着「用活矩形会来回晃:落一个空位进去会把后面那几格往右推,用推完之后
 * 的矩形再判一次,下标就会自己晃回来」。那句话说的是**逐帧重量 DOM** 那一版,
 * 而按位移算这一版在数学上就晃不起来:
 *
 *   记 n₀ = 基准中线在指针左边的格数,n₁ = 基准中线 + 空位宽 仍在指针左边的格数
 *   (n₁ ≤ n₀)。把上一帧的 `at` 代进来,这只函数交出的正是 **clamp(at, n₁, n₀)**
 *   —— 一个把 `at` 夹进区间的算子。夹一次就在区间里了,**再夹一次原值不动**
 *   (幂等),所以同一个 x 上连着算多少次都是同一个数,不可能一帧一次来回。
 *   n₀ 与 n₁ 都随 x 单调不减,所以指针一路往右走 `at` 只增不减,往左走只减不增
 *   —— 中间那一段的「不动」就是浏览器标签条上那点顺手的迟滞:空位左边的格没动过,
 *   空位右边的中线永远在指针右侧。
 *
 * 反证在 `__tests__/drop.test.ts`「空位位移下的下标自稳」:把 `shift` 那一句挖掉
 * (退回基准),同一趟扫描当场出现「屏幕上压在第 2 格、读数说第 3 位」的一格错位。
 *
 * 不给 `gap` = 条上没有空位(第一帧、或落点不在任何条上)= 与基准逐字相同。
 */
export function stripIndexAt(
  x: number,
  box: StripBox,
  gap?: { at: number; width: number },
): number {
  let at = 0
  for (let i = 0; i < box.tabs.length; i += 1) {
    const tab = box.tabs[i]
    const shift = gap && i >= gap.at ? gap.width : 0
    if (x > tab.left + shift + tab.width / 2) at += 1
  }
  return at
}

/**
 * 「在这条边上生一条新架子」的那一边,没有就答 null。
 *
 * 两条判据缺一不可(见文件头 ④):**离边不到那条轴的 `NEW_SHELF_ZONE`**,而且**那条边上
 * 此刻还没有架子**。角上两条带重叠时取归一距离更近的那条(平手优先左右)。它按**视口**
 * 算,而门与用例里窗口矩形未必从 0 起,所以先把指针折回视口坐标系再问。
 */
function newShelfSideIn(pointer: { x: number; y: number }, geometry: DropGeometry): ShelfSide | null {
  const win = geometry.window
  const local = { x: pointer.x - win.left, y: pointer.y - win.top }
  if (local.x < 0 || local.y < 0 || local.x > win.width || local.y > win.height) return null
  let best: ShelfSide | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const side of SHELF_SIDES) {
    if (geometry.shelves.includes(side)) continue
    const zone = newShelfZoneOf(side, win)
    if (zone <= 0) continue
    const d = edgeDistance(side, local, win) / zone
    if (d > 1) continue
    if (d < bestDistance) {
      best = side
      bestDistance = d
    }
  }
  return best
}

/** 新架子带在这条边上有多厚(px)。 */
export function newShelfZoneOf(side: ShelfSide, win: Rect): number {
  return (side === 'bottom' ? win.height : win.width) * NEW_SHELF_ZONE
}

function edgeDistance(side: ShelfSide, p: { x: number; y: number }, win: Rect): number {
  if (side === 'left') return p.x
  if (side === 'right') return win.width - p.x
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

/**
 * **分屏落下后新叶占的那一半**(`split` 那一档的高亮)。切在正中 —— 新切出来的那一刀
 * 落在缺省比例(`tree.DEFAULT_SPLIT_RATIO` 50%),所以「一半」就是它将来真占的地方。
 */
export function splitRectOf(rect: Rect, side: SplitSide): Rect {
  const halfW = rect.width / 2
  const halfH = rect.height / 2
  if (side === 'left') return { ...rect, width: halfW }
  if (side === 'right') return { ...rect, left: rect.left + halfW, width: halfW }
  if (side === 'top') return { ...rect, height: halfH }
  return { ...rect, top: rect.top + halfH, height: halfH }
}

/**
 * 一条边带在窗口上的矩形(架子会长在这条带子那一侧,所以带子就是它的预示)。
 *
 * `band` **没有缺省值**(U1):一个没人传的缺省一旦与判据不是同一个数,屏幕上画的膜
 * 就与真正收东西的那条带不一样宽,而那种错只在真机上看得见。今天它由
 * `newShelfZoneOf` 给(判据与预示同一个数)。
 */
export function edgeRectOf(win: Rect, side: ShelfSide, band: number): Rect {
  if (side === 'left') return { ...win, width: band }
  if (side === 'right') return { left: win.left + win.width - band, top: win.top, width: band, height: win.height }
  return { left: win.left, top: win.top + win.height - band, width: win.width, height: band }
}

/**
 * 一个落点该把高亮画在哪儿。答 null = 这一帧没有可指的地方。
 *
 * 三处**故意不答矩形**:标签条那一档(`strip`)的预示是条自己腾出来的一格空位
 * (`ui/tab-reorder`),`back` 什么都不画(设计 §5:「不画」),`float` 那扇窗的
 * 轮廓要问形态机的 `floatRectForGrab`(不属于这只纯函数的知识范围)。两样一起画
 * 就是同一件事说两遍,而这一批治的正是「说三遍」。
 */
export function targetRectOf(target: DropTarget, geometry: DropGeometry): Rect | null {
  if (target.kind === 'edge') {
    return edgeRectOf(geometry.window, target.side, newShelfZoneOf(target.side, geometry.window))
  }
  if (target.kind === 'split') {
    const rect = leafRectOf(target.leafId, target.region, geometry)
    return rect ? splitRectOf(rect, target.side) : null
  }
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
