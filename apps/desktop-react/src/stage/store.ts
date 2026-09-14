import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { focusTree } from '../focus/registry'
import { useWorkbenchStore } from '../workbench/store'
import { STAGE_ITEMS, findItem } from './items'
import { panelRef } from './panel-ref'
import { refId, residencyLevelOf } from '../workbench/kinds'
import {
  LAYER_SCOPE_OF,
  requestFocusOnOpen,
  summonFromSituation,
  summonSituationOfRef,
  summonTransition,
  type SummonAction,
  type SummonIntent,
  type SummonWhere,
} from './summon'
import { seatOfRefIn, type RefSeat } from '../workbench/tree'
import { activateScopeAfterCommit } from '../focus/after-commit'
import * as T from './transitions'
import * as P from './placement'
import { foldLegacyStageFurniture, stashLegacyStageResidency } from './legacy-furniture'
import { nextLeafId } from '../workbench/ids'
import { floatIdOfRegion, projectResidency, sameProjection } from './residency'
import type { ContentRef, ContentRefId } from '../workbench/kinds'
import type { RegionId } from '../workbench/regions'
import type { FocusScopeId } from '../focus/types'
import { t, type Locale } from '../i18n'
import { announce } from '../ui/a11y/live-region'
import {
  spreadSpace,
  stashSpace,
  type PerSpaceSpec,
  type PerSpaceState,
} from '../workspace/per-space'
import type {
  DockAlign,
  DockDisplay,
  DockEdge,
  DockMagnifyLevel,
  DockSize,
  FloatRect,
  Placement,
  PlacementTarget,
  ResolvedOpen,
  ShelfRail,
  ShelfSide,
  StageItemSpec,
  StageSettings,
  StageState,
  Viewport,
} from './types'

interface StageStore extends StageState, StageSettings, PerSpaceState<T.StageFurniture> {
  items: StageItemSpec[]
  dockDisplay: DockDisplay
  /**
   * **收起来的架子还画不画那条细梁把手**(2026-09-12 用户拍)。一格全局偏好,
   * 四条边共用;判词全文在 `types.ts` 的 `ShelfRail` 上。缺省 `'shown'`。
   */
  shelfRail: ShelfRail

  /** 落点由 resolveOpen 解析(记忆 > 全局默认档);要点名落点的走 openAs。 */
  clickDockIcon: (id: string) => void
  /**
   * 显式手势那一层:点名放到哪儿。它既执行也写记忆(记忆在 `placement.placeAs` 里落)。
   * **收得下全屏那一档**(W2):那一支落定后由这里派给拼贴台的 `enterFull`。
   */
  openAs: (id: string, placement: PlacementTarget) => void
  /**
   * **把任意一块内容摆到某个区域**(W4 立的 `placement.placeRefIn`,W3 起有了
   * 第一个消费者:拖拽落定)。
   *
   * 与 `openAs` 的分工:那一口说的是**瓦**的形态语言(`Placement`,连带位置
   * 记忆与闪烁),这一口说的是**内容**的区域语言(`RegionId`)—— 而它按
   * `panelIdOf(ref) !== null` 自己分派,所以拖拽那一头不必枚举内容种类。
   *
   * 它必须是一格 store 动作而不是直接调那只纯编排:一次落定要同时改**树**与
   * **形态机**,而 `orchestrate` 那格缓冲(判词在它自己头上)保证订阅者看到的
   * 是一次干净的 A → B。绕开它,`stage/focus-follow` 的差分判据会把一次落定
   * 读成好几拍(真机门 `gate:focus` 场景 11 / 15 的病历)。
   */
  placeRef: (ref: ContentRef, region: RegionId, opts?: { rect?: FloatRect; activate?: boolean }) => void
  /**
   * **召唤**一块面(S1,设计 §14)。键盘 `toggle:<面>` 命令的**唯一**落点:
   * 没开就开、看不见就露出来、看得见没聚焦就只聚焦、焦点已在里面就收起来。
   * 四态判据在纯函数 `summon.summonTransition` 里,这里只是它的分流器。
   *
   * 从前旁边还站着一口 `toggleItem`(纯开关,`transitions.togglePlacement`)——
   * S1 把键盘那条路改走召唤之后它就零消费者了(Dock 瓦点击走的一直是
   * `clickDockIcon`),09-04 S2 用户裁定删掉:一个没人叫的开口迟早被下一个人
   * 当成「另一种打开方式」叫起来,那时这台壳就有两种打开语义了。
   */
  summonItem: (id: string) => void
  /**
   * **召唤一格内容**(W7-p 裁定 6)。同一台四态机器,换一种对象:瓦问形态机,
   * 内容问拼贴树(两个适配器都在 `stage/summon.ts`,判据一份)。
   *
   * 答**它此刻在哪一形**;`null` = 哪棵树上都没有它 —— 那时这一下什么都没做,
   * 该怎么开由调用方说了算(启动瓦按它自己那句 `open()`,会话按「顶替焦点那片
   * 会话叶」)。把「开」留在外面而不是在这里补一格 `open` 动作,是因为**开一格
   * 内容的规矩不属于形态机**:它是那格内容自己的事(目录瓦要先解析目录、会话要
   * 原位换 ref),形态机只认得住处。
   *
   * `intent` 见 `summon.SummonIntent`:Dock 瓦 / 快捷键是 `toggle`(按到底会收起),
   * sidebar 单击一条已经开着的会话是 `reveal`(只去,不收)。
   */
  summonRef: (ref: ContentRef, intent?: SummonIntent) => SummonWhere['kind'] | null
  closeToDock: (id: string) => void
  closeStage: () => void
  /**
   * Esc 退一层。返回**这一下有没有接住** —— 宿主要据此决定要不要
   * preventDefault(没接住就不该拦,后面还有别的层在等这一下)。
   */
  escapeTopmost: () => boolean
  stageToFloat: () => void
  stageToEdge: (side: ShelfSide) => void
  floatToEdge: (id: string, side: ShelfSide) => void
  edgeToFloat: (id: string) => void
  focusFloat: (id: string) => void
  /**
   * **给一扇还没有身量的窗补一份默认矩形**(W4)。
   *
   * 浮窗的几何(`floats[id]`)归形态机,而「开一扇装着文件的新窗」这件事发起在
   * 内容那一侧(`content/viewer/open-target.ts`)—— 那一侧铸得出窗号,却不该
   * 自己去编一个矩形(默认身量、视口钳制两件事的产地都在这里)。
   * **已经有身量的不动**:它是记忆,收起来再开还在老位置。
   */
  ensureFloatRect: (id: string) => void
  moveFloat: (id: string, x: number, y: number) => void
  resizeFloat: (id: string, rect: FloatRect) => void
  /**
   * 视口变了之后把所有浮窗矩形重钳一遍(09-04 §4)。参数是视口而不是「自己去量」——
   * 与别的动作同一条纪律:store 是 transitions 的壳,量视口的活在宿主那一侧。
   * 一格都没动时 `reclampAll` 交回同一个对象,zustand 于是连订阅都不推。
   */
  reclampFloats: (viewport: Viewport) => void
  activateShelfTab: (side: ShelfSide, id: string) => void
  toggleShelfCollapsed: (side: ShelfSide) => void
  /**
   * **让一个区域看得见**:边 → 展开那条架子,浮窗 → 置顶那扇窗,中央区 → 空动作。
   * 「往一个区域里放了东西,顺手让它露脸」这句话的唯一产地(判词在
   * `placement.revealRegionIn`);文件按打开方式落点、拖拽落定两条路都调它。
   */
  revealRegion: (region: RegionId) => void
  closeShelf: (side: ShelfSide) => void
  /**
   * **关一扇浮窗**(W4,设计 §2.2)= 把里面的 tab 全部**隐藏**,不是关闭。
   * 窗子没了,内容还在隐藏表里,「隐藏的标签 ⋯」点得回来 —— 与「收回 Dock
   * 不丢状态」同一条判据,只是这一条对**文件**也说得通(文件没有 Dock 可回)。
   */
  closeFloat: (id: string) => void
  setShelfThickness: (side: ShelfSide, thickness: number) => void
  setDockDisplay: (d: DockDisplay) => void
  /** 收起后画不画细梁把手。三处入口(细梁右键 / 架子 ⋯ 菜单 / 设置页)调的都是这一只。 */
  setShelfRail: (r: ShelfRail) => void
  setDockEdge: (e: DockEdge) => void
  setDockAlign: (a: DockAlign) => void
  setDockSize: (z: DockSize) => void
  /** 磁性放大的三格(对齐 macOS Dock 偏好:放大开关 / 放大幅度 / 运行指示灯)。 */
  setDockMagnify: (on: boolean) => void
  setDockMagnifyLevel: (level: DockMagnifyLevel) => void
  setDockRunningDot: (on: boolean) => void
  setDefaultOpen: (d: ResolvedOpen) => void
  setLocale: (l: Locale) => void
  /** 「所有应用」那块管理瓦上的一行开关:这块瓦在 Dock 上露不露面。 */
  setItemHidden: (id: string, hidden: boolean) => void
}

