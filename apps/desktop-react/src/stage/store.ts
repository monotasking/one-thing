import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { focusTree } from '../focus/registry'
import { STAGE_ITEMS, findItem } from './items'
import { requestFocusOnOpen, summonTransition } from './summon'
import * as T from './transitions'
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
   * 开关语义:在 Dock 里就按打开方式开,在别处就收回 Dock。
   *
   * **S1(09-04)之后它暂时没有消费者** —— 键盘那条 `toggle:<面>` 命令改走
   * `summonItem`(召唤,设计 §14),而 Dock 瓦点击走的一直是 `clickDockIcon`。
   * 本批不删它(派工令明写「toggleItem 不动」):删一个 store 的公开口是另一次
   * 裁定。它背后的纯函数 `transitions.togglePlacement` 仍有自己的用例钉着。
   */
  toggleItem: (id: string) => void
  /**
   * **召唤**一块面(S1,设计 §14)。键盘 `toggle:<面>` 命令的落点 —— 与
   * `toggleItem` 的分歧只有一句:**它永远不关面**(关面是 Esc 的活)。
   * 四态判据在纯函数 `summon.summonTransition` 里,这里只是它的分流器。
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
 * 唯一的「组合」是 clickDockIcon / toggleItem 里先 resolveOpen 再落形态,两边都仍是纯函数。
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

      clickDockIcon: (id) => set((s) => T.clickDockIcon(s, id, openMemoryFor(s, id), viewport())),
      openAs: (id, placement) => set((s) => T.openAs(s, id, placement, viewport())),
      toggleItem: (id) => set((s) => T.togglePlacement(s, id, openMemoryFor(s, id), viewport())),
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
            set((s) => T.openFromMemory(s, id, openMemoryFor(s, id), viewport()))
            return
          case 'reveal':
            requestFocusOnOpen(id)
            if (action.how === 'float-front') {
              set((s) => T.focusFloat(s, id))
              return
            }
            {
              // 取成局部量再判:闭包里读 `action.side` 拿不到收窄(TS 只对本地
              // const 保得住),而这两句正好都在闭包里。
              const side = action.side
              if (side === null) return
              // 先点名 tab(已经是活动的就是恒等变换,zustand 连订阅都不推),
              // 收着的再展开 —— 细梁上一个 tab 的内容都不画,所以两件事都要做。
              set((s) => T.activateShelfTab(s, side, id))
              if (action.how === 'shelf-expand') set((s) => T.toggleShelfCollapsed(s, side))
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
      closeToDock: (id) => set((s) => T.closeToDock(s, id)),
      closeStage: () => set(T.closeStage),
      closeCover: () => set(T.closeCover),
      /*
       * 「接住了没有」由**形态机**回答,不由宿主再判一次:问它有没有目标、
       * 再让它去收,两句话中间的那一格状态永远有可能不一致。所以这里先取一次
       * 目标(纯查询),据此决定返回值,再让 set 走同一条 escapeTopmost。
       */
      escapeTopmost: (): boolean => {
        // 取当下状态用创建器给的 `get`,不用模块级的 useStageStore ——
        // 那会让这个初始化器**引用它自己**,整个 store 的类型当场塌成 any。
        const caught = T.escapeTargetOf(get()) !== null
        if (caught) set(T.escapeTopmost)
        return caught
      },
      stageToFloat: () => set((s) => T.stageToFloat(s, viewport())),
      stageToEdge: (side) => set((s) => T.stageToEdge(s, side)),
      floatToEdge: (id, side) => set((s) => T.floatToEdge(s, id, side)),
      edgeToFloat: (id) => set((s) => T.edgeToFloat(s, id, viewport())),
      focusFloat: (id) => set((s) => T.focusFloat(s, id)),
      moveFloat: (id, x, y) => set((s) => T.moveFloat(s, id, x, y, viewport())),
      resizeFloat: (id, rect) => set((s) => T.resizeFloat(s, id, rect, viewport())),
      reclampFloats: (vp) => set((s) => T.reclampAll(s, vp)),
      activateShelfTab: (side, id) => set((s) => T.activateShelfTab(s, side, id)),
      toggleShelfCollapsed: (side) => set((s) => T.toggleShelfCollapsed(s, side)),
      closeShelf: (side) => set((s) => T.closeShelf(s, side)),
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
      migrate: T.migrateStagePersisted,
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

