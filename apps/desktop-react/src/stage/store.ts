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
  OpenBehavior,
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

  /** 不给 behavior = 按设置解析;给了 = 调用方明确指定(菜单里的「打开方式」就走这条)。 */
  clickDockIcon: (id: string, behavior?: ResolvedOpen) => void
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
  setOpenOverride: (id: string, v: OpenBehavior) => void
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
 * 唯一的「组合」是 clickDockIcon 里先 resolveOpen 再 clickDockIcon,两边都仍是纯函数。
 */
export const useStageStore = create<StageStore>()(
  persist(
    (set) => ({
      ...T.initialStageState,
      ...T.initialStageSettings,
      items: STAGE_ITEMS,
      dockDisplay: 'always',

      clickDockIcon: (id, behavior) =>
        set((s) =>
          T.clickDockIcon(
            s,
            id,
            behavior
              ? T.placementForOpen(behavior)
              : T.resolveOpen(id, s.openOverrides, s.defaultOpen),
            viewport(),
          ),
        ),
      openAs: (id, placement) => set((s) => T.openAs(s, id, placement, viewport())),
      toggleItem: (id) =>
        set((s) => T.togglePlacement(s, id, T.resolveOpen(id, s.openOverrides, s.defaultOpen), viewport())),
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
      setOpenOverride: (id, v) => set((s) => ({ openOverrides: { ...s.openOverrides, [id]: v } })),
      setLocale: (locale) => set({ locale }),
    }),
    {
      name: 'onething.stage',
      version: T.STAGE_PERSIST_VERSION,
      storage: createJSONStorage(() => localStorage),
      migrate: T.migrateStagePersisted,
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
        defaultOpen: s.defaultOpen,
        openOverrides: s.openOverrides,
        locale: s.locale,
      }),
    },
  ),
)
