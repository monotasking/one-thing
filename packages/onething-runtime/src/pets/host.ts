/**
 * **主持人 `PetHost`** —— 一只宠物的大脑(正本 `docs/design/pet-system-2026-09.md` §2.3 / §9.2)。
 *
 * 输入是时刻,输出是话语。纯类:时钟注入、作曲器注入、不碰文件、不碰总线。装配层
 * (`@onething/backend/wiring/pets/subsystem.ts`)负责喂它时刻、把它交回的账本行写盘、
 * 把话语作为 `pet:` 事件发出去。
 *
 * ── 它管三件别处不该管的事 ────────────────────────────────────────────────
 * ① **注意力预算**(§9.2 那张表,逐行):
 *   · 同一时刻只有一句开口:开口开始后 `speakingUntil = at + 估计时长`,这段时间里再来的
 *     开口请求**丢弃并记账**(`busy`),不排队 —— 排队的开口到轮上时,那条事实早就过时了;
 *   · 冷却:两次开口之间至少 `cooldownMs`(缺省 4 分钟)。`normal` 撞冷却丢弃记账
 *     (`cooldown`);`high` 无视冷却,但仍受「同一时刻一句」约束;
 *   · `low` 永远不开口,只记账;
 *   · 作曲器答 `null` → 只记账(`nothing-to-say`);
 *   · `say` 做法:`speak` 当 `high` 走同一套规矩(人或模型明确要它说),`mutter` 不占预算、
 *     不改 `speakingUntil`。
 * ② **记忆**:每条时刻、每条话语、每次丢弃都成一行账,内存里留最近 50 行;
 *    冷却与「还在不在说」从这串行**折**出来(`foldPetMemory`),不另存状态,所以重启接得上。
 * ③ **决定说什么**:交给作曲端口(`composer.ts`),宿主只管问不问、问了之后算不算数。
 * ④ **认领节目的话**(P3,§10.3):电台口播是节目的一部分,不能被预算丢掉 —— `claim`
 *    无视冷却;正在说别的就让调用方**等**(不丢、不记账),等够了再带 `preempt` 来压过去。
 *    认领下来的一句从开口到 `hush` 之前都算「正在说」(`voicing`),不按估计时长 ——
 *    声音放多久,话就说多久。
 *
 * ── 为什么「估计时长」复用音乐那一只 ─────────────────────────────────────
 * `music/lyrics.ts` 的 `estimateSpeechSeconds` 是电台口播今天判「这句话要说多久」的同一把
 * 尺子(字数 / 4.2 秒,下限 3 秒)。P3 换成语音回执之前,两处用两把尺子等于同一句话在
 * 电台眼里说完了、在宠物眼里还在说。
 */

import { estimateSpeechSeconds } from '../music/lyrics.js'
import type { MomentComposer } from './composer.js'
import {
  foldPetMemory,
  momentLine,
  PET_MEMORY_LINES,
  PET_RECENT_UTTERANCES,
  type PetDroppedLine,
  type PetLedgerLine,
} from './ledger.js'
import { summarizePet, type PetManifest, type PetSummary } from './manifest.js'
import type { Moment, Utterance, UtteranceDropReason } from './types.js'

/** 两次开口之间的缺省冷却(§2.3「默认 4 分钟一次」)。 */
export const PET_DEFAULT_COOLDOWN_MS = 240_000

export interface PetClock {
  now(): number
}

const SYSTEM_CLOCK: PetClock = { now: () => Date.now() }

/** 一句话估计要说多久(毫秒)。 */
export function estimateSpeechMs(text: string): number {
  return Math.round(estimateSpeechSeconds(text) * 1000)
}

export interface PetHostOptions {
  readonly pet: PetManifest
  readonly composer: MomentComposer
  readonly clock?: PetClock
  /** 这只宠物账本尾部的行(旧的在前)。宿主据此接上冷却与记忆。 */
  readonly lines?: readonly PetLedgerLine[]
  readonly cooldownMs?: number
  /** 造话语 id。缺省 `<petId>-<at base36>-<序号>`。 */
  readonly newId?: () => string
}

