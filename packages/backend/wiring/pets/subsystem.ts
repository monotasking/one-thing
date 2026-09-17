/**
 * **宠物子系统** —— `PetHost` 在装配层的那一半(宠物 P2,正本
 * `docs/design/pet-system-2026-09.md` §2.3 末段、§9.1 / §9.4)。
 *
 * 只做接线,一件不多:
 *   ① 建宿主:读 `current.json` 定是哪一只、读那一只账本尾部 50 行接上记忆;
 *   ② 订资源事件:挂在事件总线上**已经在转发**的 `resource:event` 那一路
 *      (`wiring/resource/event-bridge.ts` 放上去的),不另开订阅口;
 *   ③ 查表:对每条事件问注册表那种资源的自述 `events[event].moment` —— 没声明就忽略,
 *      声明了就折成 `Moment` 喂给宿主;
 *   ④ 收尾:宿主交回的账本行写盘(`ledger-store.ts`),话语作为 `pet:` 的 `utterance`
 *      事件发出去(经 provider 在 `attach` 时交来的那只 hub,于是它照样走 bridge → 总线 →
 *      SSE,与别的资源事实同一条路)。
 *
 * ── 这只文件里一个 scheme 的名字都没有(`pet` 除外)──────────────────────────
 * 哪些事实值得宠物知道,是那种资源自己在自述里说的(`EventSpec.moment`),这里只读表。
 * 加一个会发时刻的应用 = 那个应用的自述里多一格 `moment`,这里一个字不改(§4 陌生能力演练)。
 *
 * ── 为什么喂食是串行的 ─────────────────────────────────────────────────────
 * 总线的投递是同步的,而宿主的 `onMoment` 是异步的(作曲端口可以是模型)。每条时刻排进
 * 一条 promise 链:账本行序 = 事实发生的顺序,`say` 做法也排进同一条链,于是「先来的
 * 那一句先占说话位」对两条入口一视同仁。`settled()` 等链跑完 —— `dispose` 与测试用。
 *
 * ── 自己发的事实会绕回来 ─────────────────────────────────────────────────
 * `pet:` 的事件同样走 bridge → 总线回到这里(§9.4「`pet:` 自己的事件同样走这条路」):
 * `poked` / `stroked` 带 `low` 的 moment,于是它们就是这样进账本的 —— provider 的
 * `poke` 做法只发事件、不自己记账,否则同一下手势会记两行。`utterance` 没有 moment,
 * 绕回来被忽略,不会自激。
 */

import type { ResourceEventHub, ResourceRegistry } from '@onething/core/resource'
import {
  PET_CURRENT_PATH,
  PET_RESOURCE_SCHEME,
  PetHost,
  PetRegistry,
  SayPassthroughComposer,
  summarizePet,
  type Moment,
  type MomentComposer,
  type PetClock,
  type PetCurrentView,
  type PetHostOutcome,
  type PetSummary,
  type Utterance,
} from '@onething/runtime/pets'
import type { EventBus } from '../../events/event-bus.js'
import { getLogger } from '../logging/index.js'
import { PetLedgerStore } from './ledger-store.js'

const log = getLogger('pets')

export class UnknownPetError extends Error {
  constructor(readonly petId: string) {
    super(`No pet with id ${JSON.stringify(petId)}. Read pet:current's roster for the ids you can adopt.`)
    this.name = 'UnknownPetError'
  }
}

export class PetsNotStartedError extends Error {
  constructor() {
    super('The pet subsystem has not started yet')
    this.name = 'PetsNotStartedError'
  }
}

export interface PetsSubsystemOptions {
  /** `<store>/pets`。 */
  readonly dir: string
  /** 这台内核的注册表:查 `events[name].moment` 用。 */
  readonly registry: ResourceRegistry
  /** 已经在转发 `resource:event` 的那条总线。 */
  readonly bus: EventBus
  readonly assertOwned?: () => void
  readonly pets?: PetRegistry
  readonly composer?: MomentComposer
  readonly clock?: PetClock
  readonly cooldownMs?: number
}

/** `say` 的回执:说了什么,或者为什么没说。 */
export type PetSayReceipt =
  | { readonly said: true; readonly utterance: Utterance }
  | { readonly said: false; readonly reason: NonNullable<PetHostOutcome['dropped']> }

export class PetsSubsystem {
  readonly roster: PetRegistry
  private readonly store: PetLedgerStore
  private readonly options: PetsSubsystemOptions
  private host: PetHost | undefined
  private hub: ResourceEventHub | undefined
  private unsubscribe: (() => void) | undefined
  private chain: Promise<unknown> = Promise.resolve()
  private starting: Promise<void> | undefined
  private disposed = false