/**
 * 家具账的规格 —— 摘什么、出厂是什么,两句话都在 transitions 里(纯函数),
 * 这里只把它们扎成一束递给原语。**全仓唯一一处** stage 的 per-space 规格。
 *
 * 形参写 `StageStore` 而不是 `StageState`,纯为让推断落在 store 这一边;
 * `pickStageFurniture` 自己只吃 `StageState`(它不该认识 store),而「吃父类型的
 * 函数可以当吃子类型的函数用」——所以它原样装得进这一格。
 */
export const STAGE_PER_SPACE: PerSpaceSpec<StageStore, T.StageFurniture> = {
  pick: T.pickStageFurniture,
  factory: T.factoryStageFurniture,
  /**
   * **全局瓦携带,几何这一半**(S1,dock-scope §2.4 那张表的 stage 一行)。
   *
   * 拼贴台那一侧搬的是「它在哪棵树、哪片叶」;这一侧搬的是「那扇窗多大、
   * 排在第几、上次是怎么打开的」。两侧各自在自己的 `carry` 里做,`layout-scope`
   * 的次序一个字不动(workbench 换装 → stage 换装 → `syncStageResidency` 重算投影)。
   *
   * 判据是**这块瓦的 `panelRef` 的 level**,经 `kinds.residencyLevelOf` 问 ——
   * 于是 stage 这一层同样不点名任何一块瓦。`floats` / `memory` 的键有两种来路:
   * 一块瓦浮出来时窗 id **就是**瓦 id(判词在 `residency.regionOfPlacement` 上),
   * 别的内容浮出来时是现铸的窗号 —— 后者在瓦表上查无此人,`panel` 那一种的
   * `level` 自述答 `space`,不搬,正确。
   */
  carry: (incoming, outgoing) =>
    T.carryStageFurniture(
      incoming,
      T.pickStageFurniture(outgoing),
      (id) => residencyLevelOf(panelRef(id)) === 'app',
    ),
}

/**
 * 视口是宿主的事实,不是形态机的 —— transitions 一行都不许读 window,
 * 所以「当下多大」在这里量一次递进去。
 */
export function viewport(): Viewport {
  return { w: window.innerWidth, h: window.innerHeight }
}

/**
 * **住处那一族动作递进去的两台机器**(W4)。`stage/placement.ts` 要同时改
 * 树(住处)与这台 store(几何 + 记忆),所以它收一个端口对象而不是自己
 * import 这个 store —— 那会是一条 `store → placement → store` 的环,
 * 而这台壳里那条 `stage/store → stage/items → stage/types → i18n → stage/store`
 * 的存量环已经证明过:模块作用域里去够另一个模块的导出会当场 TDZ 崩溃。
 *
 * 三口都是**惰性**的(箭头函数体里才够 `useStageStore`),所以它写在模块作用域
 * 也不会在求值期去碰一个还没建出来的 store。
 *
 * 导出是给**用例**的:它们要拿同一份端口去驱动那些编排动作,而不是各造一份
 * ——两份端口迟早在「视口从哪儿量」这一格上分叉。
 */
