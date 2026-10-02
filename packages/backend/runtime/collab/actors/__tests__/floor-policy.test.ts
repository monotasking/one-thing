/**
 * 发言策略族的四档(docs/design/collab-actor-v3.md §1.5,D3)。
 *
 * D1 的 `free` 已经有 `room-rules.test.ts` 钉着;这一份钉的是 D3 补齐的三档,以及
 * 四档**共有**的那一条:`@` 提及直通授牌。后者刻意写成一个跑四遍的循环 ——
 * 「@ 在某个策略下不灵」这件事必须由测试变成不可能,而不是靠"我们记得每处都写了"。
 */
import { describe, expect, it } from 'vitest'

import {
  createCollabFreeFloorPolicy,
  createCollabPhaseFloorPolicy,
  createCollabRingFloorPolicy,
  createCollabWavesFloorPolicy,
  isSameCollabRoomFloorPolicy,
  resolveCollabFloorPolicy,
  resolveCollabRoomFloorPolicy,
  type CollabFloorDecisionInput,
  type CollabFloorPolicyName,
  type CollabRaisedHand,
} from '../index.js'

const MEMBER_IDS = ['ana', 'bo', 'cy', 'dan']
const ROSTER = MEMBER_IDS.map(id => ({ id, name: id }))

function hand(agentId: string, at: number, origin: 'hand' | 'mention' = 'hand'): CollabRaisedHand {
  return { agentId, at, origin, reason: origin === 'mention' ? 'mention' : 'self-elected' }
}

function input(overrides: Partial<CollabFloorDecisionInput> = {}): CollabFloorDecisionInput {
  return {
    mentioned: [],
    hands: [],
    holders: new Set<string>(),
    activeLeases: 0,
    maxConcurrent: 0,
    members: MEMBER_IDS,
    roster: ROSTER,
    roomId: 'room-1',
    ...overrides,
  }
}

const granted = (decision: { grants: { agentId: string }[] }): string[] =>
  decision.grants.map(grant => grant.agentId)

/* ── 四档共有:@ 直通 ────────────────────────────────────────────────────── */

describe('@ 提及在四个策略下都是直通授牌(§8 保留的已拍板决策)', () => {
  const POLICIES: CollabFloorPolicyName[] = ['free', 'ring', 'waves', 'phase']

  for (const name of POLICIES) {
    it(`${name}:被 @ 的人当场拿牌,不排队、不判定`, () => {
      const decision = resolveCollabFloorPolicy(name).decide(input({
        mentioned: ['dan'],
        // 队里有更早的手 —— 直通的含义就是它排在这些人前面。
        hands: [hand('ana', 10), hand('bo', 20)],
        params: {
          // 每一档都给上它自己那份"本该拦住别人"的配置:
          referee: true,                      // free:本该开裁决窗
          order: ['ana', 'bo', 'cy'],         // ring:dan 根本不在环上
          waves: [['ana'], ['bo']],           // waves:dan 不在任何一批里
          activeRooms: ['room-1'],            // phase:房是活的
          activeMembers: ['ana', 'bo', 'cy', 'dan'],
        },
      }))
      expect(granted(decision)[0]).toBe('dan')
    })
  }

  it('phase:相位关掉的房里 @ 也不发牌 —— 相位是硬门,不是优先级', () => {
    const decision = createCollabPhaseFloorPolicy().decide(input({
      mentioned: ['dan'],
      params: { activeRooms: ['other-room'] },
    }))
    // 夜里 @ 一个村民,他该天亮再说话 —— 立刻开口会把狼的行动暴露给全场。
    expect(decision.grants).toEqual([])
  })
})

/* ── free:批量举手裁决 ──────────────────────────────────────────────────── */

