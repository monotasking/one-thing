/**
 * `pet:` 这一 scheme 的实现(自述在 `@onething/runtime/pets/resource-spec`,正本
 * `docs/design/pet-system-2026-09.md` §9.3)。
 *
 * 读 / 做都转给 `PetsSubsystem`,这里只管三件事:地址对不对、参数对不对、结果怎么交。
 * 与 `music` provider 同形 —— 自述在产品层,实现在装配层,因为只有这里够得着宿主那一台
 * 宠物子系统。
 *
 * ── 地址 ────────────────────────────────────────────────────────────────
 * 唯一的单例 `pet:current`。`ref` 缺席照常(内核对 ref 只查 scheme);给了别的路径当场说不。
 *
 * ── 参数校验在 `plan` 里抛 ──────────────────────────────────────────────
 * 与 `music` 那一段同一条理由:一次参数不成立的调用在账本上该是 `failed`,不是一次「成功
 * 地什么都没做」。`adopt` 的未知 id 也在这里抛(§9.3「未知 id 当场拒绝」)。
 *
 * ── `say` 被预算挡掉不抛 ───────────────────────────────────────────────
 * §9.3:「被预算挡掉时回执里说原因,不抛」。挡掉是宠物的规矩在正常工作,不是这次调用出错:
 * 回执是 `{ said: false, reason }`,管线落 `ok`。
 *
 * ── 事件 ────────────────────────────────────────────────────────────────
 * `attach(hub)` 把 hub 交给子系统,话语与手势事实都经它发。`ResourceProvider` 没有 detach
 * 钩子,所以登记方在注销后调 `dispose()` 撤掉那只 hub(与 `todo` / `music` 同一条)。
 */

import { planFromSpec } from '@onething/core/resource'
import type { ResourceEventHub, ResourceProvider, ResourceReadContext, ResourceRef } from '@onething/core/resource'
import { textResult, type Intent, type PlanContext, type Result, type RunContext } from '@onething/core/toolkit'
import { PET_CURRENT_PATH, petResourceSpec } from '@onething/runtime/pets/resource-spec'
import { UnknownPetError, type PetsSubsystem } from '../pets/subsystem.js'

export type PetOpPayload =
  | { readonly op: 'adopt'; readonly id: string }
  | { readonly op: 'say'; readonly mode: 'speak' | 'mutter'; readonly text: string }
  | { readonly op: 'poke' }
  | { readonly op: 'stroke' }

export class PetRefError extends Error {
  constructor(path: string) {
    super(`The pet resource has one address, "pet:${PET_CURRENT_PATH}" (got "pet:${path}")`)
    this.name = 'PetRefError'
  }
}

export class PetParamError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PetParamError'
  }
}

function assertCurrent(ref: ResourceRef | null): void {
  if (ref && ref.path && ref.path !== PET_CURRENT_PATH) throw new PetRefError(ref.path)
}

function record(params: unknown): Record<string, unknown> {
  return params && typeof params === 'object' ? (params as Record<string, unknown>) : {}
}

export class PetResourceProvider implements ResourceProvider<PetOpPayload> {
  readonly spec = petResourceSpec

  constructor(private readonly pets: PetsSubsystem) {}

  attach(hub: ResourceEventHub): void {
    this.pets.attachEvents(hub)
  }

  /** 撤掉 hub(登记方在注销后调)。 */
  dispose(): void {
    this.pets.attachEvents(undefined)
  }

  async read(name: string, ref: ResourceRef | null, _query: unknown, _ctx: ResourceReadContext): Promise<unknown> {
    assertCurrent(ref)
    switch (name) {
      case 'roster':
        return { pets: this.pets.listPets() }
      case 'current':
        return this.pets.current()
      default:
        throw new TypeError(`Pet resource has no read named ${JSON.stringify(name)}`)
    }
  }

  async plan(op: string, ref: ResourceRef | null, params: unknown, _ctx: PlanContext): Promise<Intent<PetOpPayload>> {
    assertCurrent(ref)
    const input = record(params)
    switch (op) {
      case 'adopt': {
        const id = input.id
        if (typeof id !== 'string' || !id) throw new PetParamError('adopt needs an "id" from the roster read')
        if (!this.pets.roster.get(id)) throw new UnknownPetError(id)
        return planFromSpec<PetOpPayload>(this.spec, op, ref, { op, id }, { title: `Adopt the pet ${id}` })
      }
      case 'say': {
        const mode = input.mode
        const text = input.text
        if (mode !== 'speak' && mode !== 'mutter') throw new PetParamError('say needs "mode": "speak" or "mutter"')
        if (typeof text !== 'string' || !text.trim()) throw new PetParamError('say needs a non-empty "text"')
        return planFromSpec<PetOpPayload>(this.spec, op, ref, { op, mode, text }, { title: 'Make the pet say one line' })
      }
      case 'poke':
      case 'stroke':
        return planFromSpec<PetOpPayload>(this.spec, op, ref, { op })
      default:
        throw new TypeError(`Pet resource has no op named ${JSON.stringify(op)}`)
    }
  }

  async apply(_op: string, intent: Intent<PetOpPayload>, _ctx: RunContext): Promise<Result> {
    const payload = intent.payload
    switch (payload.op) {
      case 'adopt':
        return textResult(JSON.stringify({ pet: await this.pets.adopt(payload.id) }))
      case 'say':
        return textResult(JSON.stringify(await this.pets.say(payload.mode, payload.text)))
      case 'poke':
        this.pets.gesture('poked')
        return textResult(JSON.stringify({ ok: true }))
      case 'stroke':
        this.pets.gesture('stroked')
        return textResult(JSON.stringify({ ok: true }))
    }
  }
}
