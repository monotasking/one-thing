import type { PetManifest } from '../manifest'

/**
 * **阿绿** —— 第二只宠物,一只绿鹦鹉(宠物 P5,正本 §12.3)。
 *
 * 话少、爱学舌。这里只有壳本地的那一半:名字与台词的字典键、卡片上的一句人设。
 * **形象不在这里**:它是产品层的一份声明式数据(`@onething/runtime/pets/builtin/alu.rig`),
 * 由 `pet:` 的 `roster` 读法交来 —— 所以没有 `rig` 这一格,壳侧也没有阿绿的组件。
 */
const HOLD_MS = 1_400
const STROKE_HOLD_MS = 1_800

export const ALU: PetManifest = {
  id: 'alu',
  name: 'pet.alu.name',
  blurb: 'pet.alu.blurb',
  mutters: {
    poked: [
      { key: 'pet.alu.poked1', holdMs: HOLD_MS },
      { key: 'pet.alu.poked2', holdMs: HOLD_MS },
    ],
    waiting: [{ key: 'pet.alu.waiting1', holdMs: HOLD_MS }],
    busy: [{ key: 'pet.alu.busy1', holdMs: HOLD_MS }],
    sleepy: [{ key: 'pet.alu.sleepy1', holdMs: HOLD_MS }],
    dizzy: [{ key: 'pet.alu.dizzy1', holdMs: HOLD_MS }],
    annoyed: [{ key: 'pet.alu.annoyed1' }],
    stroked: [{ key: 'pet.alu.stroked1', holdMs: STROKE_HOLD_MS }],
    strokedAsleep: [{ key: 'pet.alu.strokedAsleep1', holdMs: STROKE_HOLD_MS }],
    woke: [{ key: 'pet.alu.woke1' }],
    liked: [{ key: 'pet.alu.liked1' }],
  },
}
