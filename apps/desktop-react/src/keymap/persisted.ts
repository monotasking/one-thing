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

/** persist 的 `merge`:只有 `overrides` 是存档带进来的,其余一律以当前实例为准。 */
export function mergeKeymapPersisted<S extends KeymapState>(persisted: unknown, current: S): S {
  const raw = typeof persisted === 'object' && persisted !== null ? (persisted as { overrides?: unknown }).overrides : undefined
  return { ...current, overrides: normalizeKeymapOverrides(raw) }
}