/**
 * **一句编排 = 这台 store 的一次 `set`**(W4;真机门 `gate:focus` 的场景 11 / 15
 * 把这一条逼出来的)。
 *
 * ── 病历 ────────────────────────────────────────────────────────────────
 * 第一版是「跑完再对一次账」:编排里每一句 `patchStage` 各 `set` 一次,树那一头
 * 又经订阅再 `set` 一次。于是**一次落定在订阅者眼里裂成了好几拍**,而
 * `stage/focus-follow.ts` 的判据恰恰是**前后两份 `placements` 的差**:
 * 「拼舞台」在它眼里先变成「files 从表里没了」(树那一拍),再变成「files 从
 * 无到有」(瞬态那一拍)—— 后者落进第一档「从 dock 出来 = 打开,只有键盘点了名
 * 才跟」,于是规则 3(挪到哪焦点跟到哪)整条不响。真机读数:场景 11 三步全红,
 * 焦点留在 composer 上。
 *
 * ── 修法 ────────────────────────────────────────────────────────────────
 * 编排期间把 `patchStage` **攒进一格缓冲**,树那一头的投影**先不写**;编排结束
 * 时按「缓冲 + 树」算一次投影,**一次 `set` 全写下去**。于是订阅者看到的永远是
 * 一次干净的 A → B,与 W4 之前那句 `set(transitions.openAs(...))` 逐字同型。
 *
 * `deps.stage()` 在编排期间读的是「store + 缓冲」——不这么读的话,同一句编排里
 * 后面那几步会看不见前面那几步写的东西(`rememberLanding` 要读刚补的浮窗矩形)。
 *
 * 嵌套是**恒等**的:`placeAs` 里会调 `closeToDock`,而两者都从 store 那一层进来
 * 过 —— 内层看见缓冲已经开着就直接跑,不另起一次。
 */
let buffer: P.StagePatch | null = null

/**
 * 编排交回 `fn` 的返回值(W2)—— 那是**落定的外溢结果**
 * (`P.PlacementOutcome`:今天只有「去铺全屏」这一档)。落地必须排在收笔**之后**:
 * 全屏那一格住在拼贴台那本账上,而这一句编排还没把投影写下去。
 */
function orchestrate<T>(fn: () => T): T {
  if (buffer) {
    return fn()
  }
  buffer = {}
  try {
    return fn()
  } finally {
    const patch = buffer
    buffer = null
    commitResidency(patch)
  }
}

/** 一次落定的收笔:按「缓冲 + 树」算投影,连同缓冲一次写下去。 */
function commitResidency(patch: P.StagePatch): void {
  const base = { ...useStageStore.getState(), ...patch } as StageState
  const next = projectionOf(base)
  // 一格都没动就不 set —— 空动作(收一个本来就在 Dock 里的)不该惊动订阅者。
  if (Object.keys(patch).length === 0 && sameProjection(next, base)) return
  useStageStore.setState({ ...patch, ...next } as Partial<StageStore>)
}

export const stagePlacementDeps: P.PlacementDeps = {
  // 编排期间读「store + 缓冲」:同一句编排里后面几步要看得见前面几步写的东西。
  stage: () => (buffer ? ({ ...useStageStore.getState(), ...buffer } as StageState) : useStageStore.getState()),
  patchStage: (patch) => {
    if (buffer) Object.assign(buffer, patch)
    else useStageStore.setState(patch as Partial<StageStore>)
  },
  viewport,
}

/**
 * 「这一下点开该去哪」的解析,收在这一处。
 *
 * 它是 store 唯一该做的那种「组合」:纯函数不认识 items 表(认识了它就不纯了),
 * 而 item 的天生落点正长在那张表上 —— 于是这层壳把表上那一格取出来递进去。
 * 两个入口(点瓦 / 快捷键)共用它,免得解析序在两处各写一遍。
 */
function openMemoryFor(s: StageState & StageSettings, id: string) {
  return T.resolveOpen(s, id, s.defaultOpen, findItem(id)?.defaultPlacement)
}

/* ── 全屏那一档的两句接线(W2)──────────────────────────────────────────────
 *
 * 全屏不是一个住处,所以它落在**另一台 store** 上(`workbench.full`)。形态机这一侧
 * 只有两件事要做,而两件都必须住在 store 这一层:纯函数不认识拼贴台,
 * `stage/placement.ts` 那一层也只拿得到形态机那两口(判词写在它的 `PlacementDeps` 上)。
 */

/**
 * **这一格内容此刻住在哪一形**(W7-p 修一轮裁定 4)。
 *
 * 只有全屏那一支用它:全屏**不摘树**(裁定 2),所以「它在哪儿」照旧问得出来 ——
 * 从前那一支写死答 `'center'`,于是一条钉在右架子上的会话全屏着时,`enterSession`
 * 据此又往中央区的输入框送一次焦点(而屏幕上根本没有那台聊天)。
 * 判据仍旧只有 `summonSituationOfRef` 一处 —— 这里只读它的 `where`。
 */
function whereKindOfRef(id: string): SummonWhere['kind'] | null {
  const situation = summonSituationOfRef(
    useWorkbenchStore.getState().regions,
    useStageStore.getState(),
    id,
    { focusedOwner: null },
  )
  return situation.where?.kind ?? null
}

/** 这块瓦此刻正铺着全屏吗。 */
function isItemFull(id: string): boolean {
  const full = useWorkbenchStore.getState().full
  return full !== null && refId(full.ref) === refId(panelRef(id))
}

/**
 * **一次落定的外溢结果的唯一落点**(W7-p 裁定 2/3;修一轮把「唯一」变成事实)。
 *
 * 两档:`{kind:'full'}` = 去铺全屏;`{kind:'refused'}` = 摆不下,**播报那一句**。
 *
 * ── 修一轮补的那半条 ────────────────────────────────────────────────────
 * 裁定 3 立的原话是「三条路都经 landFull」,但真机上不是:`stageToEdge` /
 * `floatToEdge`(舞台檐与浮窗檐上的「钉到边」菜单)直接 `orchestrate(() => placeAs(…))`
 * 把返回值丢了 —— 预算不够时它们**静默不动**,用户点了那一行,屏幕上什么都没发生、
 * 读屏也没有一个字。今天凡「往边上钉」的路一律经这一只:点瓦四态、右键落点、
 * 拖拽落定、舞台/浮窗檐上的钉到边。产地一个,守卫在 `store.test` 与 gate ③。
 *
 * **`from` 不递**(裁定 2):缺席 = 「问树」。全屏不再摘树,所以这块瓦此刻
 * 住在哪儿,退出就回哪儿 —— 钉在右边的回右边、浮着的回那扇窗。哪棵树都不在的
 * (出厂即全屏的那几块瓦)问出来是 `null`,于是退出即回 Dock,与 W2 逐字相同。
 * 判词写在 `workbench/store.ts` 的 `FullState` 上。
 */
function land(id: string, outcome: P.PlacementOutcome): void {
  if (outcome?.kind === 'refused') {
    announceRefusal(outcome)
    return
  }
  if (outcome?.kind !== 'full') return
  useWorkbenchStore.getState().enterFull(panelRef(id))
}

