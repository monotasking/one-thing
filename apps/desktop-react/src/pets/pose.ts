import type { PetActivity, PoseState } from './types'
import type { ReactionGroup } from './manifest'

/**
 * **姿势与手势的判据**(宠物 P0,正本 `docs/design/pet-system-2026-09.md` §7.2 / §7.3)。
 *
 * 纯函数,不认识 React、不读时钟、不起计时器 —— 舞台、lab 与测试调的是同一份。
 * 「现在几点」「按下之后走了多远」都由调用方量好递进来,所以这里的每一条
 * 判据都能逐行钉进单测。
 */

/** still 持续这么久进打盹(§7.1 / §7.2 第 7 行)。 */
export const STILL_DOZE_MS = 9_000
/** 按下到松手累计水平位移**小于**它 = 点(§7.3)。 */
export const POKE_MAX_TRAVEL_PX = 8
/** 按住后累计水平位移**大于**它 = 撸(§7.3)。两者之间松手什么都不发生。 */
export const STROKE_MIN_TRAVEL_PX = 90
/** 连戳窗口:这么久之内第 `POKE_BURST_COUNT` 次点算连戳。 */
export const POKE_BURST_WINDOW_MS = 4_000
export const POKE_BURST_COUNT = 5

export interface PoseInput {
  activity: PetActivity
  /** 活动进入 `still` 的时刻;不是 still 时为 `null`。 */
  stillSince: number | null
  now: number
  /** 开口中 = 字还在出(出完字之后的停留不算)。 */
  speaking: boolean
  /** 宿主说你在打字。 */
  listening: boolean
  /** 正在被撸。 */
  petted: boolean
}

export function isRhythm(activity: PetActivity): activity is { kind: 'rhythm'; bpm: number } {
  return typeof activity === 'object' && activity.kind === 'rhythm'
}

/** rhythm 时的秒/拍(60/bpm);bpm 不是正数时当作没有节拍。 */
export function beatSecondsOf(activity: PetActivity): number | undefined {
  if (!isRhythm(activity) || !(activity.bpm > 0)) return undefined
  return 60 / activity.bpm
}

/** still 是否已满打盹线。 */
export function hasDozedOff(input: Pick<PoseInput, 'activity' | 'stillSince' | 'now'>): boolean {
  return input.activity === 'still' && input.stillSince !== null && input.now - input.stillSince >= STILL_DOZE_MS
}

/**
 * §7.2 优先级表,从上到下第一条命中即用。表的行号写在每一行旁边 —— 改顺序就是改设计。
 * 嘀咕不是输入:嘀咕中不改变姿势。
 */
export function resolvePose(input: PoseInput): PoseState {
  const { activity } = input
  /* 1 */ if (input.petted) return 'petted'
  /* 2 */ if (activity === 'fault') return 'dizzy'
  /* 3 */ if (activity === 'off') return 'sleeping'
  /* 4 */ if (input.speaking) return 'speaking'
  /* 5 */ if (activity === 'busy') return 'busy'
  /* 6 */ if (input.listening) return 'listening'
  /* 7 */ if (hasDozedOff(input)) return 'dozing'
  /* 8 */ if (isRhythm(activity)) return 'grooving'
  /* 9 */ return 'sitting'
}

/** 点一下时的嘀咕组(§7.3 第一行):按活动选。 */
export function muttersGroupFor(activity: PetActivity): ReactionGroup {
  if (activity === 'off') return 'sleepy'
  if (activity === 'fault') return 'dizzy'
  if (activity === 'busy') return 'busy'
  if (isRhythm(activity)) return 'poked'
  return 'waiting'
}

/**
 * 一次按下走过的累计水平位移算什么(§7.3)。
 * `poke` 只在松手时成立;`stroke` 在按住途中一过线就成立。
 */
export type TravelClass = 'poke' | 'stroke' | 'none'

export function classifyTravel(travelPx: number): TravelClass {
  if (travelPx < POKE_MAX_TRAVEL_PX) return 'poke'
  if (travelPx > STROKE_MIN_TRAVEL_PX) return 'stroke'
  return 'none'
}

/**
 * 记一次点。返回新的时间戳表(只留窗口内的)与这一下是不是连戳;
 * 连戳成立时计数清零(返回空表)。
 */
export function registerPoke(
  history: readonly number[],
  now: number,
): { history: readonly number[]; annoyed: boolean } {
  const kept = history.filter((at) => now - at < POKE_BURST_WINDOW_MS)
  kept.push(now)
  if (kept.length >= POKE_BURST_COUNT) return { history: [], annoyed: true }
  return { history: kept, annoyed: false }
}
