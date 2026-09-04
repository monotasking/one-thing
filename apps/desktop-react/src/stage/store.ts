import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { focusTree } from '../focus/registry'
import { useWorkbenchStore } from '../workbench/store'
import { STAGE_ITEMS, findItem } from './items'
import { requestFocusOnOpen, summonTransition } from './summon'
import * as T from './transitions'
import * as P from './placement'
import { foldLegacyStageFurniture, stashLegacyStageResidency } from './legacy-furniture'
import { nextLeafId } from '../workbench/ids'
import { projectResidency, sameProjection } from './residency'
import type { Locale } from '../i18n'
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
  ResolvedOpen,
  ShelfSide,
  StageItemSpec,
  StageSettings,
  StageState,
  Viewport,
} from './types'

interface StageStore extends StageState, StageSettings, PerSpaceState<T.StageFurniture> {
  items: StageItemSpec[]
  dockDisplay: DockDisplay

  /** 落点由 resolveOpen 解析(记忆 > 全局默认档);要点名落点的走 openAs。 */
  clickDockIcon: (id: string) => void
  /** 显式手势那一层:点名放到哪儿。它既执行也写记忆(记忆在 transitions 的 openAs 里落)。 */
  openAs: (id: string, placement: Placement) => void
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
  closeToDock: (id: string) => void
  closeStage: () => void
  closeCover: () => void
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
  closeShelf: (side: ShelfSide) => void
  /**
   * **关一扇浮窗**(W4,设计 §2.2)= 把里面的 tab 全部**隐藏**,不是关闭。
   * 窗子没了,内容还在隐藏表里,「隐藏的标签 ⋯」点得回来 —— 与「收回 Dock
   * 不丢状态」同一条判据,只是这一条对**文件**也说得通(文件没有 Dock 可回)。
   */
  closeFloat: (id: string) => void
  setShelfThickness: (side: ShelfSide, thickness: number) => void
  setDockDisplay: (d: DockDisplay) => void
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

function orchestrate(fn: () => void): void {
  if (buffer) {
    fn()
    return
  }
  buffer = {}
  try {
    fn()
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
  return T.resolveOpen(s, id, s.defaultOpen, viewport(), findItem(id)?.defaultPlacement)
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

      clickDockIcon: (id) => orchestrate(() => P.clickDockIcon(stagePlacementDeps, id, openMemoryFor(get(), id))),
      openAs: (id, placement) => orchestrate(() => P.placeAs(stagePlacementDeps, id, placement)),
      /*
       * ── 召唤(S1)是 store 唯一那种「先问再分流」的动作 ──────────────────
       * 它不是一句 `set(纯函数)`,因为判据要同时读**两份**事实:形态机这一份
       * (在哪儿 / 看不看得见)与响应链那一份(焦点在不在它里面)。判据本身仍然
       * 是纯的(`summonTransition`),这里只做三件事:把树那一头的读数取成一个
       * 布尔递进去、按动作分流到**既有**的动作上、给键盘那条路点名(跟焦仍由
       * `focus-follow` 那唯一一处接线在提交之后送 —— 落定那一刻宿主层还没挂上来)。
       */
      summonItem: (id) => {
        const action = summonTransition(get(), id, {
          focusedOwner: focusTree.isOwnerActive(id) ? id : null,
        })
        switch (action.kind) {
          case 'open':
            requestFocusOnOpen(id)
            orchestrate(() => P.openFromMemory(stagePlacementDeps, id, openMemoryFor(get(), id)))
            return
          case 'reveal':
            requestFocusOnOpen(id)
            if (action.how === 'float-front') {
              orchestrate(() => P.focusFloatIn(stagePlacementDeps, id))
              return
            }
            {
              // 取成局部量再判:闭包里读 `action.side` 拿不到收窄(TS 只对本地
              // const 保得住),而这两句正好都在闭包里。
              const side = action.side
              if (side === null) return
              // 先点名 tab(已经是活动的就是恒等变换,zustand 连订阅都不推),
              // 收着的再展开 —— 细梁上一个 tab 的内容都不画,所以两件事都要做。
              get().activateShelfTab(side, id)
              if (action.how === 'shelf-expand') get().toggleShelfCollapsed(side)
            }
            return
          case 'focus':
            focusTree.activateScope(action.scope, { owner: id, reason: 'open' })
            return
          case 'hide':
            /*
             * 09-04 改判的第四格:**收起来**(推翻 09-03 的「回去」)。收的**对象
             * 按形态定**(判词写在 summon.ts 的文件头):钉在架子上收整条架子,
             * 别的形态收回 Dock。两条走的都是 store 已有的那一口,不新写落点。
             *
             * **焦点一个字都不搬**:面一收,装着它的那一层要么卸载要么变 inert,
             * 两条都是结构变化,树的结构归还(§4.5)把焦点送回按键之前的地方。
             * 手动搬会与那条归还打架(两个产地),门里那一步量的正是「不搬也回得去」。
             */
            if (action.how === 'shelf-collapse' && action.side !== null) {
              get().toggleShelfCollapsed(action.side)
              return
            }
            get().closeToDock(id)
            return
          case 'blocked':
            // 不越过盖层(§14)。**诚实的空动作** —— 理由写在 summon.ts 的文件头。
            return
        }
      },
      closeToDock: (id) => orchestrate(() => P.closeToDock(stagePlacementDeps, id)),
      closeStage: () => orchestrate(() => P.closeStage(stagePlacementDeps)),
      closeCover: () => orchestrate(() => P.closeCover(stagePlacementDeps)),
      /*
       * 「接住了没有」由**形态机**回答,不由宿主再判一次:问它有没有目标、
       * 再让它去收,两句话中间的那一格状态永远有可能不一致。所以这里先取一次
       * 目标(纯查询),据此决定返回值,再让 set 走同一条 escapeTopmost。
       */
      escapeTopmost: (): boolean => {
        // 取当下状态用创建器给的 `get`,不用模块级的 useStageStore ——
        // 那会让这个初始化器**引用它自己**,整个 store 的类型当场塌成 any。
        const target = T.escapeTargetOf(get())
        if (target !== null) orchestrate(() => P.closeToDock(stagePlacementDeps, target))
        return target !== null
      },
      stageToFloat: () => {
        const id = get().stageId
        if (id !== null) orchestrate(() => P.placeAs(stagePlacementDeps, id, { kind: 'float' }))
      },
      stageToEdge: (side) => {
        const id = get().stageId
        if (id !== null) orchestrate(() => P.placeAs(stagePlacementDeps, id, { kind: 'edge', side }))
      },
      floatToEdge: (id, side) => {
        if (T.placementOf(get(), id).kind !== 'float') return
        orchestrate(() => P.placeAs(stagePlacementDeps, id, { kind: 'edge', side }))
      },
      edgeToFloat: (id) => {
        if (T.placementOf(get(), id).kind !== 'edge') return
        orchestrate(() => P.placeAs(stagePlacementDeps, id, { kind: 'float' }))
      },
      focusFloat: (id) => orchestrate(() => P.focusFloatIn(stagePlacementDeps, id)),
      ensureFloatRect: (id) =>
        set((st) =>
          st.floats[id]
            ? st
            : { floats: { ...st.floats, [id]: T.defaultFloatRect(viewport()) } },
        ),
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
      closeShelf: (side) => orchestrate(() => P.closeShelf(stagePlacementDeps, side)),
      closeFloat: (id) => orchestrate(() => P.closeFloat(stagePlacementDeps, id)),
      setShelfThickness: (side, thickness) =>
        set((s) =>
          T.setShelfThickness(s, side, thickness, T.shelfViewportExtent(side, viewport())),
        ),
      setDockDisplay: (dockDisplay) => set({ dockDisplay }),
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
    coverId: base.coverId,
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
