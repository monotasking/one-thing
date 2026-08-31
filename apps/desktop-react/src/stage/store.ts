import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { STAGE_ITEMS, findItem } from './items'
import * as T from './transitions'
import type { Locale } from '../i18n'
import type {
  DockAlign,
  DockDisplay,
  DockEdge,
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

interface StageStore extends StageState, StageSettings {
  items: StageItemSpec[]
  dockDisplay: DockDisplay

  /** 落点由 resolveOpen 解析(记忆 > 全局默认档);要点名落点的走 openAs。 */
  clickDockIcon: (id: string) => void
  /** 显式手势那一层:点名放到哪儿。它既执行也写记忆(记忆在 transitions 的 openAs 里落)。 */
  openAs: (id: string, placement: Placement) => void
  /** 快捷键用的开关语义:在 Dock 里就按打开方式开,在别处就收回 Dock。 */
  toggleItem: (id: string) => void
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
  activateShelfTab: (side: ShelfSide, id: string) => void
  toggleShelfCollapsed: (side: ShelfSide) => void
  closeShelf: (side: ShelfSide) => void
  setShelfThickness: (side: ShelfSide, thickness: number) => void
  setDockDisplay: (d: DockDisplay) => void
  setDockEdge: (e: DockEdge) => void
  setDockAlign: (a: DockAlign) => void
  setDockSize: (z: DockSize) => void
  setDefaultOpen: (d: ResolvedOpen) => void
  setLocale: (l: Locale) => void
  /** 「所有应用」那块管理瓦上的一行开关:这块瓦在 Dock 上露不露面。 */
  setItemHidden: (id: string, hidden: boolean) => void
}

/**
 * 视口是宿主的事实,不是形态机的 —— transitions 一行都不许读 window,
 * 所以「当下多大」在这里量一次递进去。
 */
function viewport(): Viewport {
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
    (set, get) => ({
      ...T.initialStageState,
      ...T.initialStageSettings,
      items: STAGE_ITEMS,
      dockDisplay: 'always',

      clickDockIcon: (id) => set((s) => T.clickDockIcon(s, id, openMemoryFor(s, id), viewport())),
      openAs: (id, placement) => set((s) => T.openAs(s, id, placement, viewport())),
      toggleItem: (id) => set((s) => T.togglePlacement(s, id, openMemoryFor(s, id), viewport())),
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
    }),
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
        // 旧档案里没有这一格(它是本批新加的),缺席就该是空表而不是 undefined ——
        // 一个 undefined 会让 Dock 的投影在第一帧上抛。不写迁移段的理由也在这里:
        // 「缺席读作空」本身就是这一格的语义,不需要翻译。
        merged.hiddenItems = Array.isArray(merged.hiddenItems) ? merged.hiddenItems : []
        return merged
      },
      // 持久化设置 + 工作台(架子与浮窗是用户摆好的,理应留着);舞台那条在存盘前摘掉。
      partialize: (s) => ({
        dockDisplay: s.dockDisplay,
        dockEdge: s.dockEdge,
        dockAlign: s.dockAlign,
        dockSize: s.dockSize,
        hiddenItems: s.hiddenItems,
        placements: T.withoutTransientPlacements(s.placements),
        floats: s.floats,
        floatOrder: s.floatOrder,
        shelves: s.shelves,
        // 记忆比工作台活得久:舞台那条存盘要摘,它的记忆却要留 —— 下次点开还去舞台。
        memory: s.memory,
        defaultOpen: s.defaultOpen,
        locale: s.locale,
      }),
    },
  ),
)
