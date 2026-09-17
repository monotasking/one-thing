/**
 * **一只宠物的自述**(宠物 P2,正本 `docs/design/pet-system-2026-09.md` §2.1 / §9.1)。纯数据。
 *
 * ── 为什么这里没有嘀咕台词 ──────────────────────────────────────────────────
 * §2.1 那张表里有 `mutters`,§9.1 把它划出去了:嘀咕是**壳本地**的 —— 零延迟、不经过
 * 后端、不进 TTS,台词住在壳的 i18n 字典里(`apps/desktop-react/src/pets/builtin/`)。
 * 这份自述只装「开口」要用的东西:它是谁、长什么样(`rig` 由壳按 id 查表)、嗓子怎样、
 * 开口时交给模型的口吻说明。两边靠 `id` 与 `rig` 对上。
 *
 * ── 为什么 `voice` 是描述而不是某家 TTS 的音色 id ──────────────────────────────
 * 出声是 P3 的事,而那时要走哪家语音、哪一个音色,是语音那一层按这份描述去挑。今天
 * 写一个厂商 id 进来,等于让一只宠物的自述认识一家供应商 —— 换一家就要改每一只宠物。
 *
 * 插件交来的宠物(§6 P5 的 `contributes.pet`)用**同一个类型**,所以这里不许出现任何
 * 只有内置宠物才有的格子。
 */

/** 嗓子的描述。三格都是档位词,不是数值:具体换算归 P3 的语音那一层。 */
export interface PetVoice {
  readonly pitch: 'low' | 'medium' | 'high'
  readonly timbre: 'soft' | 'neutral' | 'bright'
  readonly rate: 'slow' | 'normal' | 'slightly-fast' | 'fast'
}

export interface PetManifest {
  /** 标识。账本目录、`current.json`、壳的形象表都按它对。 */
  readonly id: string
  /** 名字(字面文本 —— 插件宠物带不进壳的字典)。 */
  readonly name: string
  /** 形象用哪一套绘制。壳侧按这个 id 查表。 */
  readonly rig: string
  readonly voice: PetVoice
  /** 开口时交给模型的口吻说明(P4 起真的交出去)。 */
  readonly persona: string
}

/** 读法里交出去的那一截:谁、叫什么、长什么样。 */
export interface PetSummary {
  readonly id: string
  readonly name: string
  readonly rig: string
}

export function summarizePet(manifest: PetManifest): PetSummary {
  return { id: manifest.id, name: manifest.name, rig: manifest.rig }
}