/** 四条边 → 播报里那个名词。与 `LeafActions` 那张表读同一族 key。 */
const SIDE_NAME_KEY: Record<ShelfSide, 'drag.sideLeft' | 'drag.sideRight' | 'drag.sideTop' | 'drag.sideBottom'> = {
  left: 'drag.sideLeft',
  right: 'drag.sideRight',
  top: 'drag.sideTop',
  bottom: 'drag.sideBottom',
}

/**
 * **拒绝要说话**(W7-p 裁定 3)。播报是 DOM 副作用,所以它只能落在这一层 ——
 * 判据在纯函数(`canNailShelf`)、编排在 `stage/placement.ts`,两处都碰不到 DOM。
 * 全壳这一句只有这一个产地:凡「往边上钉」的路都经 `land`(判词在它头上)。
 */
function announceRefusal(outcome: { reason: 'shelf-budget'; side: ShelfSide }): void {
  announce(t('stage.shelfNoRoom', { side: t(SIDE_NAME_KEY[outcome.side]) }))
}

/* ── 召唤四态的效果分流表(W7-p 修一轮裁定 4)──────────────────────────────── */

/**
 * **召唤的对象**。两个入口(一块瓦 / 一格内容)的差别整件收在这只接口的两份
 * 实现里,于是四态的分流表(`applySummonAction`)只有一份。
 *
 * ── 病历 ──────────────────────────────────────────────────────────────────
 * 裁定 6 说的是「一台机器,两个入口」,可落地时 `summonItem` 与 `summonRef` 各写了
 * 一套 `switch`。同一份表抄两遍,**当场就已经分叉**:
 *  · 第三态 `focus` —— 瓦那边同步 `activateScope`,内容那边排在提交之后;
 *  · 第二态 `reveal` —— 瓦那边只留一格 `requestFocusOnOpen`(而形态并没有变,
 *    `focus-follow` 那条差分判据根本不会响,于是那一格点名躺在那儿谁也没用),
 *    内容那边真的把焦点送了进去;
 *  · 「闪一下」两处各写一句 `flashPinned + 1`。
 * 判据(纯函数 `summonFromSituation`)一直只有一份 —— 分叉的是**效果**,所以守卫
 * 也要落在效果这一层(`summon-entries.test.ts` 比的就是「调用了哪些 store 动作、
 * 什么次序」,不再只比 action 对象)。
 */
interface SummonTarget {
  /** ① 未打开 —— 按它的记忆开出来。 */
  open(): void
  /** ② 露出:点名它坐的那一格(架子 tab / 叶内 tab,四个区域同一句话)。 */
  activateSeat(): void
  /** ② 浮窗那一形:翻到最上面。 */
  frontFloat(): void
  /**
   * ③ 把键盘送进它那一层。`scope` 由判据点名(第三态);`null` = 由对象自己答
   * 「我该落在哪一层」(第二态露出之后的跟焦)。
   *
   * **一律排在 React 提交之后**(裁定 5 那副队列,`focus/after-commit`):
   * 落定那一刻宿主层还没挂上来,当场 `activate` 一定答 false —— 瓦那条路从前是
   * 同步的,所以它其实一直没送成,只是没人量。
   *
   * 名字不叫 `focus`:跨作用域搬焦点在这台壳里只有 `activateScope` 一条路
   * (响应链的 I3),而一个叫 `.focus(` 的方法读起来像在直接动 DOM ——
   * `ui:consume` 的 `focus-outside-focus` 那条硬闸也是这么读的。
   */
  sendKeyboard(scope: FocusScopeId | null): void
  /** ④ 收起来(架子那一形不走这里 —— 它收的是整条架子,与对象无关)。 */
  hideAway(): void
}

/** 架子闪一下:「你要的东西已经在这儿了」。**一处** —— 两个入口同一句。 */
function flashShelf(side: ShelfSide): void {
  useStageStore.setState((st) => ({ flashPinned: st.flashPinned + 1, flashSide: side }))
}

/**
 * **召唤这一下的效果 —— 全壳唯一一份分流表**(W7-p 修一轮裁定 4)。
 *
 * 判据(`summon.summonFromSituation`)答「做什么」,这一只答「怎么做」,
 * 而「对谁做」由 `SummonTarget` 的两份实现答。三件事分开,所以加第三种对象是加
 * 一份 `SummonTarget`,不是在这里加一个 if。
 */
function applySummonAction(action: SummonAction, target: SummonTarget): void {
  switch (action.kind) {
    case 'open':
      target.open()
      return
    case 'reveal': {
      if (action.how === 'float-front') target.frontFloat()
      else target.activateSeat()
      if (action.side !== null) {
        // 先点名 tab(已经是活动的就是恒等变换),收着的再展开 —— 细梁上一个 tab
        // 的内容都不画,所以两件事都要做。
        if (action.how === 'shelf-expand') useStageStore.getState().toggleShelfCollapsed(action.side)
        flashShelf(action.side)
      }
      target.sendKeyboard(null)
      return
    }
    case 'focus':
      target.sendKeyboard(action.scope)
      return
    case 'hide':
      /*
       * 09-04 改判的第四格:**收起来**(推翻 09-03 的「回去」)。收的**对象按形态定**
       * (判词写在 summon.ts 的文件头):钉在架子上收整条架子,别的形态由对象自己
       * 说(瓦收回 Dock、内容收掉那扇窗)。
       *
       * **焦点一个字都不搬**:面一收,装着它的那一层要么卸载要么变 inert,两条都是
       * 结构变化,树的结构归还(§4.5)把焦点送回按键之前的地方。手动搬会与那条归还
       * 打架(两个产地),门里那一步量的正是「不搬也回得去」。
       */
      if (action.how === 'none') return // 中央区没有「收起」这一档 —— 诚实的空动作。
      if (action.how === 'shelf-collapse' && action.side !== null) {
        useStageStore.getState().toggleShelfCollapsed(action.side)
        return
      }
      target.hideAway()
      return
    case 'blocked':
      // 不越过盖层(§14)。**诚实的空动作** —— 理由写在 summon.ts 的文件头。
      return
  }
}

