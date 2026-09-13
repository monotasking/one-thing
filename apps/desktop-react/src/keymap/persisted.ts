import { DEFAULT_KEYMAP_PROFILE_ID } from './profiles'
import type { KeymapProfile } from './profiles'
import type { Combo, KeymapState } from './types'

/**
 * 键位存档的**形状归一**(2026-09-13)。
 *
 * ── 为什么要有这一层,而版本迁移(`transitions.migrateKeymapPersisted`)不够 ──
 * 迁移阶梯是**按版本号**走的:存档写着 `version: 4` 就一段都不跑。09-13 真机上
 * 挖出来的存档正是这一形:六条覆盖每格都是 v2 的单个 `Combo`,版本号却已是 4 ——
 * 09-12 11:35 K0 在用户正跑着的检出上分两步改 `transitions.ts`(先动版本号、十四秒
 * 后才加「包成数组」那段),Vite HMR 在两步之间重跑了 store,persist 用新版本号把
 * **没迁的数据**回写了。从那一刻起阶梯永远跳过 v3,`effectiveCombos` 回一个对象,
 * `lookupCommands` 的 `for…of` 在每一次带修饰键的按键上抛
 * `effectiveCombos is not a function or its return value is not iterable`。
 *
 * 版本号说的是「写它的代码是哪一版」,而写它的代码可以是半改的;所以**存档是不可信
 * 输入**,每一次水合都按形状归一一遍,不看版本号 —— 与 `workspace/store` 的
 * `shelfRail` 白名单归一同一条判词(「merge 白名单归一不加迁移版本」)。
 *
 * 归一只认三种格:`null`(用户显式解绑,原样留)、数组(v3 起的正形,原样留)、
 * 带 `key` 的单个对象(v2 的旧形,包成一格数组)。其余一律丢:一格读不懂的覆盖
 * 落到出厂值,好过整张表在一次按键上炸掉。
 *
 * ── K5:存档里多了**键位组**那两格,它们走同一条判词 ────────────────────
 * `profileId`(当下是哪一组)与 `userProfiles`(导入进来的那几组)同样是不可信
 * 输入,所以同样在这里归一:组 id 不是串就当他没换过组;一份组里那张 `bindings`
 * 与 `overrides` **是同一种表**,所以它逐字复用 `normalizeKeymapOverrides` ——
 * 一份手写的 / 半迁的组文件不该比一份半迁的覆盖表更有特权。
 */
function isCombo(value: unknown): value is Combo {
  return typeof value === 'object' && value !== null && typeof (value as { key?: unknown }).key === 'string'
}

export function normalizeKeymapOverrides(raw: unknown): KeymapState['overrides'] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: KeymapState['overrides'] = {}
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null) out[id] = null
    else if (Array.isArray(value)) out[id] = value.filter(isCombo)
    else if (isCombo(value)) out[id] = [value]
  }
  return out
}

/**
 * 一组导入进来的键位组归一。读不出 id / 名字的整份丢(一个没有身份的组进了表
 * 就再也选不中、删不掉);`bindings` 与 `overrides` 同一种表,同一只归一。
 */
function normalizeUserProfile(raw: unknown): KeymapProfile | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const row = raw as { id?: unknown; name?: unknown; bindings?: unknown }
  if (typeof row.id !== 'string' || row.id === '') return null
  if (typeof row.name !== 'string' || row.name === '') return null
  return { id: row.id, name: row.name, bindings: normalizeKeymapOverrides(row.bindings) }
}

export function normalizeUserProfiles(raw: unknown): KeymapProfile[] {
  if (!Array.isArray(raw)) return []
  const out: KeymapProfile[] = []
  for (const row of raw) {
    const profile = normalizeUserProfile(row)
    /* **内置那三个 id 不许被存档顶掉**(导入那一侧已经保证了,这里再挡一道:
     * 存档是不可信输入,而一份顶掉 `default` 的组会让「回到出厂」这条路没了)。 */
    if (profile && profile.id.startsWith('user:')) out.push(profile)
  }
  return out
}

/**
 * persist 的 `merge`:存档带进来的只有**用户自己的东西**那三格
 * (`overrides` / `profileId` / `userProfiles`,与 `store.ts` 的 `partialize`
 * 一一对上),其余一律以当前实例为准。
 */
export function mergeKeymapPersisted<S extends KeymapState>(persisted: unknown, current: S): S {
  const row =
    typeof persisted === 'object' && persisted !== null
      ? (persisted as { overrides?: unknown; profileId?: unknown; userProfiles?: unknown })
      : {}
  return {
    ...current,
    overrides: normalizeKeymapOverrides(row.overrides),
    profileId: typeof row.profileId === 'string' ? row.profileId : DEFAULT_KEYMAP_PROFILE_ID,
    userProfiles: normalizeUserProfiles(row.userProfiles),
  }
}
