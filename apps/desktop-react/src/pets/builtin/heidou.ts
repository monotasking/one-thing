import type { PetManifest } from '../manifest'

/**
 * **黑豆** —— 第一只宠物(样例「黑豆电台」,2026-09-17)。
 *
 * 台词逐字取自样例;点一下那几组停 1.4s、撸完停 1.8s 也是样例的数,其余组走
 * §7.4 的缺省(1.4–1.8s 之间)。
 */
const POKE_HOLD_MS = 1_400
const STROKE_HOLD_MS = 1_800

export const HEIDOU: PetManifest = {
  id: 'heidou',
  name: 'pet.heidou.name',
  rig: 'heidou-svg',
  mutters: {
    poked: [
      { key: 'pet.heidou.poked1', holdMs: POKE_HOLD_MS },
      { key: 'pet.heidou.poked2', holdMs: POKE_HOLD_MS },
      { key: 'pet.heidou.poked3', holdMs: POKE_HOLD_MS },
      { key: 'pet.heidou.poked4', holdMs: POKE_HOLD_MS },
    ],
    waiting: [
      { key: 'pet.heidou.waiting1', holdMs: POKE_HOLD_MS },
      { key: 'pet.heidou.waiting2', holdMs: POKE_HOLD_MS },
    ],
    busy: [
      { key: 'pet.heidou.busy1', holdMs: POKE_HOLD_MS },
      { key: 'pet.heidou.busy2', holdMs: POKE_HOLD_MS },
    ],
    sleepy: [
      { key: 'pet.heidou.sleepy1', holdMs: POKE_HOLD_MS },
      { key: 'pet.heidou.sleepy2', holdMs: POKE_HOLD_MS },
    ],
    dizzy: [{ key: 'pet.heidou.dizzy1', holdMs: POKE_HOLD_MS }],
    annoyed: [{ key: 'pet.heidou.annoyed1' }],
    stroked: [{ key: 'pet.heidou.stroked1', holdMs: STROKE_HOLD_MS }],
    strokedAsleep: [{ key: 'pet.heidou.strokedAsleep1', holdMs: STROKE_HOLD_MS }],
    woke: [{ key: 'pet.heidou.woke1' }],
    liked: [{ key: 'pet.heidou.liked1' }],
  },
}
