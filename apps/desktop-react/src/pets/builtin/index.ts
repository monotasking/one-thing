import type { PetManifest } from '../manifest'
import { HEIDOU } from './heidou'

/**
 * **内置宠物名册**。加一只 = 这里一行 + `rigs/index.ts` 一行。
 * P2 起名册由 `pet:` 资源的 `roster` 读法交来,这张表随之搬进 runtime。
 */
export const BUILTIN_PETS: readonly PetManifest[] = [HEIDOU]

export function findBuiltinPet(id: string): PetManifest | undefined {
  return BUILTIN_PETS.find((pet) => pet.id === id)
}