/** 对象之一:**一块瓦**。住处问形态机,焦点落在装着它的那一层上。 */
function itemSummonTarget(id: string): SummonTarget {
  const placement = (): Placement => T.placementOf(useStageStore.getState(), id)
  return {
    open: () => {
      /*
       * 「这一次打开是键盘点的名」—— 形态**真的变了**的那条路由 `focus-follow`
       * 在提交之后接(判词在 summon.ts 的 `requestFocusOnOpen` 上)。它与下面
       * `focus()` 那一副队列是同一件事的两条路,都幂等,所以两条都留着。
       */
      requestFocusOnOpen(id)
      const memory = openMemoryFor(useStageStore.getState(), id)
      land(id, orchestrate(() => P.openFromMemory(stagePlacementDeps, id, memory)))
    },
    activateSeat: () => {
      const at = placement()
      if (at.kind === 'edge') useStageStore.getState().activateShelfTab(at.side, id)
    },
    frontFloat: () => orchestrate(() => P.focusFloatIn(stagePlacementDeps, id)),
    sendKeyboard: (scope) => {
      const layer = scope ?? LAYER_SCOPE_OF[placement().kind]
      if (layer) activateScopeAfterCommit(layer, { owner: id, reason: 'open' })
    },
    hideAway: () => useStageStore.getState().closeToDock(id),
  }
}

/** 对象之二:**一格内容**。住处问拼贴树,焦点落在那一格内容自己那一层上。 */
function refSummonTarget(id: ContentRefId, seat: RefSeat | null, floatId: string | null): SummonTarget {
  return {
    // 到不了:`summonRef` 只在「它开着」时才走分流表(`where` 非空)。
    open: () => {},
    /*
     * 点名那一格 tab —— 四个区域同一句话(树上的 tab 不分区域)。
     *
     * **经 `orchestrate`**(W7-p 修一轮裁定 4):它改的是树,而形态机那几格投影
     * (`shelves[side].activeId` / `visible`)要跟着对上。瓦那条路走的是
     * `activateShelfTab`,它本来就在编排里;两条路都进同一格缓冲,订阅者看到的
     * 才是同一次干净的 A → B —— 否则同一份现场从两个入口召唤会落在两份状态上
     * (`summon-entries.test.ts` 的「两个入口是同一台机器」当场量出来过)。
     */
    activateSeat: () => {
      if (seat) orchestrate(() => useWorkbenchStore.getState().activateTab(seat.leafId, seat.index))
    },
    frontFloat: () => {
      if (floatId) useStageStore.getState().focusFloat(floatId)
    },
    /*
     * 内容那一层的 `owner` 就是它的 refId(判词在 `PaneLeaf.PaneContentLayer` 上),
     * 所以**不看 scope**:判据点名的是「装着它的那一层」,而这里要的是更深的
     * 那一格 —— 二合一的一格尤其:pair 的两侧各是一格 `leaf` 作用域,
     * 要的是被召唤的**那一侧**。
     */
    sendKeyboard: () => activateScopeAfterCommit('leaf', { owner: id, reason: 'open' }),
    // 浮窗那一形:收的是**那扇窗**(里面的 tab 全部转入隐藏表,内容不丢)。
    hideAway: () => {
      if (floatId) useStageStore.getState().closeFloat(floatId)
    },
  }
}

/**
 * store 只是 transitions 的一层壳:每个 action 都是 set(transitions.f)。
 * 逻辑不许写在这里 —— 写在这里就测不到了。
 * 唯一的「组合」是 clickDockIcon / summonItem 里先 resolveOpen 再落形态,判据仍是纯函数。
 */
