import { SHELF_SIDES, TEAR_OFF_DISTANCE } from '../stage/transitions'
import type { ShelfSide } from '../stage/types'
import type { MessageKey } from '../i18n'
import type { RegionId } from './regions'

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
 * ── 次序即语义(先命中先赢)────────────────────────────────────────────
 *   ① **拒绝区**(红绿灯 / 顶栏尾格 / Dock)。它排第一,因为「这里不能放」是一句
 *      比任何落点都硬的话:红绿灯压在顶栏那条标签条的带里,先问条的话拖到关窗
 *      按钮上会变成「插到第 0 格」。
 *   ② **标签条** = 插到第 n 格。**外来来源落到标签上一律是「插到旁边」**
 *      (U1;「落到某一格正中 = 与它二合一」那一档整件退役,判词见下)。
 *      条只有 34px 高,谁也不会不小心把东西丢上去;反过来判(先问叶)会让条永远
 *      吸不到东西:条压在叶的上边带里。
 *   ③ **新架子那条窄边带**(`NEW_SHELF_BAND` 12),**而且只对那一边还没有架子时
 *      成立**。它优先于叶:一片叶贴着窗口右缘时,右缘那一条同时落在两者里,而
 *      用户把东西拖到屏幕最边上想的是「在那边生一条架子出来」。那一边已经有架子
 *      了就没有这句话可说 —— 那条边上此刻站着的是架子自己的条与身子,该落进去的
 *      是它们(用户报的「莫名钉边」就是这一格:左边明明开着文件架子,手一靠边
 *      却被判成「钉成左侧架子」)。
 *   ④ **内容区右带 28%** = 与活动标签并排(放右);
 *   ⑤ **左带 28%** = 并排(放左),**仅当活动标签还是一格**;
 *   ⑥ **内容区中间** = 末尾开成一格新标签;
 *   ⑦ **自己的内容区**(拖的就是这片叶的活动标签)= 放回,空动作;
 *   ⑧ 什么都没碰到 / 出了窗 = 撕成浮窗。
 *
 * ⑦ 在设计表上排在 ④⑤⑥ 后面(那张表的**阅读**顺序),但**判据里它必须先问**:
 * 「拖的是这片叶自己的活动标签」是对整片叶说的一句话,一旦成立,右带左带中间三格
 * 都是它 —— 排在后面就永远轮不到。出入记在交卷报里。
 *
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
 * 它是**比例**不是像素:内容区的宽从一扇 320px 的浮窗到一整块 1600px 的中央区
 * 都有,固定像素在两头各错一次。
 *
 * **U1 起它是这套比例表唯一剩下的那一格**:从前它与标签上的 `TAB_MIDDLE` 44%
 * 凑成 28 + 44 + 28 = 100(「用户在两处学的是同一件事」),而标签上那一档随
 * `pairTab` 一起退役 —— 今天条上只有一种落点,没有第二条线要对齐。
 */
export const PAIR_BAND = 0.28

/**
 * **「在这条边上生一条架子」那条带有多宽**(U1,12)。
 *
 * ── 它为什么是一个新常数,不是 `SNAP_BAND` ──────────────────────────────
 * `SNAP_BAND`(24,`stage/transitions.ts`)是**形态机**的数:拖着一扇**浮窗**
 * 靠视口边多近算「要钉上去」,进 24 出 24 一进一出对称。这一个是**落点判据**
 * 的数:从外面拖一样东西过来时,离窗口边多近算「我要的不是那片叶,是在这条边上
 * 生一条新架子」。两者今天都住在「离某条边多远」这句话里,但它们的用户反馈来自
 * 完全不同的场合 —— 合成一个常量以后调「吸边灵不灵」会连带改掉「手一靠边会不会
 * 误钉」,而后者正是 U1 要治的那条报障。
 *
 * ── 为什么从 24 收到 12 ─────────────────────────────────────────────────
 * 24px 的四条边带排在叶之前,于是**任何**一次贴边经过都会被判成「钉边」:用户
 * 把文件往聊天区右边缘拖的时候,最后那 24px 里屏幕上说的是「钉到右侧架子」而不是
 * 「与 X 并排」—— 而右带 28% 的目的地恰恰在那儿。12 是「明确贴到边上」那一档,
 * 它比一次拖拽的收尾抖动(3~6px)大得多,又不至于把整条右带的末梢吃掉。
 * 它同时**只对那一边还没有架子时成立**(文件头 ③),两条一起才治得住「莫名钉边」。
 */