/**
 * 一次喂食的结果:这一步新产生的账本行(按发生顺序,调用方逐行写盘),以及说出来的话语
 * 或被挡掉的原因。两者至多一个。
 */
export interface PetHostOutcome {
  readonly lines: readonly PetLedgerLine[]
  readonly utterance?: Utterance
  readonly dropped?: UtteranceDropReason
}

/**
 * `claim` 的三种回答(§10.3):
 *   · `claimed` —— 这一句归宿主了:账本行(话语,压过去时多一行 `preempted`)与那句话语;
 *   · `wait`    —— 正在说别的。`retryInMs` = 估计还要多久;`null` = 那一句在出声,要等它 `hush`;
 *   · `refused` —— 没什么可说(空白文本)。
 */
export type PetClaimOutcome =
  | { readonly kind: 'claimed'; readonly lines: readonly PetLedgerLine[]; readonly utterance: Utterance; readonly preempted: boolean }
  | { readonly kind: 'wait'; readonly retryInMs: number | null }
  | { readonly kind: 'refused' }

/** 作曲在飞时让认领方隔多久再问一次。 */
const COMPOSING_RETRY_MS = 250

/** `pet:current` 读法的形(§9.3)。 */
export interface PetCurrentView {
  readonly pet: PetSummary
  readonly speaking: boolean
  /** 只在还在说的时候出现。 */
  readonly speakingUntil?: number
  /** 最近 20 条,新的在后。 */
  readonly utterances: readonly Utterance[]
}

export class PetHost {
  private manifest: PetManifest
  private readonly composer: MomentComposer
  private readonly clock: PetClock
  private readonly cooldownMs: number
  private readonly mintId: (() => string) | undefined
  private lines: PetLedgerLine[] = []
  private utterances: Utterance[] = []
  private lastSpokeAt: number | undefined
  private speakingUntil: number | undefined
  /** 认领下来、正在出声的那一句(§10.4:认领后到 `hushed` 之前都算在说)。 */
  private voicing: string | undefined
  /** 最后一句开口的 id:`hush` 只有对它才把 `speakingUntil` 改成实际结束时刻。 */
  private lastSpeakId: string | undefined
  /** 作曲在飞。它与「正在说」同一档:一句还没想好的话也占着那一个说话的位置。 */
  private composing = false
  private seq = 0

  constructor(options: PetHostOptions) {
    this.manifest = options.pet
    this.composer = options.composer
    this.clock = options.clock ?? SYSTEM_CLOCK
    this.cooldownMs = options.cooldownMs ?? PET_DEFAULT_COOLDOWN_MS
    this.mintId = options.newId
    this.seed(options.lines ?? [])
  }

  get pet(): PetManifest {
    return this.manifest
  }

  /** 内存里的账本行(旧的在前)。 */
  memory(): readonly PetLedgerLine[] {
    return this.lines
  }

  current(): PetCurrentView {
    const speaking = this.isSpeaking(this.clock.now())
    return {
      pet: summarizePet(this.manifest),
      speaking,
      ...(speaking && this.speakingUntil !== undefined ? { speakingUntil: this.speakingUntil } : {}),
      utterances: [...this.utterances],
    }
  }

  /**
   * 喂一条时刻。先记下它,再按 §9.2 那张表决定开不开口。
   *
   * 作曲是异步的,所以在等作曲的那一段里宿主是「占着说话位」的(`composing`);等回来之后
   * 再看一次钟 —— 这段时间里若有一句 `say` 抢先开了口,这一句按 `busy` 丢掉。
   */
  async onMoment(moment: Moment): Promise<PetHostOutcome> {
    const pet = this.manifest
    const produced: PetLedgerLine[] = [this.record(momentLine(pet.id, moment))]
    if (moment.weight === 'low') return { lines: produced }

    const about = { scheme: moment.scheme, event: moment.event }
    const blocked = this.budgetBlock(this.clock.now(), moment.weight === 'high')
    if (blocked) return this.drop(produced, blocked, { about })

    this.composing = true
    let text: string | null
    try {
      text = await this.composer.compose({ pet, moment, memory: [...this.lines] })
    } finally {
      this.composing = false
    }
    // 等作曲期间换了宠物:这句话是上一只的,说出来就是串台。
    if (this.manifest !== pet) return { lines: produced }
    const trimmed = typeof text === 'string' ? text.trim() : ''
    if (!trimmed) return this.drop(produced, 'nothing-to-say', { about })
    const now = this.clock.now()
    if (this.isSpeaking(now)) return this.drop(produced, 'busy', { about })
    return this.speak(produced, trimmed, now, about)
  }