  constructor(options: PetsSubsystemOptions) {
    this.options = options
    this.roster = options.pets ?? new PetRegistry()
    this.store = new PetLedgerStore(options.dir, options.assertOwned)
  }

  /**
   * 建宿主、订事件。幂等。订阅在读完账本**之后**才挂:还没接上记忆的宿主不该收时刻
   * (冷却会从零算,重启那一刻就可能开口)。
   */
  start(): Promise<void> {
    this.starting ??= (async () => {
      const id = await this.store.readCurrent()
      const manifest = (id ? this.roster.get(id) : null) ?? this.roster.fallback()
      const lines = await this.store.readTail(manifest.id)
      if (this.disposed) return
      this.host = new PetHost({
        pet: manifest,
        composer: this.options.composer ?? new SayPassthroughComposer(),
        lines,
        ...(this.options.clock ? { clock: this.options.clock } : {}),
        ...(this.options.cooldownMs !== undefined ? { cooldownMs: this.options.cooldownMs } : {}),
      })
      this.unsubscribe = this.options.bus.onGlobal('resource:event', envelope => {
        const { ref, event, payload, at } = envelope.event
        this.onResourceEvent(ref, event, payload, at)
      })
      log.info('pet host started', { petId: manifest.id, memory: lines.length })
    })()
    return this.starting
  }

  /** provider 在 `attach` 时交来 hub;话语经它发出去。 */
  attachEvents(hub: ResourceEventHub | undefined): void {
    this.hub = hub
  }

  listPets(): PetSummary[] {
    return this.roster.list().map(summarizePet)
  }

  current(): PetCurrentView {
    return this.requireHost().current()
  }

  /** 发 `poked` / `stroked`。只发事实,账由绕回来的时刻记(见文件头)。 */
  gesture(event: 'poked' | 'stroked'): void {
    this.requireHost()
    this.emit(event, { at: this.now() })
  }

  say(mode: 'speak' | 'mutter', text: string): Promise<PetSayReceipt> {
    return this.enqueue(async () => {
      const host = this.requireHost()
      const outcome = host.say(mode, text)
      await this.settle(host.pet.id, outcome)
      if (outcome.utterance) return { said: true, utterance: outcome.utterance }
      return { said: false, reason: outcome.dropped ?? 'nothing-to-say' }
    })
  }

  adopt(petId: string): Promise<PetSummary> {
    const manifest = this.roster.get(petId)
    if (!manifest) return Promise.reject(new UnknownPetError(petId))
    return this.enqueue(async () => {
      const host = this.requireHost()
      if (host.pet.id !== manifest.id) {
        const lines = await this.store.readTail(manifest.id)
        host.adopt(manifest, lines)
      }
      await this.store.writeCurrent(manifest.id)
      return summarizePet(manifest)
    })
  }

  /** 等喂食链与写盘链都跑完。 */
  async settled(): Promise<void> {
    await this.chain.catch(() => {})
    await this.store.flush()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.unsubscribe?.()
    this.unsubscribe = undefined
    await this.starting?.catch(() => {})
    await this.settled()
    this.hub = undefined
  }

  /** 一条资源事实到了:查自述里的 `moment`,有就喂给宿主(§9.4)。 */
  private onResourceEvent(ref: string, event: string, payload: unknown, at: number): void {
    if (this.disposed || !this.host) return
    const resolved = this.options.registry.resolve(ref)
    if (!resolved) return
    const spec = Object.prototype.hasOwnProperty.call(resolved.spec.events, event)
      ? resolved.spec.events[event]
      : undefined
    const declared = spec?.moment
    if (!declared) return
    const moment: Moment = {
      scheme: resolved.ref.scheme,
      event,
      weight: declared.weight,
      gist: declared.gist,
      payload,
      at,
    }
    void this.enqueue(async () => {
      const host = this.requireHost()
      const petId = host.pet.id
      const outcome = await host.onMoment(moment)
      await this.settle(petId, outcome)
    }).catch(error => log.warn('pet host failed on a moment', { scheme: moment.scheme, event }, error))
  }

  /** 宿主交回的一步:账本行写盘,话语发出去。 */
  private async settle(petId: string, outcome: PetHostOutcome): Promise<void> {
    if (outcome.utterance) this.emit('utterance', outcome.utterance)
    await this.store.append(petId, outcome.lines)
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.catch(() => {}).then(work)
    this.chain = next
    return next
  }

  private emit(event: string, payload: unknown): void {
    if (this.disposed) return
    this.hub?.emit({ scheme: PET_RESOURCE_SCHEME, path: PET_CURRENT_PATH }, event, payload)
  }

  private requireHost(): PetHost {
    if (!this.host) throw new PetsNotStartedError()
    return this.host
  }

  private now(): number {
    return this.options.clock ? this.options.clock.now() : Date.now()
  }
}