describe('free:批量举手裁决', () => {
  const policy = createCollabFreeFloorPolicy()

  it('挂了裁判:手全部挂起,只请房间开一扇窗', () => {
    const decision = policy.decide(input({
      hands: [hand('ana', 10), hand('bo', 20), hand('cy', 30)],
      params: { referee: true },
    }))
    expect(decision.openJudgment).toBe(true)
    // 三只手,零张牌 —— 这就是"攒进裁决窗"。
    expect(decision.grants).toEqual([])
  })

  it('窗开着:再来十只手也不再开第二扇(O(1) 的落点)', () => {
    const decision = policy.decide(input({
      hands: [hand('ana', 10), hand('bo', 20), hand('cy', 30), hand('dan', 40)],
      params: { referee: true },
      judgment: { token: 'room-1#J1', openedAt: 0, state: 'pending' },
    }))
    expect(decision.openJudgment).toBeUndefined()
    expect(decision.grants).toEqual([])
  })

  it('裁决回来:按裁决的次序发,没排上的手留在队里', () => {
    const decision = policy.decide(input({
      hands: [hand('ana', 10), hand('bo', 20), hand('cy', 30)],
      params: { referee: true },
      judgment: {
        token: 'room-1#J1',
        openedAt: 0,
        state: 'resolved',
        // 举手序是 ana→bo→cy,裁决把 cy 排到最前 —— 次序由裁判定,不由先来后到定。
        grants: ['cy', 'ana'],
      },
    }))
    expect(granted(decision)).toEqual(['cy', 'ana'])
  })

  it('降级:回落举手 FIFO —— 与 D1 的 free 逐字相同', () => {
    const hands = [hand('cy', 30), hand('ana', 10), hand('bo', 20)]
    const degraded = policy.decide(input({
      hands,
      params: { referee: true },
      judgment: { token: 'room-1#J1', openedAt: 0, state: 'degraded' },
    }))
    const d1 = policy.decide(input({ hands }))
    expect(granted(degraded)).toEqual(granted(d1))
    expect(granted(degraded)).toEqual(['ana', 'bo', 'cy'])
  })

  it('私聊房免裁决 —— 没有第二个人要排次序', () => {
    const decision = policy.decide(input({
      hands: [hand('ana', 10)],
      params: { referee: true },
      pairDm: true,
    }))
    expect(decision.openJudgment).toBeUndefined()
    expect(granted(decision)).toEqual(['ana'])
  })

  it('没人举手不开窗 —— 不为一个空名单买调用', () => {
    const decision = policy.decide(input({ params: { referee: true } }))
    expect(decision.openJudgment).toBeUndefined()
  })
})

/* ── ring:接力 ──────────────────────────────────────────────────────────── */

