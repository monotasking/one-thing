import { describe, expect, it } from 'vitest'
import {
  beatSecondsOf,
  classifyTravel,
  muttersGroupFor,
  POKE_BURST_COUNT,
  POKE_BURST_WINDOW_MS,
  POKE_MAX_TRAVEL_PX,
  registerPoke,
  resolvePose,
  STILL_DOZE_MS,
  STROKE_MIN_TRAVEL_PX,
} from '../pose'
import type { PoseInput } from '../pose'

/**
 * §7.2 的优先级表逐行钉:每一行都用「比它低的每一条同时成立」来喂,
 * 这样改了表里的顺序,红的那一行就是被挪动的那一行。
 */

const RHYTHM = { kind: 'rhythm', bpm: 90 } as const

function input(over: Partial<PoseInput>): PoseInput {
  return { activity: 'idle', stillSince: null, now: 0, speaking: false, listening: false, petted: false, ...over }
}

describe('resolvePose:§7.2 优先级表', () => {
  it('1 被撸压过一切(连 fault / off / 开口都压过)', () => {
    for (const activity of ['fault', 'off', 'busy', 'still', 'idle', RHYTHM] as const) {
      expect(resolvePose(input({ activity, petted: true, speaking: true, listening: true }))).toBe('petted')
    }
  })

  it('2 fault 压过 off 之下的所有行(开口 / 打字不改蚊香眼)', () => {
    expect(resolvePose(input({ activity: 'fault', speaking: true, listening: true }))).toBe('dizzy')
  })

  it('3 off 压过开口与打字', () => {
    expect(resolvePose(input({ activity: 'off', speaking: true, listening: true }))).toBe('sleeping')
  })

  it('4 开口中压过 busy / 打字 / 打盹 / 节奏', () => {
    expect(resolvePose(input({ activity: 'busy', speaking: true, listening: true }))).toBe('speaking')
    expect(resolvePose(input({ activity: 'still', stillSince: 0, now: STILL_DOZE_MS, speaking: true }))).toBe('speaking')
    expect(resolvePose(input({ activity: RHYTHM, speaking: true }))).toBe('speaking')
  })

  it('5 busy 压过打字', () => {
    expect(resolvePose(input({ activity: 'busy', listening: true }))).toBe('busy')
  })

  it('6 打字压过打盹与节奏', () => {
    expect(resolvePose(input({ activity: 'still', stillSince: 0, now: STILL_DOZE_MS, listening: true }))).toBe('listening')
    expect(resolvePose(input({ activity: RHYTHM, listening: true }))).toBe('listening')
  })

  it('7 still 满 9s 才打盹,差 1ms 不算', () => {
    expect(resolvePose(input({ activity: 'still', stillSince: 1000, now: 1000 + STILL_DOZE_MS }))).toBe('dozing')
    expect(resolvePose(input({ activity: 'still', stillSince: 1000, now: 1000 + STILL_DOZE_MS - 1 }))).toBe('sitting')
  })

  it('8 rhythm 点头', () => {
    expect(resolvePose(input({ activity: RHYTHM }))).toBe('grooving')
  })

  it('9 still 未满 / idle 坐着', () => {
    expect(resolvePose(input({ activity: 'still', stillSince: 0, now: 10 }))).toBe('sitting')
    expect(resolvePose(input({ activity: 'idle' }))).toBe('sitting')
  })

  it('节拍 = 60 / bpm;不是 rhythm 或 bpm 非正数时没有节拍', () => {
    expect(beatSecondsOf({ kind: 'rhythm', bpm: 120 })).toBe(0.5)
    expect(beatSecondsOf({ kind: 'rhythm', bpm: 0 })).toBeUndefined()
    expect(beatSecondsOf('still')).toBeUndefined()
  })
})

describe('muttersGroupFor:§7.3 点一下按活动选组', () => {
  it.each([
    ['off', 'sleepy'],
    ['fault', 'dizzy'],
    ['busy', 'busy'],
    ['still', 'waiting'],
    ['idle', 'waiting'],
  ] as const)('%s → %s', (activity, group) => {
    expect(muttersGroupFor(activity)).toBe(group)
  })

  it('rhythm → poked', () => {
    expect(muttersGroupFor(RHYTHM)).toBe('poked')
  })
})

describe('手势判定', () => {
  it('阈值:< 8 是点,> 90 是撸,两者之间什么都不是(边界值落在「什么都不是」)', () => {
    expect(POKE_MAX_TRAVEL_PX).toBe(8)
    expect(STROKE_MIN_TRAVEL_PX).toBe(90)
    expect(classifyTravel(0)).toBe('poke')
    expect(classifyTravel(7.9)).toBe('poke')
    expect(classifyTravel(8)).toBe('none')
    expect(classifyTravel(90)).toBe('none')
    expect(classifyTravel(90.1)).toBe('stroke')
  })

  it('4s 内第 5 次点算连戳,计数清零', () => {
    expect(POKE_BURST_COUNT).toBe(5)
    expect(POKE_BURST_WINDOW_MS).toBe(4000)
    let history: readonly number[] = []
    for (let i = 0; i < 4; i += 1) {
      const r = registerPoke(history, i * 900)
      expect(r.annoyed).toBe(false)
      history = r.history
    }
    const fifth = registerPoke(history, 3999)
    expect(fifth.annoyed).toBe(true)
    expect(fifth.history).toEqual([])
  })

  it('窗口外的旧点不算数', () => {
    let history: readonly number[] = []
    for (const at of [0, 1000, 2000, 3000]) history = registerPoke(history, at).history
    // 第 5 次在 4000:0 那一下正好出窗口(< 4000 才算窗口内),只剩 4 次
    const r = registerPoke(history, 4000)
    expect(r.annoyed).toBe(false)
    expect(r.history).toEqual([1000, 2000, 3000, 4000])
  })
})
