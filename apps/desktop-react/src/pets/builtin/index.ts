import type { PetManifest } from '../manifest'
import { ALU } from './alu'
import { HEIDOU } from './heidou'

/**
 * **内置宠物的壳本地一半**(名字、台词、人设的字典键)。加一只 = 这里一行(手画的另加
 * `rigs/index.ts` 一行)。名册本身(谁能领养、长什么样)由 `pet:` 的 `roster` 读法交来;
 * 这张表只按 id 给那份名册配上本地字典。
 */
export const BUILTIN_PETS: readonly PetManifest[] = [HEIDOU, ALU]

export function findBuiltinPet(id: string): PetManifest | undefined {
  return BUILTIN_PETS.find((pet) => pet.id === id)
}
