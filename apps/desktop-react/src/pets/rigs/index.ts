import type { PetRig } from '../types'
import { HeidouRig } from './heidou/HeidouRig'

/**
 * **形象注册表**:manifest 里的 `rig` id → 壳侧组件。加一种形象 = 这里一行。
 * 舞台只读这张表,不认识任何一只宠物(§2.5)。
 */
const RIGS: Readonly<Record<string, PetRig>> = {
  'heidou-svg': HeidouRig,
}

export function rigFor(id: string): PetRig | undefined {
  return RIGS[id]
}
