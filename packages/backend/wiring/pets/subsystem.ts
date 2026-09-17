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
 *
 * ── P3:电台的话交给宠物说(§10.2「宠物接管」/ §10.3)────────────────────────
 * `createHostVoice(kit)` 交出一个 `HostVoice`,组合根把它绑到音乐子系统上。电台说一句 →
 * 宿主**认领**(`PetHost.claim`,无视冷却;正在说别的就等,最多 10 秒,超时压过去)→ 发
 * `utterance`(壳上出气泡、亮灯)→ 合成(音乐借出的同一份缓存,宠物的嗓子作调法)→ 出声
 * (音乐借出的同一条出声路)→ 发 `hushed`,`speakingUntil` 改成实际结束时刻。不认领
 * (还没起来 / 已 dispose)→ 照音乐的缺省实现说,电台不因为宠物缺席而哑。
 *
 * **没出声的开口也会 `hushed`**:`say` 做法与时刻说出来的 `speak` 不经过出声路,它们的
 * `hushed` 在估计时长到点时发(`estimatedHushes`)。否则壳上那盏 ON AIR 灯等不到回执,
 * 亮着不灭。
 */

import type { ResourceEventHub, ResourceRegistry } from '@onething/core/resource'
import {
  PET_CURRENT_PATH,
  PET_RESOURCE_SCHEME,
  estimateSpeechMs,
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
import type { HostVoice, HostVoiceKit, HostVoiceSpeakOptions } from '../music/host-voice.js'
import { getLogger } from '../logging/index.js'
import { PetLedgerStore } from './ledger-store.js'
import { petVoiceStyle } from './voice.js'

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

/** 电台口播等上一句说完,最多等这么久;超时直接开口(§10.3 第三行)。 */
export const PET_CLAIM_WAIT_MS = 10_000

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
  /** 认领最多等多久。缺省 `PET_CLAIM_WAIT_MS`;测试缩短它。 */
  readonly claimWaitMs?: number
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
  /** 在等上一句说完的认领方:任何一句 `hush`、超时或 dispose 都叫醒他们再问一次。 */
  private readonly claimWaiters = new Set<() => void>()
  /** 没出声的开口:估计时长到点发 `hushed`(见文件头)。 */
  private readonly estimatedHushes = new Map<string, ReturnType<typeof setTimeout>>()

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
      this.scheduleEstimatedHush(host.pet.id, outcome.utterance)
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

  /**
   * 交给音乐子系统的主持人声音(§10.2「宠物接管」)。每次调用造一个薄对象,状态全在这只
   * 子系统上 —— 音乐那边每说一句现问一次也无妨。
   */
  createHostVoice(kit: HostVoiceKit): HostVoice {
    return {
      prefetch: (text, title) => {
        const host = this.host
        kit.prefetch(text, title, host ? petVoiceStyle(host.pet.id, host.pet.voice) : undefined)
      },
      speak: (text, options) => this.speakClaimed(kit, text, options),
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.wakeClaimWaiters()
    for (const timer of this.estimatedHushes.values()) clearTimeout(timer)
    this.estimatedHushes.clear()
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
      this.scheduleEstimatedHush(petId, outcome.utterance)
    }).catch(error => log.warn('pet host failed on a moment', { scheme: moment.scheme, event }, error))
  }

  /** 宿主交回的一步:账本行写盘,话语发出去。 */
  private async settle(petId: string, outcome: PetHostOutcome): Promise<void> {
    if (outcome.utterance) this.emit('utterance', outcome.utterance)
    await this.store.append(petId, outcome.lines)
  }

  /** §10.6 那张表的后端一列:认领 → `utterance` → 合成 → (压音量)→ 播放 → `hushed`。 */
  private async speakClaimed(kit: HostVoiceKit, text: string, options: HostVoiceSpeakOptions): Promise<void> {
    const claimed = await this.claim(kit.source, text).catch(error => {
      log.warn('pet claim failed; the host voice speaks instead', { title: options.title }, error)
      return null
    })
    if (!claimed) return kit.fallback.speak(text, options)
    const { petId, utterance, pet } = claimed
    const { signal } = options
    try {
      if (signal?.aborted) return
      const speech = await kit.synthesize(text, options.title, petVoiceStyle(pet.id, pet.voice))
      if (!speech || signal?.aborted) return
      await options.onVoiceStart?.()
      if (signal?.aborted) return
      await kit.play(speech, { text, title: options.title, ...(signal ? { signal } : {}) })
    } catch (error) {
      log.warn('pet patter voicing failed', { title: options.title }, error)
    } finally {
      await this.hush(petId, utterance.id)
    }
  }

  /**
   * 认领一句(§10.3)。`null` = 不认领(还没起来 / 已 dispose / 空白文本),调用方退回缺省实现。
   *
   * 问宿主走喂食链(与时刻、`say` 同一条,先来的先占说话位);**等**不在链上等 —— 在链上
   * 等 10 秒会把那 10 秒里到的每一条时刻都卡住。
   */
  private async claim(
    source: { scheme: string; event: string },
    text: string,
  ): Promise<{ petId: string; utterance: Utterance; pet: PetHost['pet'] } | null> {
    if (this.disposed || !this.host) return null
    let preempt = false
    const deadline = setTimeout(() => {
      preempt = true
      this.wakeClaimWaiters()
    }, this.options.claimWaitMs ?? PET_CLAIM_WAIT_MS)
    try {
      for (;;) {
        if (this.disposed) return null
        const answer = await this.enqueue(async () => {
          const host = this.host
          if (this.disposed || !host) return null
          const outcome = host.claim(source, text, { preempt })
          if (outcome.kind !== 'claimed') return outcome
          await this.settle(host.pet.id, outcome)
          if (outcome.preempted) log.info('radio patter preempted the pet', { petId: host.pet.id })
          return { kind: 'claimed' as const, petId: host.pet.id, utterance: outcome.utterance, pet: host.pet }
        })
        if (!answer || answer.kind === 'refused') return null
        if (answer.kind === 'claimed') return answer
        await this.waitForTurn(answer.retryInMs)
      }
    } finally {
      clearTimeout(deadline)
    }
  }

  private waitForTurn(retryInMs: number | null): Promise<void> {
    return new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const wake = () => {
        if (timer) clearTimeout(timer)
        this.claimWaiters.delete(wake)
        resolve()
      }
      this.claimWaiters.add(wake)
      // 估计时长到点再问;+1 让钟确实走过 `speakingUntil`。
      if (retryInMs !== null) timer = setTimeout(wake, retryInMs + 1)
    })
  }

  private wakeClaimWaiters(): void {
    for (const wake of [...this.claimWaiters]) wake()
  }

  /** 一句开口结束:宿主记账、发 `hushed`、叫醒在等的认领方。不抛。 */
  private hush(petId: string, utteranceId: string): Promise<void> {
    const pending = this.estimatedHushes.get(utteranceId)
    if (pending) {
      clearTimeout(pending)
      this.estimatedHushes.delete(utteranceId)
    }
    return this.enqueue(async () => {
      if (this.disposed) return
      const host = this.host
      const at = this.now()
      if (host && host.pet.id === petId) await this.store.append(petId, host.hush(utteranceId))
      this.emit('hushed', { utteranceId, at })
    })
      .catch(error => log.warn('pet hush failed', { petId }, error))
      .finally(() => this.wakeClaimWaiters())
  }

  /** 没出声的开口(`say` 做法 / 时刻):估计时长到点发 `hushed`。嘀咕不算开口。 */
  private scheduleEstimatedHush(petId: string, utterance: Utterance | undefined): void {
    if (!utterance || utterance.mode !== 'speak' || this.disposed) return
    const timer = setTimeout(() => {
      this.estimatedHushes.delete(utterance.id)
      void this.hush(petId, utterance.id)
    }, estimateSpeechMs(utterance.text))
    this.estimatedHushes.set(utterance.id, timer)
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