export const useStageStore = create<StageStore>()(
  persist(
    (set, get) => {
      /*
       * ── 形态落定 → 焦点跟过去,**接线不在这里** ─────────────────────────
       * 判据是前后两份 `placements` 的差,执行必须落在 React 提交之后(落定那一刻
       * 宿主层还没挂上来)—— 所以它整件住在 `stage/focus-follow.ts`,由 `AppShell`
       * 挂一次 `useStageFocusFollow()`。这里一个字都不必知道那件事。
       */

      return {
      ...T.initialStageState,
      ...T.initialStageSettings,
      byWorkspace: {},
      items: STAGE_ITEMS,
      dockDisplay: 'always',
      shelfRail: 'shown',

      /**
       * **点 Dock 瓦 = 召唤**(W7-p 裁定 6,审计 A 的 A7/A8)。
       *
       * ── 病历 ────────────────────────────────────────────────────────────
       * 从前它是**另一台机器**(`placement.clickDockIcon` 的四条 if)。同一块面、
       * 同一个状态,点瓦与按快捷键给出不同的答案:浮窗已经在最上面时点瓦是「再置顶
       * 一次」(零反馈,用户以为点坏了),按键是「送焦点」;再点一下,点瓦还是零
       * 反馈,按键收起来。两台机器讲两种语言,而用户只有一套心智。
       *
       * ── 今天:一台机器,两个入口 ──────────────────────────────────────────
       * 两条路都走 `summonItem`,于是四态**逐字相同**。`placement.clickDockIcon`
       * 那只函数整个删掉 —— 留着它就是留着第二个产地,而分叉的第一处必然是
       * 「下一个人只改了其中一条」。
       */
      clickDockIcon: (id) => get().summonItem(id),
      openAs: (id, placement) =>
        land(id, orchestrate(() => P.placeAs(stagePlacementDeps, id, placement))),
      placeRef: (ref, region, opts) => {
        // 拒绝要说话(W7-p 裁定 3)。`land` 是「落定结果」的唯一落点,
        // 拖拽落定 / 右键落点 / 启动瓦三条路都经这里,所以那句话只有一个产地。
        // (这一支答不出全屏,所以只有拒绝那一格 —— 但仍旧经同一只。)
        const outcome = orchestrate(() => P.placeRefIn(stagePlacementDeps, ref, region, opts ?? {}))
        if (outcome?.kind === 'refused') announceRefusal(outcome)
      },
      /*
       * ── 召唤(S1)是 store 唯一那种「先问再分流」的动作 ──────────────────
       * 它不是一句 `set(纯函数)`,因为判据要同时读**两份**事实:形态机这一份
       * (在哪儿 / 看不看得见)与响应链那一份(焦点在不在它里面)。判据本身仍然
       * 是纯的(`summonFromSituation`),而**效果**那一半整件在 `applySummonAction`
       * (全壳一份,判词在它头上)。这两个入口因此只剩三句话:退全屏 / 问处境 /
       * 交给分流表,差别只在「对象怎么寻址」(`SummonTarget` 的两份实现)。
       */
      summonItem: (id) => {
        /*
         * **它正铺着全屏 → 收起来**(W2;召唤四态的第四格「看得见、焦点在里面 →
         * 收起来」在全屏这一形上的样子)。这一格判据在 store 而不在纯函数里:
         * 「谁在全屏」只有拼贴台那本账知道,`summonFromSituation` 问不出来。
         */
        if (isItemFull(id)) {
          useWorkbenchStore.getState().exitFullIfOpen()
          return
        }
        /*
         * **A9:全屏开着时召唤别的瓦 —— 先退全屏**(W7-p 裁定 6)。
         * 真机现场:全屏铺着,按 ⌘ 数字召唤另一块面,那块面开在全屏层**底下**,
         * 屏幕上什么都没变、焦点也没进去 —— 用户按了一下,得到的是「没反应」。
         * 退出按裁定 2 的规则(放回原住处,而它从来没离开过),再照常召唤。
         */
        useWorkbenchStore.getState().exitFullIfOpen()
        const action = summonTransition(get(), id, {
          focusedOwner: focusTree.isOwnerActive(id) ? id : null,
        })
        applySummonAction(action, itemSummonTarget(id))
      },
      /**
       * **召唤一格内容**(W7-p 裁定 6)—— 第二个入口,同一台机器。
       *
       * ── 病历(两处,一个病根)────────────────────────────────────────────
       *  · **启动瓦**(「目录」)从前整条**绕过**召唤:点它一律 `launcher.open()`,
       *    于是「它已经钉在左架子上、架子收着」时点一下什么都看不见 —— 那块面板
       *    早就开着,`openDirectoryPanel` 把同一格内容再摆一次是恒等变换;
       *  · **sidebar 单击一条已经开着的会话**只 `activateTab` 一句:那条会话在
       *    右架子里(收着)/ 在压在底下的浮窗里时,屏幕上一动不动。
       * 两处都是同一件事没人做:**先问它此刻在哪,再对那个位置办事**。
       *
       * ── 这一层做什么 ────────────────────────────────────────────────────
       * 与 `summonItem` 逐条同型:退全屏 → 取处境 → 交给**同一张**分流表。
       * 它多的那一件事是**答住处**:调用方(sidebar 单击那条路)要据此决定
       * 「这一下算办完了没有」以及「焦点该不该再进输入面板」。
       */
      summonRef: (ref, intent: SummonIntent = 'toggle') => {
        const id = refId(ref)
        const wb = useWorkbenchStore.getState()
        /*
         * **它正铺着全屏**:`toggle` 收起来(第四态在全屏这一形上的样子,与
         * `summonItem` 逐字同一句),`reveal` 什么都不做 —— 铺满整扇窗已经是
         * 「露出来」的极限,而「切过去」没有反面。
         *
         * 答的是**真实住处**(W7-p 修一轮裁定 4),不是从前那句写死的 `'center'`:
         * 全屏不摘树(裁定 2),所以它此刻仍旧坐在某个区域里 —— 一条钉在右架子上
         * 的会话全屏着时点它那一行,从前答 'center',`enterSession` 据此又往中央区的
         * 输入框送一次焦点,而屏幕上根本没有那台聊天。
         */
        if (wb.full && refId(wb.full.ref) === id) {
          if (intent === 'toggle') wb.exitFullIfOpen()
          return whereKindOfRef(id)
        }
        // A9:全屏铺着时召唤**别的**东西 —— 先退全屏,否则它开在全屏层底下。
        if (wb.full) wb.exitFullIfOpen()
        const situation = summonSituationOfRef(useWorkbenchStore.getState().regions, get(), id, {
          focusedOwner: focusTree.isOwnerActive(id) ? id : null,
        })
        const where = situation.where
        // 哪棵树上都没有 —— 这一下不归形态机管(判词在类型声明上)。
        if (!where) return null
        const seat = seatOfRefIn(useWorkbenchStore.getState().regions, id)
        const action = summonFromSituation(situation, intent)
        // 第一态到不了(`where` 非空就说明它开着)。答 null =「这一下没做成」,
        // 不咽下去也不假装做了。
        if (action.kind === 'open') return null
        applySummonAction(action, refSummonTarget(id, seat, floatIdOfRegion(seat?.region ?? '')))
        return where.kind
      },
      closeToDock: (id) => orchestrate(() => P.closeToDock(stagePlacementDeps, id)),
      closeStage: () => orchestrate(() => P.closeStage(stagePlacementDeps)),
      /*
       * 「接住了没有」由**形态机**回答,不由宿主再判一次:问它有没有目标、
       * 再让它去收,两句话中间的那一格状态永远有可能不一致。所以这里先取一次
       * 目标(纯查询),据此决定返回值,再让 set 走同一条 escapeTopmost。
       */
      escapeTopmost: (): boolean => {
        // 取当下状态用创建器给的 `get`,不用模块级的 useStageStore ——
        // 那会让这个初始化器**引用它自己**,整个 store 的类型当场塌成 any。
        //
        // 「全屏开着没有」由拼贴台那本账答(W2)——次序判据仍旧只在那个纯函数里,
        // 这里只把它要的那个布尔递进去。
        const target = T.escapeTargetOf(get(), useWorkbenchStore.getState().full !== null)
        if (target === null) return false
        if (target.kind === 'full') {
          useWorkbenchStore.getState().exitFull()
          return true
        }
        orchestrate(() => P.closeToDock(stagePlacementDeps, target.id))
        return true
      },
      /*
       * ── 四口形态搬家一律经 `land`(W7-p 修一轮裁定 3)────────────────────
       * 它们从前把 `placeAs` 的返回值丢了,于是「这条边摆不下」在舞台檐与浮窗檐
       * 那两张「钉到边」菜单上是**静默不动**:用户点了那一行,屏幕没变、读屏也
       * 没有一个字。今天与点瓦 / 右键落点 / 拖拽落定同一只落点,那句播报因此
       * 只有一个产地。
       */
      stageToFloat: () => {
        const id = get().stageId
        if (id !== null) land(id, orchestrate(() => P.placeAs(stagePlacementDeps, id, { kind: 'float' })))
      },
      stageToEdge: (side) => {
        const id = get().stageId
        if (id !== null) land(id, orchestrate(() => P.placeAs(stagePlacementDeps, id, { kind: 'edge', side })))
      },
      floatToEdge: (id, side) => {
        if (T.placementOf(get(), id).kind !== 'float') return
        land(id, orchestrate(() => P.placeAs(stagePlacementDeps, id, { kind: 'edge', side })))
      },
      edgeToFloat: (id) => {
        if (T.placementOf(get(), id).kind !== 'edge') return
        land(id, orchestrate(() => P.placeAs(stagePlacementDeps, id, { kind: 'float' })))
      },
      focusFloat: (id) => orchestrate(() => P.focusFloatIn(stagePlacementDeps, id)),
      ensureFloatRect: (id) =>
        set((st) => {
          if (st.floats[id]) return st
          // 锚 + 层叠:**同一只产地**(W7-p 修一轮裁定 1)。读数装配也在那边
          // (`floatSpawnContext`)—— 这里从前抄了一份,两份必然分叉。
          return { floats: { ...st.floats, [id]: T.freshFloatRect(st, viewport()) } }
        }),
      moveFloat: (id, x, y) => set((s) => T.moveFloat(s, id, x, y, viewport())),
      resizeFloat: (id, rect) => set((s) => T.resizeFloat(s, id, rect, viewport())),
      reclampFloats: (vp) => set((s) => T.reclampAll(s, vp)),
      /*
       * 「点名这条边上的那一格」现在是**树的动作**:找到装着它的那片叶,把活动
       * 下标挪过去。判据(不在这条边上 / 已经是活动的 = 恒等变换)由树自己保证。
       */
      activateShelfTab: (side, id) => orchestrate(() => P.activateShelfTabIn(stagePlacementDeps, side, id)),
      toggleShelfCollapsed: (side) =>
        orchestrate(() => P.setShelfCollapsed(stagePlacementDeps, side, !get().shelves[side].collapsed)),
      revealRegion: (region) => orchestrate(() => P.revealRegionIn(stagePlacementDeps, region)),
      closeShelf: (side) => orchestrate(() => P.closeShelf(stagePlacementDeps, side)),
      closeFloat: (id) => orchestrate(() => P.closeFloat(stagePlacementDeps, id)),
      // 递整个视口而不是那一条轴的长度(W7-p 裁定 3):共同预算要问对边,
      // 而对边的轴可能是另一条 —— 一个标量说不出这件事。
      setShelfThickness: (side, thickness) =>
        set((s) => T.setShelfThickness(s, side, thickness, viewport())),
      setDockDisplay: (dockDisplay) => set({ dockDisplay }),
      setShelfRail: (shelfRail) => set({ shelfRail }),
      setDockEdge: (dockEdge) => set({ dockEdge }),
      setDockAlign: (dockAlign) => set({ dockAlign }),
      setDockSize: (dockSize) => set({ dockSize }),
      setDockMagnify: (dockMagnify) => set({ dockMagnify }),
      setDockMagnifyLevel: (dockMagnifyLevel) => set({ dockMagnifyLevel }),
      setDockRunningDot: (dockRunningDot) => set({ dockRunningDot }),
      setDefaultOpen: (defaultOpen) => set({ defaultOpen }),
      setLocale: (locale) => set({ locale }),
      setItemHidden: (id, hidden) =>
        set((s) => ({
          hiddenItems: T.setItemHidden(
            s.hiddenItems,
            id,
            hidden,
            findItem(id)?.alwaysInDock === true,
          ),
        })),
      }
    },
    {
      name: 'onething.stage',
      version: T.STAGE_PERSIST_VERSION,
      storage: createJSONStorage(() => localStorage),
      /*
       * **迁移顺手把住处交出去**(W4 的 v8 → v9 搬家)。第三个参数就是那条交接口:
       * v9 那一段在摘掉 `placements` / 架子 tab 之前把它们递给 `legacy-furniture`,
       * `startStage()` 再把它们折成树。判词全文在那只文件的头上 —— 一句话:
       * 交接必须发生在**迁移里**,因为只有走到 v9 的那一份才是补齐过的。
       */
      migrate: (persisted, version) =>
        T.migrateStagePersisted(persisted, version, stashLegacyStageResidency),
      // 迁移可被在飞实例的写盘绕过(旧值配新版本号落盘,migrate 不再跑)——
      // 合并处对档值再钳一次,与 placementForOpen 的读取钳共用同一个函数。
      merge: (persisted, current) => {
        const merged = { ...current, ...(persisted as Partial<StageStore>) }
        merged.defaultOpen = T.clampDefaultOpen(merged.defaultOpen)
        /*
         * 开机就摊开**当前空间**那一格家具(T-W1)。
         *
         * 放在 `merge` 里而不是 `onRehydrateStorage`:merge 是**同步**的、发生在
         * store 建出来那一刻,所以第一帧画的就是那个空间的布局 —— 不会先画一屏
         * 出厂布局再跳成用户的(与 `workspace/apply.ts` 把色标贴在 createRoot
         * 之前是同一条理由)。
         *
         * 这一刻 `currentSpaceId()` 读的是 persist 槽里那个 id(工作区列表还没拉),
         * 而那正是要的:上次停在哪个空间,开机就该是哪个空间的家具。列表拉回来
         * 若发现那个空间已被别的窗口删掉,`bindPerSpace` 那条订阅会当场换装。
         */
        merged.byWorkspace = (merged.byWorkspace ?? {}) as StageStore['byWorkspace']
        Object.assign(merged, spreadSpace(merged.byWorkspace, STAGE_PER_SPACE))
        // 旧档案里没有这一格(它是本批新加的),缺席就该是空表而不是 undefined ——
        // 一个 undefined 会让 Dock 的投影在第一帧上抛。不写迁移段的理由也在这里:
        // 「缺席读作空」本身就是这一格的语义,不需要翻译。
        merged.hiddenItems = Array.isArray(merged.hiddenItems) ? merged.hiddenItems : []
        /*
         * 同一条(本批新加的那一格):**缺席读作 `'shown'`** —— 那就是这一格的语义,
         * 不需要一个迁移版本来翻译它。写成白名单而不是 `?? 'shown'`,是因为档案里
         * 那一格也可能是别的脏字符串(手改 localStorage / 未来版本回滚),而
         * 「不是 hidden 就是 shown」两档全覆盖。
         */
        merged.shelfRail = merged.shelfRail === 'hidden' ? 'hidden' : 'shown'
        /*
         * 档案里的浮窗矩形当场重钳一遍(09-04 §4)。
         *
         * 存下来的那份身量是**上一台窗口**的:1400 宽的窗里摆好的 880 浮窗,搬到
         * 1100 宽的窗里右缘就在屏幕外了 —— 而钳制从前只在手势那一刻发生,于是那扇窗
         * 从开机起就是坏的,拖它一下才好。这里连同 `byWorkspace` 账上每个空间那一格
         * 一起钳(reclampAll 自己走那本账),所以切到别的空间也不会露出同一个病。
         *
         * 视口量不出来就**跳过**(jsdom / SSR:window 在但尺寸是 0)—— 拿 0 去钳会把
         * 每一扇窗都压成最小档,那比不钳坏得多。
         */
        const vp = typeof window === 'undefined' ? null : viewport()
        if (vp && vp.w > 0 && vp.h > 0) Object.assign(merged, T.reclampAll(merged, vp))
        return merged
      },
      /*
       * 落盘分两半(T-W1):
       *  · **偏好**逐格摊在顶层,跨工作区共享(Dock 的位置与身量、藏了哪些瓦、
       *    打开档、界面语言);
       *  · **家具**(架子/浮窗/记忆/落点)一律进 `byWorkspace` 那本账,每个空间
       *    一格。活状态那几个字段**不落盘** —— 它们只是当前空间那一格的展开,
       *    两处都落就有两份真相。
       * 「什么算家具」由 `T.pickStageFurniture` 一处说了算(舞台那条照旧在它里面摘掉:
       *  它是「此刻开着」,不是「用户摆好的」)。
       */
      partialize: (s) => ({
        dockDisplay: s.dockDisplay,
        shelfRail: s.shelfRail,
        dockEdge: s.dockEdge,
        dockAlign: s.dockAlign,
        dockSize: s.dockSize,
        dockMagnify: s.dockMagnify,
        dockMagnifyLevel: s.dockMagnifyLevel,
        dockRunningDot: s.dockRunningDot,
        hiddenItems: s.hiddenItems,
        defaultOpen: s.defaultOpen,
        locale: s.locale,
        byWorkspace: stashSpace(s, s.byWorkspace, STAGE_PER_SPACE),
      }),
    },
  ),
)

