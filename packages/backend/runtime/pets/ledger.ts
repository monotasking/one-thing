/**
 * **互动账本**的行形与折叠(§2.3 第 2 条「记忆」、§9.2「记忆」那一行)。
 *
 * 账本是**事实的流水**,一行一件事,按宠物分目录(`<store>/pets/<id>/ledger.jsonl`,读写在
 * 装配层 `wiring/pets/ledger-store.ts`)。这只文件只管两件纯的事:一行长什么样、一串行
 * 折成「最近的记忆」长什么样。
 *
 * ── 五种行,不多 ────────────────────────────────────────────────────────────
 *   · `moment`    —— 一条时刻进来了(不论最后开没开口,§9.2「每条时刻……都进账本」);
 *   · `utterance` —— 宠物说了一句;
 *   · `dropped`   —— 一次开口请求被预算或作曲端口挡掉了,连同原因;
 *   · `hushed`    —— 一句开口真的说完了(P3,§10.4:播完、失败、被中止,或没出声的那句估计时长到了);
 *   · `preempted` —— 电台口播等了 10 秒还没等到上一句说完,直接开口压过去(P3,§10.3 第三行)。
 *
 * 没有「当前在不在说话」「上次什么时候说的」这类格子:它们是**折出来**的,不存
 * (`foldPetMemory`)。于是重启之后冷却照样接得上,不必另存一份会和账本漂开的状态。
 *
 * ── 为什么要一个形状判据 ───────────────────────────────────────────────────
 * 账本是磁盘上的文件,读回来的是不可信输入(半截写入、手改、旧版本)。`parsePetLedgerLine`
 * 认不出的行一律返回 `null`,读的一方跳过 —— 一行坏账不该让一只宠物失忆。
 */

import type { Moment, MomentWeight, Utterance, UtteranceDropReason } from './types.js'

export interface PetMomentLine {
  readonly kind: 'moment'
  readonly petId: string
  readonly at: number
  readonly scheme: string
  readonly event: string
  readonly weight: MomentWeight
  readonly gist: string
  readonly payload?: unknown
}

export interface PetUtteranceLine {
  readonly kind: 'utterance'
  readonly petId: string
  readonly at: number
  readonly utterance: Utterance
}

export interface PetDroppedLine {
  readonly kind: 'dropped'
  readonly petId: string
  readonly at: number
  readonly reason: UtteranceDropReason
  /** 挡掉的是哪条时刻的开口;`say` 做法挡掉的没有。 */
  readonly about?: { readonly scheme: string; readonly event: string }
  /** `say` 做法被挡掉时,原本要说的那句。 */
  readonly text?: string
}

export interface PetHushedLine {
  readonly kind: 'hushed'
  readonly petId: string
  readonly at: number
  readonly utteranceId: string
}

export interface PetPreemptedLine {
  readonly kind: 'preempted'
  readonly petId: string
  readonly at: number
  /** 压过去的那一句(新开口)。 */
  readonly utteranceId: string
  /** 被压住的那一句;它当时若只是估计时长还没到(没在出声),这一格缺席。 */
  readonly over?: string
}

export type PetLedgerLine = PetMomentLine | PetUtteranceLine | PetDroppedLine | PetHushedLine | PetPreemptedLine

export function momentLine(petId: string, moment: Moment): PetMomentLine {
  return {
    kind: 'moment',
    petId,
    at: moment.at,
    scheme: moment.scheme,
    event: moment.event,
    weight: moment.weight,
    gist: moment.gist,
    ...(moment.payload !== undefined ? { payload: moment.payload } : {}),
  }
}

/** 宿主内存里留多少行(§9.2)。启动时也从文件尾部读这么多。 */
export const PET_MEMORY_LINES = 50
/** `current` 读法交出多少条话语(§9.3)。 */
export const PET_RECENT_UTTERANCES = 20

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isAbout(value: unknown): boolean {
  return isRecord(value) && typeof value.scheme === 'string' && typeof value.event === 'string'
}