  /**
   * `pet:` 的 `say` 做法(§9.2 最后第二行)。调用方指定 `mode`。
   * 空白文本没什么可说,记 `nothing-to-say`。
   */
  say(mode: 'speak' | 'mutter', text: string): PetHostOutcome {
    const trimmed = text.trim()
    const produced: PetLedgerLine[] = []
    if (!trimmed) return this.drop(produced, 'nothing-to-say', {})
    const now = this.clock.now()
    if (mode === 'mutter') {
      const utterance = this.utter('mutter', trimmed, now)
      produced.push(this.record({ kind: 'utterance', petId: this.manifest.id, at: now, utterance }))
      return { lines: produced, utterance }
    }
    const blocked = this.budgetBlock(now, true)
    if (blocked) return this.drop(produced, blocked, { text: trimmed })
    return this.speak(produced, trimmed, now)
  }

  /**
   * **认领**一句节目的话(§10.3 那张表)。同步:要等的时候不在这里等,答 `wait`,由装配层
   * 等到上一句 `hush` 或估计时长到了再来问;等满 10 秒带 `preempt: true` 来,直接开口并记
   * 一行 `preempted`。「换宠物中 / 已 dispose → 不认领」是装配层答的(宿主自己没有那两种状态)。
   *
   * `source` 形同资源事件的出处(`{ scheme, event }`),落进话语的 `about`。
   */
  claim(source: { scheme: string; event: string }, text: string, options: { preempt?: boolean } = {}): PetClaimOutcome {
    const trimmed = text.trim()
    if (!trimmed) return { kind: 'refused' }
    const now = this.clock.now()
    if (this.isSpeaking(now) && !options.preempt) {
      if (this.voicing !== undefined) return { kind: 'wait', retryInMs: null }
      if (this.composing) return { kind: 'wait', retryInMs: COMPOSING_RETRY_MS }
      return { kind: 'wait', retryInMs: Math.max(0, (this.speakingUntil ?? now) - now) }
    }
    const over = this.isSpeaking(now) ? this.voicing ?? this.lastSpeakId : undefined
    const preempted = this.isSpeaking(now)
    const produced: PetLedgerLine[] = []
    const outcome = this.speak(produced, trimmed, now, { scheme: source.scheme, event: source.event })
    const utterance = outcome.utterance!
    this.voicing = utterance.id
    if (preempted) {
      produced.push(this.record({
        kind: 'preempted',
        petId: this.manifest.id,
        at: now,
        utteranceId: utterance.id,
        ...(over !== undefined ? { over } : {}),
      }))
    }
    return { kind: 'claimed', lines: produced, utterance, preempted }
  }

  /**
   * 一句**自己开口**(时刻 / `say` 做法)的话真要出声了(P4,§11.3):从现在到它 `hush` 之前都算
   * 「正在说」,与认领下来的口播同一档 —— 声音放多久,话就说多久,不按估计时长。只认最后一句开口;
   * 已经被别的话压过去(`lastSpeakId` 不是它)答 `false`,调用方照估计时长收尾。
   */
  markVoicing(utteranceId: string): boolean {
    if (this.lastSpeakId !== utteranceId) return false
    this.voicing = utteranceId
    return true
  }