/* ── 投影器:树 → 形态机那三格 ────────────────────────────────────────────── */

/**
 * **把拼贴树折成形态机读得懂的那三格**(`placements` / `shelves[side].tabs` /
 * `floatOrder`)。全壳**唯一的写者**;判据整件是纯函数 `residency.projectResidency`。
 *
 * ── 为什么订的是 workbench 而不是两边都订 ────────────────────────────────
 * 投影的输入只有两样:树(住处)与这台 store 自己的两格瞬态。前者变了要重算,
 * 后者由**改它的那几条动作**顺手带上(`placeAs` 里那一句 `patchStage` 之后
 * 紧跟着就是这一次同步)。反过来订自己会有两个坏处:一是每次几何变化都白算
 * 一遍,二是用例里 `setState({ placements })` 那种直写会被当场抹掉 ——
 * 而那是既有用例读「某块面此刻的形态」最省的一种夹具。
 *
 * 换空间那一拍由 `workspace/layout-scope.ts` 兜住:workbench 那条 `bindPerSpace`
 * 排在 stage 之后,所以两份家具都换完之后这条订阅才响一次。
 */
/** 按这一份形态状态 + 此刻的树算一次投影。**唯一产地**,两条路共用。 */
function projectionOf(base: StageState) {
  return projectResidency(useWorkbenchStore.getState().regions, base, {
    stageId: base.stageId,
  })
}

