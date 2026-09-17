/**
 * 宠物名册(宠物 P2,§9.1「内置宠物一张表」)。
 *
 * 是一个类而不是一只模块级数组:P5 插件宠物要往里登记、卸载时要摘,而「谁要一本名册
 * 谁自己 new 一本」与资源注册表(`@onething/core/resource` 的 `ResourceRegistry`)同一条
 * 组合根纪律 —— 装配层把它当字段持有,测试起一本干净的。
 *
 * 陌生能力演练:加一只鹦鹉 = `builtin/alu.ts` 一份自述(形象是 `alu.rig.ts` 的数据)+
 * `BUILTIN_PETS` 一行(P5 真的这样加了一只)。`host.ts` / 装配层里不出现任何一只宠物的名字。
 *
 * ── 形象有问题的宠物不进名册(§12.2 末)──────────────────────────────────
 * 构造时交来的一批(内置名册)里,`petManifestProblems` 答出问题的那只**跳过** —— 不让一份
 * 画错的数据把整个宿主的装配拖垮;内置宠物画错由单测兜住(`rig-spec.test.ts`)。
 * 单独 `register` 一只画错的是调用方的错,当场抛 `PetRigInvalidError`。
 */

import { ALU } from './builtin/alu.js'
import { HEIDOU } from './builtin/heidou.js'
import { petManifestProblems, type PetManifest } from './manifest.js'
import type { RigSpecProblem } from './rig-spec.js'

/** 内置宠物。**第一只就是缺省那一只**(没有 `current.json` 时领养它)。 */
export const BUILTIN_PETS: readonly PetManifest[] = [HEIDOU, ALU]

export class PetRigInvalidError extends Error {
  constructor(readonly petId: string, readonly problems: readonly RigSpecProblem[]) {
    super(`Pet ${petId} has an invalid rig: ${problems.map(p => `${p.path}: ${p.message}`).join('; ')}`)
    this.name = 'PetRigInvalidError'
  }
}

export class PetIdTakenError extends Error {
  constructor(readonly petId: string) {
    super(`Pet id already registered: ${petId}`)
    this.name = 'PetIdTakenError'
  }
}

export class PetRegistry {
  private readonly pets = new Map<string, PetManifest>()

  constructor(manifests: readonly PetManifest[] = BUILTIN_PETS) {
    for (const manifest of manifests) {
      if (petManifestProblems(manifest).length === 0) this.register(manifest)
    }
  }

  /** 登记一只。重复 id / 形象有问题是装配错误,当场抛。返回幂等注销(身份判等)。 */
  register(manifest: PetManifest): () => void {
    if (this.pets.has(manifest.id)) throw new PetIdTakenError(manifest.id)
    const problems = petManifestProblems(manifest)
    if (problems.length > 0) throw new PetRigInvalidError(manifest.id, problems)
    const frozen = Object.freeze(manifest)
    this.pets.set(frozen.id, frozen)
    return () => {
      if (this.pets.get(frozen.id) === frozen) this.pets.delete(frozen.id)
    }
  }

  get(id: string): PetManifest | null {
    return this.pets.get(id) ?? null
  }

  /** 登记顺序。第一只是缺省。 */
  list(): readonly PetManifest[] {
    return [...this.pets.values()]
  }

  /** 缺省那一只:名册里的第一只。名册空了是装配错误。 */
  fallback(): PetManifest {
    const first = this.pets.values().next()
    if (first.done) throw new Error('Pet registry is empty')
    return first.value
  }
}