function isUtterance(value: unknown): value is Utterance {
  if (!isRecord(value)) return false
  return typeof value.id === 'string'
    && typeof value.petId === 'string'
    && (value.mode === 'speak' || value.mode === 'mutter')
    && typeof value.text === 'string'
    && isFiniteNumber(value.at)
    && typeof value.duck === 'boolean'
    && (value.about === undefined || isAbout(value.about))
}

/** 一行 JSON 文本 → 账本行。认不出就是 `null`(见文件头)。 */
export function parsePetLedgerLine(text: string): PetLedgerLine | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(value) || typeof value.petId !== 'string' || !isFiniteNumber(value.at)) return null
  switch (value.kind) {
    case 'moment':
      return typeof value.scheme === 'string'
        && typeof value.event === 'string'
        && (value.weight === 'high' || value.weight === 'normal' || value.weight === 'low')
        && typeof value.gist === 'string'
        ? (value as unknown as PetMomentLine)
        : null
    case 'utterance':
      return isUtterance(value.utterance) ? (value as unknown as PetUtteranceLine) : null
    case 'hushed':
      return typeof value.utteranceId === 'string' ? (value as unknown as PetHushedLine) : null
    case 'preempted':
      return typeof value.utteranceId === 'string' && (value.over === undefined || typeof value.over === 'string')
        ? (value as unknown as PetPreemptedLine)
        : null
    case 'dropped':
      return (value.reason === 'busy' || value.reason === 'cooldown' || value.reason === 'nothing-to-say')
        && (value.about === undefined || isAbout(value.about))
        && (value.text === undefined || typeof value.text === 'string')
        ? (value as unknown as PetDroppedLine)
        : null
    default:
      return null
  }
}

/** 一串账本行折出来的「最近的记忆」。 */
export interface PetMemory {
  /** 最近 `PET_MEMORY_LINES` 行,旧的在前。 */
  readonly lines: readonly PetLedgerLine[]
  /** 最近 `PET_RECENT_UTTERANCES` 条话语,新的在后。 */
  readonly utterances: readonly Utterance[]
  /** 最后一次**开口**(不含嘀咕)的时刻;没开过口是 `undefined`。冷却从这里算。 */
  readonly lastSpokeAt?: number
  /** 最后一次开口说到什么时候:`at + 估计时长`;那一句有 `hushed` 行就是它的 `at`(实际说完的时刻)。 */
  readonly speakingUntil?: number
}

/**
 * 折叠。`estimateMs` 由宿主递进来(它决定「一句话说多久」),账本不认识语音。
 * 只看这串行本身,不看时钟:「此刻还在不在说」是读的那一刻才答得出的问题。
 */
export function foldPetMemory(
  lines: readonly PetLedgerLine[],
  estimateMs: (text: string) => number,
): PetMemory {
  const kept = lines.slice(-PET_MEMORY_LINES)
  const utterances: Utterance[] = []
  let lastSpokeAt: number | undefined
  let speakingUntil: number | undefined
  let lastSpeakId: string | undefined
  for (const line of kept) {
    if (line.kind === 'hushed') {
      if (line.utteranceId === lastSpeakId) speakingUntil = line.at
      continue
    }
    if (line.kind !== 'utterance') continue
    utterances.push(line.utterance)
    if (line.utterance.mode === 'speak') {
      lastSpokeAt = line.utterance.at
      lastSpeakId = line.utterance.id
      speakingUntil = line.utterance.at + estimateMs(line.utterance.text)
    }
  }
  return {
    lines: kept,
    utterances: utterances.slice(-PET_RECENT_UTTERANCES),
    ...(lastSpokeAt !== undefined ? { lastSpokeAt } : {}),
    ...(speakingUntil !== undefined ? { speakingUntil } : {}),
  }
}