export function syncStageResidency(): void {
  /*
   * **编排期间不写**:那一次的收笔在 `commitResidency` 里,连同缓冲一次写下去
   * (理由是「一句编排 = 一次 set」,判词在 `orchestrate` 上)。
   * 树在编排里会被改好几次,这里每次都写就又裂成好几拍了。
   */
  if (buffer) return
  const state = useStageStore.getState()
  const next = projectionOf(state)
  // 没变就不 set —— 一次无谓的 set 会让 Dock / 架子 / 浮窗全重渲一遍。
  if (sameProjection(next, state)) return
  useStageStore.setState(next)
}

/** 已经接上了没有。幂等靠它 —— 这是「这个进程接过一次没有」,不是可渲染状态。 */
let stopResidency: (() => void) | null = null

/**
 * 接上投影。**幂等**:重复调用先把上一次退役掉,不会攒出两条订阅。
 * 由 `main.tsx` 与 `startWorkbench()` 之外的宿主(用例)各自调一次都安全。
 */
export function startStageResidency(): () => void {
  stopStageResidency()
  syncStageResidency()
  const stop = useWorkbenchStore.subscribe(syncStageResidency)
  stopResidency = stop
  return stopStageResidency
}

export function stopStageResidency(): void {
  stopResidency?.()
  stopResidency = null
}

/*
 * ── 接线**不在模块作用域**(09-04 真机证伪的那条判例,这一批又踩了一次)────
 * 第一版把 `foldLegacyStageFurniture()` + `startStageResidency()` 直接写在这只
 * 文件末尾。**当场炸**:`SHELF_SIDES is not iterable` —— 因为这台壳里那条存量
 * import 环还在(`stage/store → stage/items → stage/types → i18n → stage/store`),
 * 从 `transitions` 那一侧先进来时,`transitions` 的模块体还没跑完,而模块作用域
 * 里的这一句立刻就去读它的 `SHELF_SIDES`,读到的是 TDZ。
 *
 * 修法与 `workspace/layout-scope.ts` 文件头那条判例逐字相同:**模块只导出动作,
 * 接线由宿主显式做一次**(`main.tsx` 的 `startStage()`,以及不经过 main.tsx 的
 * 宿主 —— 用例 —— 在 `AppShell` 那一句 layout effect 里)。
 *
 * 模块级订阅 = 这个模块实例的寿命,所以配一段 HMR 退役(CLAUDE.md 那条法):
 * 复用既有那一口拆卸,不写第二套;幂等。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(stopStageResidency)
}

/**
 * **形态机的开工口**(W4)。两句话,次序即语义:
 *  ① 先把存量家具折进树(v8 → v9 那次搬家;幂等,判词在 `legacy-furniture` 文件头);
 *  ② 再接上投影 —— `startStageResidency()` 自己先同步一次,所以第一帧就是对的。
 *
 * 由 `main.tsx` 调一次;`AppShell` 的 layout effect 再调一次(**幂等**),
 * 那一句是给不经过 `main.tsx` 的宿主(用例、将来的第二个壳)的 —— 与
 * `CenterRegion` 里那句 `seed()` 逐字同一个体例。
 */
export function startStage(): () => void {
  foldLegacyStageFurniture(nextLeafId)
  return startStageResidency()
}