describe('ring:接力', () => {
  const policy = createCollabRingFloorPolicy()

  it('一次只传一根棒 —— 座位再多也不并发发环上的下一位', () => {
    const decision = policy.decide(input({
      sourceMessageId: 'm1',
      maxConcurrent: 4,
      params: { order: MEMBER_IDS },
    }))
    expect(granted(decision)).toEqual(['ana'])
    expect(decision.state).toEqual({ ringCursor: 1, ringLaps: 0 })
  })

  it('起棒要有由头 —— 空房换成接力不会自己数起数来', () => {
    // 没人被点名、没人举手、也没有一条消息触发这次决策(= 一次纯粹的换档)。
    const decision = policy.decide(input({ params: { order: MEMBER_IDS } }))
    expect(decision.grants).toEqual([])
    expect(decision.state).toBeUndefined()
  })

  it('@ 定起棒人:环上最靠前的那位被点名者接棒', () => {
    const decision = policy.decide(input({
      mentioned: ['bo'],
      maxConcurrent: 4,
      params: { order: MEMBER_IDS },
    }))
    // 起棒人是 bo(不是环首 ana),棒子随后落在他之后 —— 这就是「@ 定起棒人」。
    expect(granted(decision)).toEqual(['bo'])
    expect(decision.state).toEqual({ ringCursor: 2, ringLaps: 0 })
  })

  it('起棒取「环上最靠前」而不是「消息里写在最前」', () => {
    // 消息里先写 dan 后写 cy,但环上 cy 更靠前 —— 次序由房间配置决定,
    // 不由用户敲字的顺序决定,后者正是 `order` 这张表要消除的东西。
    const decision = policy.decide(input({
      mentioned: ['dan', 'cy'],
      maxConcurrent: 4,
      params: { order: MEMBER_IDS },
    }))
    // 两个都被 @ 到 = 两个都直通(@ 不排队,所以授牌序还是消息序);
    // 棒子跳到环上更靠后的那位(dan)之后,而不是在他们中间插一棒。
    expect(granted(decision)).toEqual(['dan', 'cy'])
    expect(decision.state).toEqual({ ringCursor: 0, ringLaps: 0 })
  })

  it('这一轮有人被点名开口 → 棒子等他们说完再传(一根棒子)', () => {
    const decision = policy.decide(input({
      mentioned: ['ana'],
      maxConcurrent: 4,
      params: { order: MEMBER_IDS },
    }))
    // 座位还剩三个,但环不会顺手再发一张 —— 接力就是一根棒子。
    expect(granted(decision)).toEqual(['ana'])
  })

  it('环序沿用 order,没列进去的按名册序接在后面', () => {
    const first = policy.decide(input({ sourceMessageId: 'm1', params: { order: ['cy'] } }))
    expect(granted(first)).toEqual(['cy'])
    const second = policy.decide(input({
      params: { order: ['cy'] },
      state: first.state ?? {},
    }))
    expect(granted(second)).toEqual(['ana'])
  })

  it('relayLoops 收棒:圈数到顶就不再发牌(收棒权在配置,不在模型)', () => {
    const decision = policy.decide(input({
      params: { order: MEMBER_IDS, relayLoops: 1 },
      state: { ringCursor: 0, ringLaps: 1 },
    }))
    expect(decision.grants).toEqual([])
  })

  it('relayLoops 缺省 0 = 不限,环一直转', () => {
    const decision = policy.decide(input({
      params: { order: MEMBER_IDS },
      state: { ringCursor: 0, ringLaps: 9 },
    }))
    expect(granted(decision)).toEqual(['ana'])
  })

  it('轮到的人正拿着牌:这一轮不发,棒子不往前挪', () => {
    const decision = policy.decide(input({
      holders: new Set(['ana']),
      activeLeases: 1,
      maxConcurrent: 1,
      params: { order: MEMBER_IDS },
      state: { ringCursor: 0, ringLaps: 0 },
    }))
    expect(decision.grants).toEqual([])
    expect(decision.state?.ringCursor).toBe(0)
  })

  it('接力免举手 —— 轮到谁谁说,这正是「免判定」的含义', () => {
    const decision = policy.decide(input({ sourceMessageId: 'm1', params: { order: MEMBER_IDS } }))
    expect(decision.grants[0]).toMatchObject({ agentId: 'ana', reason: 'relay' })
  })
})

/* ── waves:编排 ─────────────────────────────────────────────────────────── */

