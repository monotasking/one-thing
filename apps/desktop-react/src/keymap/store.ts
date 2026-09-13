import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import * as T from './transitions'
import { mergeKeymapPersisted } from './persisted'
import type { ComboConflict } from './commands'
import type { KeymapProfile } from './profiles'
import type { Combo, CommandId, KeymapPlatform, KeymapState } from './types'

interface KeymapStore extends KeymapState {
  /**
   * 绑一个组合。成功回 null,规则不许的共键回**撞的是谁 + 哪一条规则** ——
   * 冲突不静默覆盖,所以这个 action 有返回值(store 里唯一一个)。
   * 规则本身在 `keymap/commands.comboConflictBetween`,出厂表自己也得过。
   *
   * K5 起它是**追加一个键面**(判词在 `transitions.bindCombo` 上)。
   */
  bind: (id: CommandId, combo: Combo) => ComboConflict | null
  /** 删掉一个键面(设置页每枚键帽尾巴上那颗 ×)。 */
  removeCombo: (id: CommandId, combo: Combo) => void
  unbind: (id: CommandId) => void
  reset: (id: CommandId) => void
  /** 换一组。覆盖层一个字不动 —— 「换组不丢手」。 */
  setProfile: (profileId: string) => void
  /** 收一个导入进来的组(同 id 覆盖),并当场切过去。 */
  addUserProfile: (profile: KeymapProfile) => void
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
      removeCombo: (id, combo) => set((s) => T.removeCombo(s, id, combo)),
      unbind: (id) => set((s) => T.unbindCombo(s, id)),
      reset: (id) => set((s) => T.resetCombo(s, id)),
      setProfile: (profileId) => set((s) => T.setProfile(s, profileId)),
      addUserProfile: (profile) => set((s) => T.addUserProfile(s, profile)),
    }),
    {
      name: 'onething.keymap',
      version: T.KEYMAP_PERSIST_VERSION,
      storage: createJSONStorage(() => localStorage),
      migrate: T.migrateKeymapPersisted,
      // 存档是不可信输入:每次水合按形状归一,不看版本号(09-13 半迁存档事故,见 persisted.ts)。
      merge: mergeKeymapPersisted,
      /*
       * 只存**用户自己的东西**:逐格覆盖、当下选的是哪一组(K5)、他导入进来的
       * 那几组。内置三组是代码不是数据(存了的话改内置组的键就再也推不到老用户
       * 身上,与「出厂默认不进档案」逐字同一条判词)。
       *
       * 这三格与 `mergeKeymapPersisted` 收的那三格**必须一一对上** —— 存了却不收
       * 就是「设置里换了组,重启回出厂」,而那种病没有任何报错。
       */
      partialize: (s) => ({
        overrides: s.overrides,
        profileId: s.profileId,
        userProfiles: s.userProfiles,
      }),
    },
  ),
)

/**
 * 这块面要读的**整份键位状态**(K5)。
 *
 * 从前各处写的是 `useKeymapStore((st) => st.overrides)` 再手搭一个 `{ overrides }`
 * —— 那在只有一层的时候是对的,三层之后就少读了两格:**换一组之后那些行不会重画**。
 * 三次独立订阅(每一格都是稳定引用)而不是一次返回新对象的选择器:后者每次渲染
 * 都是一个新身份,`useSyncExternalStore` 会当成一直在变。
 */
export function useKeymapState(): KeymapState {
  const overrides = useKeymapStore((st) => st.overrides)
  const profileId = useKeymapStore((st) => st.profileId)
  const userProfiles = useKeymapStore((st) => st.userProfiles)
  return { overrides, profileId, userProfiles }
}

/**
 * 「这是什么机器」是宿主的事实,不是注册表的 —— transitions 一行都不许读 navigator,
 * 所以在这里量一次递进去。
 */
export function currentKeymapPlatform(): KeymapPlatform {
  return T.platformOf(typeof navigator === 'undefined' ? '' : navigator.userAgent)
}
