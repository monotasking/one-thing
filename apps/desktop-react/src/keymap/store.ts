import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import * as T from './transitions'
import type { ComboConflict } from './commands'
import type { Combo, CommandId, KeymapPlatform, KeymapState } from './types'

interface KeymapStore extends KeymapState {
  /**
   * 绑一个组合。成功回 null,规则不许的共键回**撞的是谁 + 哪一条规则** ——
   * 冲突不静默覆盖,所以这个 action 有返回值(store 里唯一一个)。
   * 规则本身在 `keymap/commands.comboConflictBetween`,出厂表自己也得过。
   */
  bind: (id: CommandId, combo: Combo) => ComboConflict | null
  unbind: (id: CommandId) => void
  reset: (id: CommandId) => void
}

/**
 * 和 stage / expose / toc 的 store 一样:只是 transitions 的一层壳。
 * 逻辑不许写在这里 —— 写在这里就测不到了。
 *
 * 自己一个持久化槽('onething.keymap'),不搭 stage 的车:
 * 键位是用户的手,Dock 形状是用户的桌面,两件事不该被同一次迁移绑在一起。
 */
export const useKeymapStore = create<KeymapStore>()(
  persist(
    (set, get) => ({
      ...T.initialKeymapState,

      bind: (id, combo) => {
        const result = T.bindCombo(get(), id, combo)
        if ('conflict' in result) return result.conflict
        set({ overrides: result.ok.overrides })
        return null
      },
      unbind: (id) => set((s) => T.unbindCombo(s, id)),
      reset: (id) => set((s) => T.resetCombo(s, id)),
    }),
    {
      name: 'onething.keymap',
      version: T.KEYMAP_PERSIST_VERSION,
      storage: createJSONStorage(() => localStorage),
      migrate: T.migrateKeymapPersisted,
      // 只存覆盖。出厂默认不进档案 —— 存了的话改默认值就再也推不到老用户身上。
      partialize: (s) => ({ overrides: s.overrides }),
    },
  ),
)

/**
 * 「这是什么机器」是宿主的事实,不是注册表的 —— transitions 一行都不许读 navigator,
 * 所以在这里量一次递进去。
 */
export function currentKeymapPlatform(): KeymapPlatform {
  return T.platformOf(typeof navigator === 'undefined' ? '' : navigator.userAgent)
}
