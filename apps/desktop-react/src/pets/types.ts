import type { ComponentType } from 'react'
import type { DeclarativeRigSpec } from '@onething/runtime/pets/rig-spec'

/**
 * 宠物系统壳侧的类型(P0,正本 `docs/design/pet-system-2026-09.md` §2.4 / §2.5 / §7)。
 *
 * P0 不接后端:活动由栖位的宿主算好传进来,话语同样由外部喂。这里的形状就是
 * 那条缝 —— P2 起宿主换成 `pet:` 资源的数据源,`PetStage` 一个字不改。
 */

/**
 * 一个应用的「在场投影」映射到的通用活动词表(§2.4)。
 * `rhythm` 带拍速:形象按 60/bpm 秒一拍点头。
 */
export type PetActivity =
  | 'off'
  | 'busy'
  | { readonly kind: 'rhythm'; readonly bpm: number }
  | 'still'
  | 'fault'
  | 'idle'

/**
 * 姿势 —— §7.2 那张优先级表的九行,各一个名字。**算出来,不存**(`pose.ts`)。
 * 与产品层声明式形象的 `RigPose` 逐字相同(`rigs/__tests__/declarative-rig.test.tsx` 钉住)。
 *
 *   petted     正在被撸
 *   dizzy      fault
 *   sleeping   off
 *   speaking   开口中(字还在出)
 *   busy       翻唱片堆
 *   listening  你在打字
 *   dozing     still 满 9s
 *   grooving   rhythm
 *   sitting    still 未满 9s / idle
 */
export type PoseState =
  | 'petted'
  | 'dizzy'
  | 'sleeping'
  | 'speaking'
  | 'busy'
  | 'listening'
  | 'dozing'
  | 'grooving'
  | 'sitting'

/** 一次性动画(§2.5)。`twitch` = 开口中被点,只抖一下左耳。 */
export type PetOneShot = 'squish' | 'startle' | 'wake' | 'love' | 'twitch'

/** 形象吃的全部输入。形象是纯展示:没有计时器、不接手势。 */
export interface PetRigProps {
  pose: PoseState
  /** rhythm 时的秒/拍;其余姿势缺席。 */
  beat?: number
  mouth: 'closed' | 'talking'
  /** 最近一次一次性动画。同一种再来一次时,舞台先撤一帧再给(重播靠换值)。 */
  oneShot?: PetOneShot
}

export type PetRig = ComponentType<PetRigProps>

/**
 * 形象从哪来(P5 §12.3):手画形象的 id(查 `rigs/index.ts`),或一份声明式形象(交给
 * `DeclarativeRig`)。后者由 `pet:` 的 `roster` 读法整份交来。
 */
export type PetRigSource = string | DeclarativeRigSpec

/** 栖位尺寸(§2.5):大场景 / 角落小图。 */
export type PerchSize = 'stage' | 'corner'

/** 气泡上的一颗选项(话语带 `choices`)。 */
export interface PetChoice {
  value: string
  label: string
}

/** 常驻气泡上的动作按钮。 */
export interface PetAction {
  label: string
  onSelect: () => void
}

/**
 * 一句话语(P0 形)。**新对象身份 = 新话语**:舞台按引用认人,同一个对象再传一次
 * 不会重播。
 */
export interface PetUtterance {
  /** 开口 = 有声波、逐字、点亮 ON AIR;嘀咕 = 整句冒字。 */
  mode: 'speak' | 'mutter'
  text: string
  /** 开口出完字后出现的选项;选择 / Esc 回调宿主。 */
  choices?: readonly PetChoice[]
  /** 常驻:不自己消失,只有宿主清掉(传 `null`)或按动作按钮才走。 */
  sticky?: boolean
  actions?: readonly PetAction[]
  /** 停留时长(嘀咕;开口出完字之后的停留)。缺席走 §7.4 的缺省。 */
  holdMs?: number
}

/** 手势通知(§7.3 表尾:P2 起宿主转成 `pet:` 的做法)。 */
export interface PetGesture {
  kind: 'poke' | 'stroke'
}
