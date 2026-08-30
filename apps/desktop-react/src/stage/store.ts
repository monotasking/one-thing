import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { STAGE_ITEMS } from './items'
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
}

/**
 * 视口是宿主的事实,不是形态机的 —— transitions 一行都不许读 window,
 * 所以「当下多大」在这里量一次递进去。
 */
function viewport(): Viewport {
  return { w: window.innerWidth, h: window.innerHeight }
}

/**
 * store 只是 transitions 的一层壳:每个 action 都是 set(transitions.f)。
 * 逻辑不许写在这里 —— 写在这里就测不到了。
 * 唯一的「组合」是 clickDockIcon / toggleItem 里先 resolveOpen 再落形态,两边都仍是纯函数。
 */
export const useStageStore = create<StageStore>()(
  persist(
    (set) => ({
      ...T.initialStageState,
      ...T.initialStageSettings,
      items: STAGE_ITEMS,
      dockDisplay: 'always',

      clickDockIcon: (id) =>
        set((s) => T.clickDockIcon(s, id, T.resolveOpen(s, id, s.defaultOpen, viewport()), viewport())),
      openAs: (id, placement) => set((s) => T.openAs(s, id, placement, viewport())),
      toggleItem: (id) =>
        set((s) =>
          T.togglePlacement(s, id, T.resolveOpen(s, id, s.defaultOpen, viewport()), viewport()),
        ),
      closeToDock: (id) => set((s) => T.closeToDock(s, id)),
      closeStage: () => set(T.closeStage),
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
        return merged
      },
      // 持久化设置 + 工作台(架子与浮窗是用户摆好的,理应留着);舞台那条在存盘前摘掉。
      partialize: (s) => ({
        dockDisplay: s.dockDisplay,
        dockEdge: s.dockEdge,
        dockAlign: s.dockAlign,
        dockSize: s.dockSize,
        placements: T.withoutStagePlacements(s.placements),
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