  /**
   * 一句开口**真的说完了**(§10.4 `hushed`)。认领的那句:清 `voicing`;若它是最后一句开口,
   * `speakingUntil` 改成此刻(实际结束,不再是估计)。返回要写盘的账本行。
   *
   * 不是这只宠物的话(换宠物之后上一只的回执)→ 不改状态、不记账,返回空。
   */
  hush(utteranceId: string): readonly PetLedgerLine[] {
    const known = this.voicing === utteranceId || this.utterances.some(u => u.id === utteranceId)
    if (!known) return []
    const now = this.clock.now()
    if (this.voicing === utteranceId) this.voicing = undefined
    if (this.lastSpeakId === utteranceId) this.speakingUntil = now
    return [this.record({ kind: 'hushed', petId: this.manifest.id, at: now, utteranceId })]
  }

  /**
   * 换一只宠物(§9.2 最后一行):换自述、清「正在说」、记忆换成那一只自己的账本尾部。
   * 账本按宠物分目录,旧那一只的账本不动。
   */
  adopt(pet: PetManifest, lines: readonly PetLedgerLine[] = []): void {
    this.manifest = pet
    this.seed(lines)
    this.speakingUntil = undefined
    this.voicing = undefined
  }

  private seed(lines: readonly PetLedgerLine[]): void {
    const memory = foldPetMemory(lines.filter(line => line.petId === this.manifest.id), estimateSpeechMs)
    this.lines = [...memory.lines]
    this.utterances = [...memory.utterances]
    this.lastSpokeAt = memory.lastSpokeAt
    this.speakingUntil = memory.speakingUntil
    this.lastSpeakId = [...memory.utterances].reverse().find(u => u.mode === 'speak')?.id
    this.voicing = undefined
  }

  private isSpeaking(now: number): boolean {
    return this.composing
      || this.voicing !== undefined
      || (this.speakingUntil !== undefined && now < this.speakingUntil)
  }

  /** 预算挡不挡。`high` 无视冷却,但不无视「同一时刻一句」。 */
  private budgetBlock(now: number, high: boolean): UtteranceDropReason | null {
    if (this.isSpeaking(now)) return 'busy'
    if (!high && this.lastSpokeAt !== undefined && now - this.lastSpokeAt < this.cooldownMs) return 'cooldown'
    return null
  }

  private speak(
    produced: PetLedgerLine[],
    text: string,
    now: number,
    about?: { scheme: string; event: string },
  ): PetHostOutcome {
    const utterance = this.utter('speak', text, now, about)
    this.lastSpokeAt = now
    this.lastSpeakId = utterance.id
    this.speakingUntil = now + estimateSpeechMs(text)
    produced.push(this.record({ kind: 'utterance', petId: this.manifest.id, at: now, utterance }))
    return { lines: produced, utterance }
  }

  private drop(
    produced: PetLedgerLine[],
    reason: UtteranceDropReason,
    extra: { about?: { scheme: string; event: string }; text?: string },
  ): PetHostOutcome {
    const line: PetDroppedLine = {
      kind: 'dropped',
      petId: this.manifest.id,
      at: this.clock.now(),
      reason,
      ...(extra.about ? { about: extra.about } : {}),
      ...(extra.text !== undefined ? { text: extra.text } : {}),
    }
    produced.push(this.record(line))
    return { lines: produced, dropped: reason }
  }

  private utter(
    mode: 'speak' | 'mutter',
    text: string,
    at: number,
    about?: { scheme: string; event: string },
  ): Utterance {
    this.seq += 1
    const id = this.mintId ? this.mintId() : `${this.manifest.id}-${at.toString(36)}-${this.seq}`
    return {
      id,
      petId: this.manifest.id,
      mode,
      text,
      ...(about ? { about } : {}),
      at,
      duck: mode === 'speak',
    }
  }

  private record<T extends PetLedgerLine>(line: T): T {
    this.lines.push(line)
    if (this.lines.length > PET_MEMORY_LINES) this.lines.splice(0, this.lines.length - PET_MEMORY_LINES)
    if (line.kind === 'utterance') {
      this.utterances.push(line.utterance)
      if (this.utterances.length > PET_RECENT_UTTERANCES) {
        this.utterances.splice(0, this.utterances.length - PET_RECENT_UTTERANCES)
      }
    }
    return line
  }
}
