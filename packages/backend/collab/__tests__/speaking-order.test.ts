import { describe, expect, it } from 'vitest'
import {
  buildCollabRelayRing,
  collabRelayLoopsFor,
  pickCollabRelayStarter,
  synthesizeCollabSerialPlan,
} from '../speaking-order.js'
import { advanceCollabPlan } from '../plan.js'
import type { CollabAgentLike } from '../types.js'

const agent = (id: string): CollabAgentLike => ({ id, name: id.toUpperCase() })
const members = (...ids: string[]): CollabAgentLike[] => ids.map(agent)

describe('collabRelayLoopsFor', () => {
  it('缺省不限(0),负数按没配处理', () => {
    expect(collabRelayLoopsFor({})).toBe(0)
    expect(collabRelayLoopsFor({ relayLoops: -1 })).toBe(0)
    expect(collabRelayLoopsFor({ relayLoops: 3 })).toBe(3)
    expect(collabRelayLoopsFor({ relayLoops: 2.7 })).toBe(2)
  })
})

describe('buildCollabRelayRing', () => {
  it('列表次序生效,列表外的成员按名册序接在末尾', () => {
    const ring = buildCollabRelayRing({
      speakOrder: ['c', 'a'],
      members: members('a', 'b', 'c', 'd'),
    })
    expect(ring).toEqual(['c', 'a', 'b', 'd'])
  })

  it('列表里已离房/退休的 id 被忽略,不影响其余次序', () => {
    const ring = buildCollabRelayRing({
      speakOrder: ['ghost', 'c', 'gone', 'a'],
      members: members('a', 'b', 'c'),
    })
    expect(ring).toEqual(['c', 'a', 'b'])
  })

  it('列表里的重复 id 只算一次', () => {
    const ring = buildCollabRelayRing({
      speakOrder: ['b', 'b', 'a'],
      members: members('a', 'b'),
    })
    expect(ring).toEqual(['b', 'a'])
  })

  it('列表空/未配 → 退化为名册序(顺序模式开箱可用)', () => {
    expect(buildCollabRelayRing({ members: members('a', 'b') })).toEqual(['a', 'b'])
    expect(buildCollabRelayRing({ speakOrder: [], members: members('a', 'b') })).toEqual(['a', 'b'])
  })

  it('没有在职成员 → 空环', () => {
    expect(buildCollabRelayRing({ speakOrder: ['a'], members: [] })).toEqual([])
  })
})

describe('pickCollabRelayStarter', () => {
  const ring = ['a', 'b', 'c', 'd']

  it('没有 @ → 环首起棒', () => {
    expect(pickCollabRelayStarter(ring)).toBe('a')
    expect(pickCollabRelayStarter(ring, [])).toBe('a')
  })

  it('@ 到多人时取**环上**最靠前的那位,而不是消息里写在最前的', () => {
    expect(pickCollabRelayStarter(ring, ['d', 'b'])).toBe('b')
  })

  it('@ 的人不在环上 → 回落环首(点名一个外人不该让房间哑火)', () => {
    expect(pickCollabRelayStarter(ring, ['stranger'])).toBe('a')
  })

  it('空环 → 没有起棒者', () => {
    expect(pickCollabRelayStarter([], ['a'])).toBeUndefined()
  })
})

/**
 * 验收用例(设计 §1):四人房、一条「从 1 数到 10」,发言必须依次落在
 * A,B,C,D,A,B,… 上,并在数完之后走满一整轮静默才停。
 *
 * 接力时代这条跑在 `shouldPassCollabRelayBaton` + `pickCollabRelayNext` 上;
 * 那半套已随 waves 删除,现在跑的是真正在生产里执行顺序模式的那条链:
 * `synthesizeCollabSerialPlan`(本地合成编排)+ `advanceCollabPlan`(推进与
 * 终止)。装配层那半(不买判定、批间串行发牌)在
 * app/collab/__tests__/coordinator-relay.test.ts。
 */
describe('验收:四人房从 1 数到 10', () => {
  it('单人批按次序循环落位,数完后走满一整轮静默才停', () => {
    const plan = synthesizeCollabSerialPlan({ members: members('a', 'b', 'c', 'd') })
    expect(plan.waves).toEqual([['a'], ['b'], ['c'], ['d']])
    expect(plan.cycle).toBe(true)

    const spoken: string[] = []
    let waveIndex = 0
    let waveCount = 0
    let passStreak = 0
    let count = 0
    let stop: string | undefined

    for (;;) {
      // 轮到谁谁数,数到 10 之后就没人有话说了。
      const spoke = count < 10
      if (spoke) {
        count += 1
        spoken.push(plan.waves[waveIndex][0])
      }
      const advance = advanceCollabPlan({
        waveTotal: plan.waves.length,
        waveIndex,
        waveCount,
        passStreak,
        spoke,
        cycle: plan.cycle,
        maxWaves: 0,
      })
      waveCount = advance.waveCount
      passStreak = advance.passStreak
      if (!advance.next) {
        stop = advance.stop
        break
      }
      waveIndex = advance.waveIndex
    }

    expect(count).toBe(10)
    expect(spoken).toEqual(['a', 'b', 'c', 'd', 'a', 'b', 'c', 'd', 'a', 'b'])
    // 10 批说了话 + 4 批静默才够一整轮
    expect(waveCount).toBe(14)
    expect(stop).toBe('silent-lap')
  })

  it('配了 2 圈就只走 8 批 —— 收口权在配置里', () => {
    const plan = synthesizeCollabSerialPlan({ members: members('a', 'b', 'c', 'd') })
    let waveIndex = 0
    let waveCount = 0
    let passStreak = 0
    let stop: string | undefined

    for (;;) {
      const advance = advanceCollabPlan({
        waveTotal: plan.waves.length,
        waveIndex,
        waveCount,
        passStreak,
        spoke: true,
        cycle: plan.cycle,
        maxWaves: 2 * plan.waves.length,
      })
      waveCount = advance.waveCount
      passStreak = advance.passStreak
      if (!advance.next) {
        stop = advance.stop
        break
      }
      waveIndex = advance.waveIndex
    }

    expect(waveCount).toBe(8)
    expect(stop).toBe('wave-cap')
  })
})