describe('waves:编排', () => {
  const policy = createCollabWavesFloorPolicy()
  const WAVES = [['ana'], ['bo', 'cy']]

  it('第一批整批发出去(批内并行)', () => {
    const decision = policy.decide(input({
      sourceMessageId: 'm1',
      maxConcurrent: 2,
      params: { waves: WAVES },
    }))
    expect(granted(decision)).toEqual(['ana'])
    expect(decision.state).toEqual({ waveIndex: 0, waveIssued: true, waveCount: 1 })
  })

  it('这一批还有人在说 → 不发下一批(批间串行)', () => {
    const decision = policy.decide(input({
      holders: new Set(['ana']),
      activeLeases: 1,
      maxConcurrent: 2,
      params: { waves: WAVES },
      state: { waveIndex: 0, waveIssued: true, waveCount: 1 },
    }))
    expect(decision.grants).toEqual([])
  })

  it('这一批的人都交牌了 → 推进到下一批,整批一起发', () => {
    const decision = policy.decide(input({
      maxConcurrent: 2,
      params: { waves: WAVES },
      state: { waveIndex: 0, waveIssued: true, waveCount: 1 },
    }))
    expect(granted(decision)).toEqual(['bo', 'cy'])
    expect(decision.state).toEqual({ waveIndex: 1, waveIssued: true, waveCount: 2 })
  })

  it('非循环编排走完最后一批就停', () => {
    const decision = policy.decide(input({
      maxConcurrent: 2,
      params: { waves: WAVES },
      state: { waveIndex: 1, waveIssued: true, waveCount: 2 },
    }))
    expect(decision.grants).toEqual([])
  })

  it('cycle 从头再来,relayLoops × 批数封顶', () => {
    const looped = policy.decide(input({
      maxConcurrent: 2,
      params: { waves: WAVES, cycle: true },
      state: { waveIndex: 1, waveIssued: true, waveCount: 2 },
    }))
    expect(granted(looped)).toEqual(['ana'])

    const capped = policy.decide(input({
      maxConcurrent: 2,
      // 2 圈 × 2 批 = 4 批封顶。
      params: { waves: WAVES, cycle: true, relayLoops: 2 },
      state: { waveIndex: 1, waveIssued: true, waveCount: 4 },
    }))
    expect(capped.grants).toEqual([])
  })

  it('@ 机械插批:被点名的人在编排之外直通', () => {
    const decision = policy.decide(input({
      mentioned: ['dan'],
      maxConcurrent: 4,
      params: { waves: WAVES },
    }))
    // dan 一个 wave 都不在,照样第一个拿牌;编排的第一批照常发。
    expect(granted(decision)).toEqual(['dan', 'ana'])
  })

  it('编排答空 → 回落 free 批量裁决,而不是让房间哑掉', () => {
    const decision = policy.decide(input({
      hands: [hand('ana', 10)],
      params: { waves: [], referee: true },
    }))
    expect(decision.openJudgment).toBe(true)

    const noReferee = policy.decide(input({ hands: [hand('bo', 10)], params: { waves: [] } }))
    expect(granted(noReferee)).toEqual(['bo'])
  })
})

/* ── phase:换相 ─────────────────────────────────────────────────────────── */

describe('phase:换相', () => {
  const policy = createCollabPhaseFloorPolicy()

  it('活跃相位的房照常按 FIFO 发牌', () => {
    const decision = policy.decide(input({
      hands: [hand('bo', 20), hand('ana', 10)],
      maxConcurrent: 2,
      params: { activeRooms: ['room-1'] },
    }))
    expect(granted(decision)).toEqual(['ana', 'bo'])
  })

  it('非活跃相位:一张牌都不发,手一只不丢', () => {
    const hands = [hand('ana', 10), hand('bo', 20)]
    const decision = policy.decide(input({
      hands,
      maxConcurrent: 2,
      params: { activeRooms: ['wolf-den'] },
    }))
    expect(decision.grants).toEqual([])
    // 策略是纯的 —— 它不动队列;挂起的语义由房间「只摘真发出去的手」实现。
    expect(hands).toHaveLength(2)
  })

  it('activeMembers 在房内再收一层:这一相里只有这些人能开口', () => {
    const decision = policy.decide(input({
      hands: [hand('ana', 10), hand('bo', 20)],
      maxConcurrent: 2,
      params: { activeRooms: ['room-1'], activeMembers: ['bo'] },
    }))
    expect(granted(decision)).toEqual(['bo'])
  })

  it('没配活跃房表 = 所有房都活跃 —— 一间没配相位的房不该被别人换相弄哑', () => {
    const decision = policy.decide(input({ hands: [hand('ana', 10)] }))
    expect(granted(decision)).toEqual(['ana'])
  })
})

/* ── 取策略 ─────────────────────────────────────────────────────────────── */

describe('resolveCollabFloorPolicy', () => {
  it('四档各自认得', () => {
    expect(resolveCollabFloorPolicy('free').name).toBe('free')
    expect(resolveCollabFloorPolicy('ring').name).toBe('ring')
    expect(resolveCollabFloorPolicy('waves').name).toBe('waves')
    expect(resolveCollabFloorPolicy('phase').name).toBe('phase')
  })

  it('认不出的名字回落 free,不抛 —— 一间账写坏的房应该照常能说话', () => {
    expect(resolveCollabFloorPolicy(undefined).name).toBe('free')
    expect(resolveCollabFloorPolicy('rong' as CollabFloorPolicyName).name).toBe('free')
  })
})

/* ── 房间设置 → 策略档(D6 接线) ────────────────────────────────────────── */

