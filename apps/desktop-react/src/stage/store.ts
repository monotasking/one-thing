import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { STAGE_ITEMS } from './items'
import * as T from './transitions'
import type { Locale } from '../i18n'
import type {
  DockDisplay,
  OpenBehavior,
  ResolvedOpen,
  StageItemSpec,
  StageSettings,
  StageState,
} from './types'

interface StageStore extends StageState, StageSettings {
  items: StageItemSpec[]
  dockDisplay: DockDisplay

  /** 不给 behavior = 按设置解析;给了 = 调用方明确指定(菜单里的「设置…」就走这条)。 */
  clickDockIcon: (id: string, behavior?: ResolvedOpen) => void
  pinStage: () => void
  unpin: (id: string) => void
  activatePinnedTab: (id: string) => void
  closeStage: () => void
  setPinnedWidth: (w: number, viewport: number) => void
  setDockDisplay: (d: DockDisplay) => void
  setDefaultOpen: (d: ResolvedOpen) => void
  setOpenOverride: (id: string, v: OpenBehavior) => void
  setLocale: (l: Locale) => void
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
        set((s) => T.clickDockIcon(s, id, behavior ?? T.resolveOpen(id, s.openOverrides, s.defaultOpen))),
      pinStage: () => set(T.pinStage),
      unpin: (id) => set((s) => T.unpin(s, id)),
      activatePinnedTab: (id) => set((s) => T.activatePinnedTab(s, id)),
      closeStage: () => set(T.closeStage),
      setPinnedWidth: (w, viewport) => set((s) => T.setPinnedWidth(s, w, viewport)),
      setDockDisplay: (dockDisplay) => set({ dockDisplay }),
      setDefaultOpen: (defaultOpen) => set({ defaultOpen }),
      setOpenOverride: (id, v) => set((s) => ({ openOverrides: { ...s.openOverrides, [id]: v } })),
      setLocale: (locale) => set({ locale }),
    }),
    {
      name: 'onething.stage',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      migrate: T.migrateStagePersisted,
      // 持久化设置 + 钉栏(钉栏是用户摆好的工作台,理应留着);舞台不持久化,重开从收拢态开始。
      partialize: (s) => ({
        dockDisplay: s.dockDisplay,
        pinnedWidth: s.pinnedWidth,
        pinned: s.pinned,
        activePinnedId: s.activePinnedId,
        defaultOpen: s.defaultOpen,
        openOverrides: s.openOverrides,
        locale: s.locale,
      }),
    },
  ),
)
