import type { MessageKey } from '../i18n'

/**
 * **一只宠物的自述**(壳侧 P0 形,正本 §2.1)。纯数据。
 *
 * P2 起它的正本搬到 `packages/onething-runtime/src/pets/`,壳侧读 `pet:` 资源交来的那份;
 * 到那时台词从 i18n 键换成字面文本(插件宠物带不进壳的字典),形状其余不变。
 *
 * 陌生能力演练(仓根 09-02 法):加一只鹦鹉 = `builtin/parrot.ts` 一份这个 +
 * `rigs/parrot/` 一个形象 + `builtin/index.ts` 与 `rigs/index.ts` 各一行。
 * `PetStage` / `pose.ts` 里不出现任何一只宠物的名字。
 */

/** 嘀咕台词按**通用反应**分组,不按应用分(§2.1)。 */
export type ReactionGroup =
  | 'poked'
  | 'waiting'
  | 'busy'
  | 'sleepy'
  | 'dizzy'
  | 'annoyed'
  | 'stroked'
  | 'strokedAsleep'
  | 'woke'
  | 'liked'

export const REACTION_GROUPS: readonly ReactionGroup[] = [
  'poked',
  'waiting',
  'busy',
  'sleepy',
  'dizzy',
  'annoyed',
  'stroked',
  'strokedAsleep',
  'woke',
  'liked',
]

/** 一句嘀咕。`holdMs` 缺席走 §7.4 的 1.4–1.8s。 */
export interface MutterLine {
  key: MessageKey
  holdMs?: number
}

export interface PetManifest {
  id: string
  name: MessageKey
  /** 形象 id,壳侧按它查 `rigs/index.ts`。 */
  rig: string
  /** 每组至少一句。 */
  mutters: Readonly<Record<ReactionGroup, readonly MutterLine[]>>
}