describe('resolveCollabRoomFloorPolicy:响应模式三件套 → 一档发言策略', () => {
  it("serial → ring:speakOrder 进环序,relayLoops 进收棒圈数", () => {
    expect(resolveCollabRoomFloorPolicy({
      responseMode: 'serial',
      speakOrder: ['cy', 'ana'],
      relayLoops: 2,
    })).toEqual({ name: 'ring', params: { order: ['cy', 'ana'], relayLoops: 2 } })
  })

  it('serial 不配次序表也能用:环退回名册序,params 里干脆没有那一格', () => {
    expect(resolveCollabRoomFloorPolicy({ responseMode: 'serial' })).toEqual({ name: 'ring' })
  })

  it('relayLoops 0 / 负数 = 不限,不进 params(账与快照少一处噪声)', () => {
    expect(resolveCollabRoomFloorPolicy({ responseMode: 'serial', relayLoops: 0 })).toEqual({ name: 'ring' })
    expect(resolveCollabRoomFloorPolicy({ responseMode: 'serial', relayLoops: -1 })).toEqual({ name: 'ring' })
  })

  it('auto → waves:编排由裁判下发,这里只把房间放到编排档上', () => {
    expect(resolveCollabRoomFloorPolicy({ responseMode: 'auto' })).toEqual({ name: 'waves' })
    expect(resolveCollabRoomFloorPolicy({ responseMode: 'auto', relayLoops: 3 }))
      .toEqual({ name: 'waves', params: { relayLoops: 3 } })
  })

  it('parallel / 未配 / 认不出 → free。**未配走 free 不走 auto**:翻默认是另一件事', () => {
    expect(resolveCollabRoomFloorPolicy({ responseMode: 'parallel' })).toEqual({ name: 'free' })
    expect(resolveCollabRoomFloorPolicy({})).toEqual({ name: 'free' })
    expect(resolveCollabRoomFloorPolicy(undefined)).toEqual({ name: 'free' })
    expect(resolveCollabRoomFloorPolicy({ responseMode: 'rong' as 'auto' })).toEqual({ name: 'free' })
  })

  it('私聊房一律 free:两个人本来就是"依次",再套一个环只会把人类排进去', () => {
    expect(resolveCollabRoomFloorPolicy({ responseMode: 'serial', dm: true })).toEqual({ name: 'free' })
    expect(resolveCollabRoomFloorPolicy({ responseMode: 'auto', dm: true })).toEqual({ name: 'free' })
  })

  it('phase 永远映射不出来 —— 它是裁判专属的一等表达,没有 v2 对应物', () => {
    const modes = ['auto', 'parallel', 'serial', undefined] as const
    for (const responseMode of modes) {
      expect(resolveCollabRoomFloorPolicy({ ...(responseMode ? { responseMode } : {}) }).name)
        .not.toBe('phase')
    }
  })
})

describe('isSameCollabRoomFloorPolicy:换没换档', () => {
  it('档名不同 = 换了', () => {
    expect(isSameCollabRoomFloorPolicy({ name: 'free' }, { name: 'ring' })).toBe(false)
  })

  it('undefined 与 0 圈是同一件事(不限),不该被读成一次换档', () => {
    expect(isSameCollabRoomFloorPolicy({ name: 'ring' }, { name: 'ring', params: { relayLoops: 0 } }))
      .toBe(true)
  })

  it('环序是**序列**相等:换个顺序就是换了档', () => {
    const before = { name: 'ring' as const, params: { order: ['ana', 'bo'] } }
    expect(isSameCollabRoomFloorPolicy(before, { name: 'ring', params: { order: ['ana', 'bo'] } })).toBe(true)
    expect(isSameCollabRoomFloorPolicy(before, { name: 'ring', params: { order: ['bo', 'ana'] } })).toBe(false)
  })

  it('裁判现场下发的那几格不参与比较 —— 否则每次装配都把在跑的编排打回原形', () => {
    expect(isSameCollabRoomFloorPolicy(
      { name: 'waves', params: { waves: [['ana'], ['bo', 'cy']], why: '先出稿再评审' } },
      { name: 'waves' },
    )).toBe(true)
  })
})