export const NEW_SHELF_BAND = 12

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
/** 「两格的标签不能再并」(设计 §6「不允许」)。 */
const REFUSE_PAIR_NEST: MessageKey = 'drag.refusePairNest'

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
  // ② 标签条(插到第几格)。
  const strip = stripAt(pointer, geometry.strips, live)
  if (strip) return strip
  // ③ 新架子那条窄边带 —— 只对**还没有架子**的那一边成立。
  const side = newShelfSideIn(pointer, geometry)
  if (side) return { kind: 'edge', side }
  // ④⑤⑥⑦ 内容区。从后往前 —— 宿主按 DOM 序交进来,靠后的盖在上面(见文件头)。
  for (let i = geometry.leaves.length - 1; i >= 0; i -= 1) {
    const box = geometry.leaves[i]
    if (rules.excludeLeaves?.includes(box.leafId)) continue
    if (!within(pointer, box.rect)) continue
    return leafTargetAt(pointer, box, geometry, rules)
  }
  // ⑧ 什么都没碰到 / 出了窗。
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
  // ⑦ 拖的就是这片叶的活动标签 —— 整片叶都是「放回」(判据里它必须先问,见文件头)。
  if (rules.dragged && rules.dragged.id === host.id) return { kind: 'back' }
  const fx = box.rect.width > 0 ? (pointer.x - box.rect.left) / box.rect.width : 0.5
  const inBand = fx >= 1 - PAIR_BAND || (fx <= PAIR_BAND && host.slots === 1)
  // 两格的标签不能再并:两条并排带对它是拒绝,**中间那一格照旧收**
  // (把它整片叶都拒掉的话,一格两格标签就再也搬不进别的叶了)。
  if (inBand && (rules.dragged?.slots ?? 1) > 1) {
    return { kind: 'refuse', reasonKey: REFUSE_PAIR_NEST }
  }
  // ④ 右带。
  if (fx >= 1 - PAIR_BAND) return { kind: 'pair', region: box.region, leafId: box.leafId, side: 'right' }
  // ⑤ 左带,**仅当活动标签还是一格**(两格的话它已经满了,左边没地方放)。
  if (fx <= PAIR_BAND && host.slots === 1) {
    return { kind: 'pair', region: box.region, leafId: box.leafId, side: 'left' }
  }
  // ⑥ 中间。
  return open
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
 * 两条判据缺一不可(见文件头 ③):**离边不到 `NEW_SHELF_BAND`**,而且**那条边上
 * 此刻还没有架子**。它按**视口**算,而门与用例里窗口矩形未必从 0 起,所以先把
 * 指针折回视口坐标系再问。
 */
function newShelfSideIn(pointer: { x: number; y: number }, geometry: DropGeometry): ShelfSide | null {
  const win = geometry.window
  const local = { x: pointer.x - win.left, y: pointer.y - win.top }
  if (local.x < 0 || local.y < 0 || local.x > win.width || local.y > win.height) return null
  let best: ShelfSide | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const side of SHELF_SIDES) {
    if (geometry.shelves.includes(side)) continue
    const d = edgeDistance(side, local, win)
    if (d > NEW_SHELF_BAND) continue
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

/**
 * 一条边带在窗口上的矩形(架子会长在这条带子那一侧,所以带子就是它的预示)。
 *
 * `band` **没有缺省值**(U1):这只函数从前默认 `SNAP_BAND` 24,而判据那一头
 * 已经换成 `NEW_SHELF_BAND` 12 —— 一个没人传的缺省一旦与判据不是同一个数,
 * 屏幕上画的膜就比真正收东西的那条带宽一倍,而那种错只在真机上看得见。
 */
export function edgeRectOf(win: Rect, side: ShelfSide, band: number): Rect {
  if (side === 'left') return { ...win, width: band }
  if (side === 'right') return { left: win.left + win.width - band, top: win.top, width: band, height: win.height }
  if (side === 'top') return { ...win, height: band }
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
  if (target.kind === 'edge') return edgeRectOf(geometry.window, target.side, NEW_SHELF_BAND)
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
