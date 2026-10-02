/**
 * **开口频率三档**(宠物 P5,正本 `docs/design/pet-system-2026-09.md` §12.4)。纯数据。
 *
 * 设置键 `pets.chattiness`。一档 = 一行表,宿主只读表(`PetHost.onMoment`),不按档名分支:
 *
 *   · `quiet`    —— 冷却 ∞:`normal` / `high` 时刻都不开口,只记账(`cooldown`)。电台认领
 *                   (`claim`)与 `say` 做法不受影响 —— 那是节目和人明确要它说;
 *   · `balanced` —— 240s 冷却,即 P2 起的缺省;
 *   · `chatty`   —— 90s 冷却,且 `low` 时刻里名字在 `lowEventsThatSpeak` 那一列的(`liked`)
 *                   也当 `normal` 走,仍按 90s 冷却。
 *
 * `lowEventsThatSpeak` 是**事件名**,不带 scheme:哪种资源发 `liked`,这里不认识。
 */

export const PET_CHATTINESS_LEVELS = ['quiet', 'balanced', 'chatty'] as const
export type PetChattiness = (typeof PET_CHATTINESS_LEVELS)[number]

export const PET_DEFAULT_CHATTINESS: PetChattiness = 'balanced'

export interface PetChattinessProfile {
  /** 两次开口之间至少隔多久。`Infinity` = 时刻永远不开口。 */
  readonly cooldownMs: number
  /** `low` 时刻里,这些事件名当 `normal` 走。 */
  readonly lowEventsThatSpeak: readonly string[]
}

export const PET_CHATTINESS: Readonly<Record<PetChattiness, PetChattinessProfile>> = {
  quiet: { cooldownMs: Number.POSITIVE_INFINITY, lowEventsThatSpeak: [] },
  balanced: { cooldownMs: 240_000, lowEventsThatSpeak: [] },
  chatty: { cooldownMs: 90_000, lowEventsThatSpeak: ['liked'] },
}

/** 设置里读出来的值归一:不认识的一律缺省档。 */
export function normalizePetChattiness(value: unknown): PetChattiness {
  return (PET_CHATTINESS_LEVELS as readonly unknown[]).includes(value) ? (value as PetChattiness) : PET_DEFAULT_CHATTINESS
}
