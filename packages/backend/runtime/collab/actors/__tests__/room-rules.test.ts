import { describe, expect, it } from 'vitest'

import { validateFloorLeaseId } from '@onething/backend/core/actors'

import { COLLAB_SAY_SOURCE, isCollabRoomFact } from '../../classify.js'
import { computeCollabChainCount } from '../../chain.js'
import {
  COLLAB_SAY_REFUSED_BUDGET,
  COLLAB_SAY_REFUSED_EMPTY,
  COLLAB_SAY_REFUSED_FROZEN,
  COLLAB_SAY_REFUSED_NOT_MEMBER,
} from '../../say.js'
import { buildCollabChainHoldLine } from '../../system-lines.js'
import type { CollabAgentLike, CollabMessageLike } from '../../types.js'
import { collabFloorSeats, createCollabFreeFloorPolicy, orderCollabHands } from '../floor-policy.js'
import { collabRefereeVerdictVerb } from '../referee-rules.js'
import {
  collabAgentRaiseHand,
  collabAgentSpeak,
  collabAgentYield,
  collabActorRef,
  collabRoomPosted,
  type CollabActorVerb,
} from '../protocol.js'
import {
  applyCollabRoomPhaseChange,
  applyCollabRoomPosted,
  applyCollabRoomRaiseHand,
  applyCollabRoomSetPolicy,
  applyCollabRoomSpeak,
  applyCollabRoomYield,
  bumpCollabRoomEpoch,
  COLLAB_ROOM_FROZEN_LINE,
  COLLAB_ROOM_FROZEN_LINE_DM,
  COLLAB_SPEAK_REFUSED_EXPIRED_LEASE,
  COLLAB_SPEAK_REFUSED_LEASE_OWNER,
  COLLAB_SPEAK_REFUSED_NO_LEASE,
  COLLAB_SPEAK_REFUSED_STALE_LEASE,
  collabRoomHolders,
  createCollabRoomAccount,
  foldCollabRoomChain,
  normalizeCollabRoomAccount,
  pruneCollabRoomFloor,
  type CollabRoomAccount,
  type CollabRoomGates,
  type CollabRoomIdSource,
  type CollabRoomStep,
} from '../room-rules.js'

const ROOM = 'room-1'
const IDS: CollabRoomIdSource = { newMessageId: seed => seed }

const MEMBERS: CollabAgentLike[] = [
  { id: 'ana', name: '阿娜' },
  { id: 'bo', name: '阿波' },
  { id: 'cy', name: '小西' },
  { id: 'dan', name: '阿丹' },
]

function gates(overrides: Partial<CollabRoomGates> = {}): CollabRoomGates {
  return {
    frozen: false,
    overBudget: false,
    maxChain: Number.POSITIVE_INFINITY,
    maxConcurrent: 0,
    members: MEMBERS,
    now: 1_000,
    ...overrides,
  }
}

function userSays(text: string, mentionIds: string[] = [], id = 'u1'): CollabMessageLike {
  return {
    id,
    role: 'user',
    content: text,
    timestamp: 1_000,
    ...(mentionIds.length
      ? { mentions: mentionIds.map(agentId => ({ agentId, label: agentId })) }
      : {}),
  }
}

function postUser(
  account: CollabRoomAccount,
  message: CollabMessageLike,
  overrides: Partial<CollabRoomGates> = {},
) {
  return applyCollabRoomPosted(
    account,
    collabRoomPosted({ roomId: ROOM, author: collabActorRef('user', 'user'), message }),
    gates(overrides),
    IDS,
  )
}

describe('发言权租约', () => {
  it('并发上限恰好放行 k 条,多出来的进举手队列', () => {
    const step = postUser(
      createCollabRoomAccount(ROOM),
      userSays('@阿娜 @阿波 @小西 一起看看', ['ana', 'bo', 'cy']),
      { maxConcurrent: 2 },
    )

    expect(step.effects.granted.map(lease => lease.agentId)).toEqual(['ana', 'bo'])
    // 第三个被点名的人不是被丢掉,是排到队首等座位。
    expect(step.account.hands.map(hand => `${hand.agentId}:${hand.origin}`)).toEqual(['cy:mention'])
    expect(step.account.chainCount).toBe(2)
  })

  it('0 = 不限:全部被 @ 的人一次拿到牌', () => {
    const step = postUser(
      createCollabRoomAccount(ROOM),
      userSays('全员', ['ana', 'bo', 'cy', 'dan']),
      { maxConcurrent: 0 },
    )
    expect(step.effects.granted).toHaveLength(4)
    expect(step.account.hands).toEqual([])
  })

  it('同一个 agent 不并发持两张同房租约', () => {
    // 同一条消息里点两次名 + 它自己也举过手 —— 三条来路,一张牌。
    let account = createCollabRoomAccount(ROOM)
    account = applyCollabRoomRaiseHand(
      account,
      collabAgentRaiseHand({ roomId: ROOM, agentId: 'ana' }),
      gates({ maxChain: 0 }),
      IDS,
    ).account
    expect(collabRoomHolders(account, 1_000).size).toBe(0)

    const step = postUser(account, userSays('@阿娜 @阿娜', ['ana', 'ana']), { maxConcurrent: 5 })
    expect(step.effects.granted).toHaveLength(1)
    expect(step.account.chainCount).toBe(1)
  })

  it('换代:在外的旧牌一律作废,拿旧牌说话被拒', () => {
    const granted = postUser(createCollabRoomAccount(ROOM), userSays('@阿娜', ['ana']))
    const lease = granted.effects.granted[0]

    const bumped = bumpCollabRoomEpoch(granted.account, 'epoch-bumped', 2_000)
    expect(bumped.effects.broadcast.map(verb => verb.type)).toEqual(['room:floor-revoked'])
    expect(bumped.account.floor.epoch).toBe(granted.account.floor.epoch + 1)

    const spoke = applyCollabRoomSpeak(
      bumped.account,
      collabAgentSpeak({ roomId: ROOM, agentId: 'ana', leaseId: lease.leaseId, content: '我来说' }),
      gates({ now: 2_000 }),
      IDS,
    )
    // 换代之后旧牌验出来是 stale-epoch 还是 unknown,取决于账有没有被 prune 过。
    // 两者都是「这张牌不作数了」,措辞各自可操作。
    expect([COLLAB_SPEAK_REFUSED_STALE_LEASE, COLLAB_SPEAK_REFUSED_NO_LEASE])
      .toContain(spoke.effects.refusal)
    expect(spoke.effects.messages).toEqual([])
  })

  it('换相即换代,并清空举手队列', () => {
    const posted = postUser(createCollabRoomAccount(ROOM), userSays('@阿娜 @阿波', ['ana', 'bo']), {
      maxConcurrent: 1,
    })
    expect(posted.account.hands).toHaveLength(1)

    const phased = applyCollabRoomPhaseChange(posted.account, 'night', 3_000)
    expect(phased.account.phase).toBe('night')
    expect(phased.account.hands).toEqual([])
    expect(phased.effects.broadcast.at(-1)).toMatchObject({ type: 'room:phase-changed', phase: 'night' })
  })

  it('过期回收:牌超时收回,空出来的座位立刻补给队里下一个', () => {
    const ttl = gates({ maxConcurrent: 1, leaseTtlMs: 500 })
    const posted = applyCollabRoomPosted(
      createCollabRoomAccount(ROOM),
      collabRoomPosted({
        roomId: ROOM,
        author: collabActorRef('user', 'user'),
        message: userSays('@阿娜 @阿波', ['ana', 'bo']),
      }),
      ttl,
      IDS,
    )
    expect(posted.effects.granted.map(lease => lease.agentId)).toEqual(['ana'])

    const swept = pruneCollabRoomFloor(posted.account, { ...ttl, now: 1_600 }, IDS)
    const kinds = swept.effects.broadcast.map(verb => verb.type)
    expect(kinds).toEqual(['room:floor-revoked', 'room:floor-granted'])
    expect(swept.effects.granted.map(lease => lease.agentId)).toEqual(['bo'])
  })

  it('过期的牌开口被拒,措辞说的是"超时收回"而不是"没有发言权"', () => {
    const ttl = gates({ leaseTtlMs: 500 })
    const posted = applyCollabRoomPosted(
      createCollabRoomAccount(ROOM),
      collabRoomPosted({
        roomId: ROOM,
        author: collabActorRef('user', 'user'),
        message: userSays('@阿娜', ['ana']),
      }),
      ttl,
      IDS,
    )
    const lease = posted.effects.granted[0]
    const spoke = applyCollabRoomSpeak(
      posted.account,
      collabAgentSpeak({ roomId: ROOM, agentId: 'ana', leaseId: lease.leaseId, content: '慢了' }),
      { ...ttl, now: 1_600 },
      IDS,
    )
    expect(spoke.effects.refusal).toBe(COLLAB_SPEAK_REFUSED_EXPIRED_LEASE)
  })

  it('拿别人的牌说话被拒(防冒名)', () => {
    const posted = postUser(createCollabRoomAccount(ROOM), userSays('@阿娜', ['ana']))
    const lease = posted.effects.granted[0]
    const spoke = applyCollabRoomSpeak(
      posted.account,
      collabAgentSpeak({ roomId: ROOM, agentId: 'bo', leaseId: lease.leaseId, content: '我替 TA 说' }),
      gates(),
      IDS,
    )
    expect(spoke.effects.refusal).toBe(COLLAB_SPEAK_REFUSED_LEASE_OWNER)
  })

  it('没牌就开口被拒', () => {
    const spoke = applyCollabRoomSpeak(
      createCollabRoomAccount(ROOM),
      collabAgentSpeak({ roomId: ROOM, agentId: 'ana', leaseId: 'nope', content: '插一句' }),
      gates(),
      IDS,
    )
    expect(spoke.effects.refusal).toBe(COLLAB_SPEAK_REFUSED_NO_LEASE)
  })

  it('让位之后座位立刻给队里下一个', () => {
    const posted = postUser(createCollabRoomAccount(ROOM), userSays('@阿娜 @阿波', ['ana', 'bo']), {
      maxConcurrent: 1,
    })
    const lease = posted.effects.granted[0]

    const yielded = applyCollabRoomYield(
      posted.account,
      collabAgentYield({ roomId: ROOM, agentId: 'ana', leaseId: lease.leaseId, reason: 'done' }),
      gates({ maxConcurrent: 1 }),
      IDS,
    )
    expect(yielded.effects.granted.map(entry => entry.agentId)).toEqual(['bo'])
    expect(validateFloorLeaseId(yielded.account.floor, lease.leaseId, 1_000).valid).toBe(false)
  })
})

describe('链账', () => {
  it('人类消息清零,并把闩锁一起放开', () => {
    let account: CollabRoomAccount = {
      ...createCollabRoomAccount(ROOM),
      chainCount: 7,
      notices: { frozen: true, budget: true, chain: true },
    }
    account = postUser(account, userSays('我来插一句', [], 'u-reset')).account
    expect(account.chainCount).toBe(0)
    expect(account.chainResetMessageId).toBe('u-reset')
    expect(account.notices).toEqual({ frozen: false, budget: false, chain: false })
  })

  it('带 collabChainReset 标记的外部注入同样清零(A2 的可重放那一半)', () => {
    const injected: CollabMessageLike = {
      id: 'x1',
      role: 'assistant',
      agentId: 'ana',
      content: '隔壁房那边有新情况',
      timestamp: 1_000,
      source: COLLAB_SAY_SOURCE,
      collabChainReset: true,
    }
    const step = applyCollabRoomPosted(
      { ...createCollabRoomAccount(ROOM), chainCount: 5 },
      collabRoomPosted({ roomId: ROOM, author: collabActorRef('agent', 'ana'), message: injected }),
      gates(),
      IDS,
    )
    expect(step.account.chainCount).toBe(0)
  })

  it('链数就是发出的租约数 —— 说几句话不改变它', () => {
    const posted = postUser(createCollabRoomAccount(ROOM), userSays('@阿娜', ['ana']))
    expect(posted.account.chainCount).toBe(1)

    const lease = posted.effects.granted[0]
    let account = posted.account
    for (const text of ['第一句', '第二句', '第三句']) {
      account = applyCollabRoomSpeak(
        account,
        collabAgentSpeak({ roomId: ROOM, agentId: 'ana', leaseId: lease.leaseId, content: text }),
        gates(),
        IDS,
      ).account
    }
    // v2 会数成 3(它数的是说出口的句子);v3 数的是"轮到几次",一张牌一格。
    expect(account.chainCount).toBe(1)
  })

  it('重放对账:live 的链数与从动词流重算的相等', () => {
    const verbs: CollabActorVerb[] = []
    const record = (step: { effects: { broadcast: CollabActorVerb[] } }): void => {
      verbs.push(...step.effects.broadcast)
    }

    let account = createCollabRoomAccount(ROOM)
    const g = gates({ maxChain: 10, maxConcurrent: 1 })

    // 一段真实形状的剧本:人类点名 → 说话 → 让位 → 另一个人举手 → 说话 → 人类插话。
    let step = applyCollabRoomPosted(
      account,
      collabRoomPosted({
        roomId: ROOM,
        author: collabActorRef('user', 'user'),
        message: userSays('@阿娜 看一下', ['ana'], 'r1'),
      }),
      g,
      IDS,
    )
    account = step.account
    record(step)

    const first = step.effects.granted[0]
    step = applyCollabRoomSpeak(
      account,
      collabAgentSpeak({ roomId: ROOM, agentId: 'ana', leaseId: first.leaseId, content: '看完了' }),
      g,
      IDS,
    )
    account = step.account
    record(step)

    step = applyCollabRoomYield(
      account,
      collabAgentYield({ roomId: ROOM, agentId: 'ana', leaseId: first.leaseId }),
      g,
      IDS,
    )
    account = step.account
    record(step)

    step = applyCollabRoomRaiseHand(account, collabAgentRaiseHand({ roomId: ROOM, agentId: 'bo' }), g, IDS)
    account = step.account
    record(step)
    expect(account.chainCount).toBe(2)

    step = applyCollabRoomPosted(
      account,
      collabRoomPosted({
        roomId: ROOM,
        author: collabActorRef('user', 'user'),
        message: userSays('好了,换个话题', [], 'r2'),
      }),
      g,
      IDS,
    )
    account = step.account
    record(step)

    expect(foldCollabRoomChain(verbs)).toBe(account.chainCount)
  })

  it('链闸顶格:停发牌,贴一次系统行,同一段只贴一次', () => {
    const g = gates({ maxChain: 1, maxConcurrent: 4 })
    const first = postUser(createCollabRoomAccount(ROOM), userSays('@阿娜', ['ana'], 'm1'), {
      maxChain: 1,
      maxConcurrent: 4,
    })
    expect(first.account.chainCount).toBe(1)

    const blocked = applyCollabRoomRaiseHand(
      first.account,
      collabAgentRaiseHand({ roomId: ROOM, agentId: 'bo' }),
      g,
      IDS,
    )
    expect(blocked.effects.granted).toEqual([])
    expect(blocked.effects.messages.map(message => message.content))
      .toEqual([buildCollabChainHoldLine({ maxChain: 1 })])
    // 手留在队里等清零 —— 不是被丢掉。
    expect(blocked.account.hands.map(hand => hand.agentId)).toEqual(['bo'])

    const again = applyCollabRoomRaiseHand(
      blocked.account,
      collabAgentRaiseHand({ roomId: ROOM, agentId: 'cy' }),
      g,
      IDS,
    )
    expect(again.effects.messages).toEqual([])

    // 人类一句话:清零 + 闩锁放开 + 队里两只手一起放行。
    const resumed = postUser(again.account, userSays('继续吧', [], 'm2'), { maxChain: 1, maxConcurrent: 4 })
    expect(resumed.effects.granted.map(lease => lease.agentId)).toEqual(['bo'])
    expect(resumed.account.chainCount).toBe(1)
  })

  it('pairDm 的链闸文案说的是这间房真实的解冻条件', () => {
    const blocked = applyCollabRoomRaiseHand(
      { ...createCollabRoomAccount(ROOM), chainCount: 6 },
      collabAgentRaiseHand({ roomId: ROOM, agentId: 'bo' }),
      gates({ maxChain: 6, pairDm: true }),
      IDS,
    )
    expect(blocked.effects.messages[0].content).toBe(
      buildCollabChainHoldLine({ maxChain: 6, pairDm: true }),
    )
  })
})

describe('冻结与预算', () => {
  it('冻结吃掉一个 @ 会说出来,而且一次冻结只说一次', () => {
    const frozen = { frozen: true }
    const first = postUser(createCollabRoomAccount(ROOM), userSays('@阿娜 看一下', ['ana'], 'f1'), frozen)
    expect(first.effects.granted).toEqual([])
    expect(first.effects.messages.map(message => message.content)).toEqual([COLLAB_ROOM_FROZEN_LINE])

    const second = postUser(first.account, userSays('@阿波 你呢', ['bo'], 'f2'), frozen)
    expect(second.effects.messages).toEqual([])
  })

  it('没人想说话时,冻结不吭声', () => {
    const step = postUser(createCollabRoomAccount(ROOM), userSays('随便说说', [], 'f3'), { frozen: true })
    expect(step.effects.messages).toEqual([])
    expect(step.account.notices.frozen).toBe(false)
  })

  it('私聊房的冻结行不说"无人应答"', () => {
    const step = postUser(createCollabRoomAccount(ROOM), userSays('@阿娜', ['ana']), {
      frozen: true,
      pairDm: true,
    })
    expect(step.effects.messages[0].content).toBe(COLLAB_ROOM_FROZEN_LINE_DM)
  })

  it('冻结的房间里 speak 被拒,文案沿用 v2', () => {
    const posted = postUser(createCollabRoomAccount(ROOM), userSays('@阿娜', ['ana']))
    const lease = posted.effects.granted[0]
    const spoke = applyCollabRoomSpeak(
      posted.account,
      collabAgentSpeak({ roomId: ROOM, agentId: 'ana', leaseId: lease.leaseId, content: '还是要说' }),
      gates({ frozen: true }),
      IDS,
    )
    expect(spoke.effects.refusal).toBe(COLLAB_SAY_REFUSED_FROZEN)
  })

  it('超预算:不发牌,贴一次带数字的行', () => {
    const over = { overBudget: true, budgetSpentUSD: 5.25, budgetLimitUSD: 5 }
    const step = postUser(createCollabRoomAccount(ROOM), userSays('@阿娜', ['ana']), over)
    expect(step.effects.granted).toEqual([])
    expect(step.effects.messages[0].content).toBe(
      '今天这个房间已花费 $5.25,达到日预算 $5——明天自动恢复,或调整房间预算',
    )
    const second = postUser(step.account, userSays('@阿波', ['bo']), over)
    expect(second.effects.messages).toEqual([])
  })

  it('超预算的房间里 speak 被拒;被移出群的成员同样', () => {
    const posted = postUser(createCollabRoomAccount(ROOM), userSays('@阿娜', ['ana']))
    const lease = posted.effects.granted[0]
    const speak = collabAgentSpeak({
      roomId: ROOM,
      agentId: 'ana',
      leaseId: lease.leaseId,
      content: '还有话说',
    })

    expect(applyCollabRoomSpeak(posted.account, speak, gates({ overBudget: true }), IDS).effects.refusal)
      .toBe(COLLAB_SAY_REFUSED_BUDGET)
    expect(applyCollabRoomSpeak(posted.account, speak, gates({ members: [MEMBERS[1]] }), IDS).effects.refusal)
      .toBe(COLLAB_SAY_REFUSED_NOT_MEMBER)
    expect(applyCollabRoomSpeak(
      posted.account,
      collabAgentSpeak({ roomId: ROOM, agentId: 'ana', leaseId: lease.leaseId, content: '   ' }),
      gates(),
      IDS,
    ).effects.refusal).toBe(COLLAB_SAY_REFUSED_EMPTY)
  })
})

describe('转录', () => {
  it('落下的发言是一条 v2 读得懂的 say —— 分类/投影语义一致', () => {
    const posted = postUser(createCollabRoomAccount(ROOM), userSays('@阿娜', ['ana']))
    const lease = posted.effects.granted[0]
    const spoke = applyCollabRoomSpeak(
      posted.account,
      collabAgentSpeak({
        roomId: ROOM,
        agentId: 'ana',
        leaseId: lease.leaseId,
        content: '看完了,@阿波 你接着说',
        mentions: [{ agentId: 'bo', label: '阿波' }],
      }),
      gates(),
      IDS,
    )

    const message = spoke.effects.messages[0]
    expect(message.role).toBe('assistant')
    expect(message.agentId).toBe('ana')
    expect(message.source).toBe(COLLAB_SAY_SOURCE)
    expect(isCollabRoomFact(message)).toBe(true)
    // v2 的转录重算把它数成一格发言 —— 格式兼容的最硬判据。
    expect(computeCollabChainCount([message])).toBe(1)
    expect(message.mentions?.map(mention => mention.agentId)).toContain('bo')
    // 说话里的 @ 同样是直通授牌。
    expect(spoke.effects.granted.map(entry => entry.agentId)).toEqual(['bo'])
  })

  it('系统行是运营噪声:进不了模型视野', () => {
    const step = postUser(createCollabRoomAccount(ROOM), userSays('@阿娜', ['ana']), { frozen: true })
    const line = step.effects.messages[0]
    expect(line.role).toBe('system')
    expect(line.source).toBeUndefined()
    expect(isCollabRoomFact(line)).toBe(false)
  })

  it('水位只前进', () => {
    let account = postUser(createCollabRoomAccount(ROOM), {
      id: 'late',
      role: 'user',
      content: '后到的',
      timestamp: 5_000,
    }).account
    expect(account.watermark).toEqual({ messageId: 'late', at: 5_000 })

    account = postUser(account, { id: 'early', role: 'user', content: '先发的', timestamp: 2_000 }).account
    expect(account.watermark.messageId).toBe('late')
  })
})

describe('策略与账的形状', () => {
  it('free:@ 直通,其余 FIFO,被点名的手排在普通举手之前', () => {
    const policy = createCollabFreeFloorPolicy()
    const decision = policy.decide({
      mentioned: ['dan'],
      hands: [
        { agentId: 'ana', at: 10, origin: 'hand', reason: 'self-elected' },
        { agentId: 'cy', at: 30, origin: 'mention', reason: 'mention' },
        { agentId: 'bo', at: 20, origin: 'hand', reason: 'self-elected' },
      ],
      holders: new Set(),
      activeLeases: 0,
      maxConcurrent: 0,
      members: MEMBERS.map(member => member.id),
    })
    expect(decision.grants.map(grant => grant.agentId)).toEqual(['dan', 'cy', 'ana', 'bo'])
  })

  it('orderCollabHands 不动输入数组', () => {
    const hands = [
      { agentId: 'bo', at: 20, origin: 'hand' as const, reason: 'self-elected' as const },
      { agentId: 'ana', at: 10, origin: 'hand' as const, reason: 'self-elected' as const },
    ]
    expect(orderCollabHands(hands).map(hand => hand.agentId)).toEqual(['ana', 'bo'])
    expect(hands.map(hand => hand.agentId)).toEqual(['bo', 'ana'])
  })

  it('座位换算:0 与负数都是不限', () => {
    expect(collabFloorSeats({ activeLeases: 3, maxConcurrent: 0 })).toBe(Number.POSITIVE_INFINITY)
    expect(collabFloorSeats({ activeLeases: 3, maxConcurrent: -1 })).toBe(Number.POSITIVE_INFINITY)
    expect(collabFloorSeats({ activeLeases: 3, maxConcurrent: 2 })).toBe(0)
    expect(collabFloorSeats({ activeLeases: 1, maxConcurrent: 4 })).toBe(3)
  })

  it('读回来的账形状不对就当新账,而不是半份账', () => {
    expect(normalizeCollabRoomAccount(null, ROOM)).toEqual(createCollabRoomAccount(ROOM))
    expect(normalizeCollabRoomAccount({ version: 99 }, ROOM)).toEqual(createCollabRoomAccount(ROOM))

    const good = postUser(createCollabRoomAccount(ROOM), userSays('@阿娜', ['ana'])).account
    const roundTrip = normalizeCollabRoomAccount(JSON.parse(JSON.stringify(good)), ROOM)
    expect(roundTrip).toEqual(good)
  })

  it('seq 每一次状态变化都 +1', () => {
    const first = postUser(createCollabRoomAccount(ROOM), userSays('一', [], 'a'))
    expect(first.account.seq).toBe(1)
    const second = postUser(first.account, userSays('二', [], 'b'))
    expect(second.account.seq).toBe(2)
  })
})

/* ── 降级留痕(D8 观测体系 O2 前置修)────────────────────────────────────── */

describe('裁决降级的痕', () => {
  /** 挂了裁判的房 —— `free` 的举手先进裁决窗。 */
  const refereeGates = (overrides: Partial<CollabRoomGates> = {}): CollabRoomGates =>
    gates({ referee: true, ...overrides })

  /** 开一扇窗:一条消息 + 一只手。返回账与窗的 token。 */
  function openWindow(
    account: CollabRoomAccount,
    options: { messageId?: string; agentId?: string; now?: number } = {},
  ): { account: CollabRoomAccount; token: string } {
    const messageId = options.messageId ?? 'm1'
    const now = options.now ?? 1_000
    const posted = applyCollabRoomPosted(
      account,
      collabRoomPosted({
        roomId: ROOM,
        author: collabActorRef('user', 'user'),
        message: userSays('看看', [], messageId),
      }),
      refereeGates({ now }),
      IDS,
    )
    const raised = applyCollabRoomRaiseHand(
      posted.account,
      collabAgentRaiseHand({ roomId: ROOM, agentId: options.agentId ?? 'ana', sourceMessageId: messageId }),
      refereeGates({ now }),
      IDS,
    )
    const token = raised.account.judgment?.token
    expect(token).toBeDefined()
    return { account: raised.account, token: token! }
  }

  function verdict(
    account: CollabRoomAccount,
    input: { token: string; grants?: string[]; why?: string; degraded?: boolean; now?: number },
  ): CollabRoomStep {
    return applyCollabRoomSetPolicy(
      account,
      collabRefereeVerdictVerb({
        roomId: ROOM,
        refereeId: 'referee',
        verdict: {
          token: input.token,
          grants: input.grants ?? [],
          ...(input.why ? { why: input.why } : {}),
          ...(input.degraded ? { degraded: true } : {}),
        },
      }),
      refereeGates({ now: input.now ?? 2_000 }),
      IDS,
    )
  }

  // 这一条就是 O1 记下的那个缺口:窗在同一个同步步里被 `grantFloor` 关掉,
  // `judgment: 'degraded'` 因此从来没活到任何一次快照组装 —— 黄牌没地方站。
  it('降级之后窗当场关掉,但痕留在账上(这正是快照读得到黄牌的唯一途径)', () => {
    const opened = openWindow(createCollabRoomAccount(ROOM))
    const stepped = verdict(opened.account, { token: opened.token, degraded: true, why: 'timeout', now: 2_000 })

    expect(stepped.account.judgment).toBeUndefined()
    expect(stepped.account.lastDegraded).toEqual({ reason: 'timeout', at: 2_000 })
  })

  it('没给理由时留一句诚实的占位 —— 完整成因在时间轴的 judge-degraded 行上', () => {
    const opened = openWindow(createCollabRoomAccount(ROOM))
    const stepped = verdict(opened.account, { token: opened.token, degraded: true, now: 2_000 })
    expect(stepped.account.lastDegraded).toEqual({ reason: 'unspecified', at: 2_000 })
  })

  it('正常裁决不留痕 —— 只有失败才亮牌', () => {
    const opened = openWindow(createCollabRoomAccount(ROOM))
    const stepped = verdict(opened.account, { token: opened.token, grants: ['ana'], why: '她提的问题' })
    expect(stepped.account.lastDegraded).toBeUndefined()
  })

  // 清痕的判据是「这间房又去买了一次裁决」,不是「又来了一条消息」:在下一扇窗
  // 开出来之前,上一次降级一直是这间房现在这个样子的解释。
  it('痕活到下一次开窗才清,中间的普通消息不清它', () => {
    const opened = openWindow(createCollabRoomAccount(ROOM))
    const degraded = verdict(opened.account, { token: opened.token, degraded: true, why: 'timeout', now: 2_000 })

    // 一条谁都没 @ 的消息:不开窗,痕照旧在。
    const chatter = applyCollabRoomPosted(
      degraded.account,
      collabRoomPosted({
        roomId: ROOM,
        author: collabActorRef('user', 'user'),
        message: userSays('随便说说', [], 'm2'),
      }),
      refereeGates({ now: 3_000 }),
      IDS,
    )
    expect(chatter.account.lastDegraded).toEqual({ reason: 'timeout', at: 2_000 })

    // 又有人举手 → 新窗开出来,上一次降级才算翻篇。
    const reopened = openWindow(chatter.account, { messageId: 'm3', agentId: 'bo', now: 4_000 })
    expect(reopened.account.judgment?.state).toBe('pending')
    expect(reopened.account.lastDegraded).toBeUndefined()
  })

  it('痕过得了一次落盘往返 —— 形状不对的当没降级过', () => {
    const opened = openWindow(createCollabRoomAccount(ROOM))
    const degraded = verdict(opened.account, { token: opened.token, degraded: true, why: 'timeout', now: 2_000 })
    const roundTrip = normalizeCollabRoomAccount(
      JSON.parse(JSON.stringify(degraded.account)),
      ROOM,
    )
    expect(roundTrip.lastDegraded).toEqual({ reason: 'timeout', at: 2_000 })

    const broken = normalizeCollabRoomAccount(
      { ...JSON.parse(JSON.stringify(degraded.account)), lastDegraded: { reason: 'timeout' } },
      ROOM,
    )
    expect(broken.lastDegraded).toBeUndefined()
  })
})

/* ── 裁后放手(真机走查:幽灵排队)──────────────────────────────────────── */

/**
 * 裁决是对**这一批候选**的终审 —— 没被点名的手当场放下。
 *
 * 走查现场:4 人举手、裁判答空,四只手原地留队,状态条永远写着「4 人排队中」而
 * 座位 0/6 全空。旧行为的前提是「一只手代表一个还没兑现的意愿」,D6-a 把举手判据
 * 换成"每条房间事实人人机械举手"之后那个前提就没了 —— 下一条消息全员重新举手,
 * 留旧手防不住任何东西,只留下幽灵队列与掺进新话题的旧手。
 */
describe('裁决之后手的去留', () => {
  const refereeGates = (overrides: Partial<CollabRoomGates> = {}): CollabRoomGates =>
    gates({ referee: true, ...overrides })

  /** 一条消息 + 若干只手 → 一扇开着的窗。 */
  function openWindow(
    agentIds: readonly string[],
    options: { maxConcurrent?: number; now?: number } = {},
  ): { account: CollabRoomAccount; token: string } {
    const now = options.now ?? 1_000
    const g = refereeGates({ now, ...(options.maxConcurrent === undefined ? {} : { maxConcurrent: options.maxConcurrent }) })
    let account = applyCollabRoomPosted(
      createCollabRoomAccount(ROOM),
      collabRoomPosted({
        roomId: ROOM,
        author: collabActorRef('user', 'user'),
        message: userSays('大家看看', [], 'm1'),
      }),
      g,
      IDS,
    ).account
    for (const agentId of agentIds) {
      account = applyCollabRoomRaiseHand(
        account,
        collabAgentRaiseHand({ roomId: ROOM, agentId, sourceMessageId: 'm1' }),
        g,
        IDS,
      ).account
    }
    const token = account.judgment?.token
    expect(token).toBeDefined()
    return { account, token: token! }
  }

  /** 投一份裁决。`candidates` = 裁判现取的那批(缺省 = 队里此刻全部)。 */
  function verdict(
    account: CollabRoomAccount,
    input: {
      token: string
      grants?: string[]
      candidates?: string[]
      degraded?: boolean
      maxConcurrent?: number
      now?: number
    },
  ): CollabRoomStep {
    return applyCollabRoomSetPolicy(
      account,
      collabRefereeVerdictVerb({
        roomId: ROOM,
        refereeId: 'referee',
        verdict: {
          token: input.token,
          grants: input.grants ?? [],
          candidates: input.candidates ?? account.hands.map(hand => hand.agentId),
          ...(input.degraded ? { degraded: true } : {}),
        },
      }),
      refereeGates({
        now: input.now ?? 2_000,
        ...(input.maxConcurrent === undefined ? {} : { maxConcurrent: input.maxConcurrent }),
      }),
      IDS,
    )
  }

  it('空裁决 = 全放下:四只手一只不剩,队列当场清零', () => {
    const opened = openWindow(['ana', 'bo', 'cy', 'dan'])
    expect(opened.account.hands).toHaveLength(4)

    const stepped = verdict(opened.account, { token: opened.token, grants: [] })

    // 「这轮无人发言」是一个合法答案,手随消息走 —— 不留幽灵队列。
    expect(stepped.account.hands).toEqual([])
    expect(stepped.effects.granted).toEqual([])
    expect(stepped.account.judgment).toBeUndefined()
  })

  it('点名的留、没点名的放下:单座位下点名者渐进兑现', () => {
    const opened = openWindow(['ana', 'bo', 'cy'], { maxConcurrent: 1 })
    const stepped = verdict(opened.account, {
      token: opened.token,
      grants: ['bo', 'ana'],
      maxConcurrent: 1,
    })

    // bo 拿牌;ana 被点名了,留在队里等 bo 让位(D3 的分批兑现,别破坏);
    // cy 判过没点名 —— 放下。
    expect(stepped.effects.granted.map(lease => lease.agentId)).toEqual(['bo'])
    expect(stepped.account.hands.map(hand => hand.agentId)).toEqual(['ana'])
    // 那半份裁决留在窗里 —— 让位时直接上场,不必再买一次调用。
    expect(stepped.account.judgment?.state).toBe('resolved')
    expect(stepped.account.judgment?.grants).toEqual(['ana'])
  })

  it('残余的半份裁决不再放手:被放下的人重新举手不会被旧答案再放一次', () => {
    const opened = openWindow(['ana', 'bo', 'cy'], { maxConcurrent: 1 })
    const stepped = verdict(opened.account, {
      token: opened.token,
      grants: ['bo', 'ana'],
      maxConcurrent: 1,
    })
    // 窗还开着(ana 那半份没兑现),但它的候选集已经清空 —— 放手是一次性的。
    expect(stepped.account.judgment?.candidates).toEqual([])

    // cy 为下一条消息重新举手:它必须活着,而不是被上一份答案再放一次。
    const again = applyCollabRoomRaiseHand(
      stepped.account,
      collabAgentRaiseHand({ roomId: ROOM, agentId: 'cy', sourceMessageId: 'm2' }),
      refereeGates({ now: 3_000, maxConcurrent: 1 }),
      IDS,
    )
    expect(again.account.hands.map(hand => hand.agentId)).toEqual(['ana', 'cy'])
  })

  it('窗在飞期间才举的手不连坐:空裁决之后它活着,并开出下一扇窗', () => {
    const opened = openWindow(['ana', 'bo'])
    // 裁判现取候选之后 dan 才举手 —— 它一次都没被判过。
    const late = applyCollabRoomRaiseHand(
      opened.account,
      collabAgentRaiseHand({ roomId: ROOM, agentId: 'dan', sourceMessageId: 'm1' }),
      refereeGates({ now: 1_500 }),
      IDS,
    ).account

    const stepped = verdict(late, { token: opened.token, grants: [], candidates: ['ana', 'bo'] })
    expect(stepped.account.hands.map(hand => hand.agentId)).toEqual(['dan'])

    // 下一条房间事实来了 —— 它进新一扇窗,而不是永远挂着。
    const next = applyCollabRoomPosted(
      stepped.account,
      collabRoomPosted({
        roomId: ROOM,
        author: collabActorRef('user', 'user'),
        message: userSays('再看一眼', [], 'm2'),
      }),
      refereeGates({ now: 3_000 }),
      IDS,
    )
    expect(next.account.judgment?.state).toBe('pending')
    expect(next.account.judgment?.candidates).toEqual(['dan'])
  })

  it('降级不放手:回落 FIFO,手被消费成授牌(D1 的行为一字不差)', () => {
    const opened = openWindow(['ana', 'bo', 'cy'], { maxConcurrent: 2 })
    const stepped = verdict(opened.account, {
      token: opened.token,
      degraded: true,
      maxConcurrent: 2,
    })

    // 两个座位:前两只手成了牌,第三只等座位 —— 一只都不是被"裁后放手"放掉的。
    expect(stepped.effects.granted.map(lease => lease.agentId)).toEqual(['ana', 'bo'])
    expect(stepped.account.hands.map(hand => hand.agentId)).toEqual(['cy'])
  })

  it('旧账缺候选集:按「这一批就是全部」处理 —— 存量僵尸手自愈,不炸', () => {
    const opened = openWindow(['ana', 'bo'])
    // 模拟一份修复之前落盘的账:窗上没有 `candidates` 那一格。
    const legacy = normalizeCollabRoomAccount(
      {
        ...JSON.parse(JSON.stringify(opened.account)),
        judgment: { token: opened.token, openedAt: 1_000, state: 'pending' },
      },
      ROOM,
    )
    expect(legacy.judgment?.candidates).toBeUndefined()

    // 裁决也不带候选集(老裁判进程投回来的那种)。
    const stepped = applyCollabRoomSetPolicy(
      legacy,
      collabRefereeVerdictVerb({
        roomId: ROOM,
        refereeId: 'referee',
        verdict: { token: opened.token, grants: [] },
      }),
      refereeGates({ now: 2_000 }),
      IDS,
    )
    expect(stepped.account.hands).toEqual([])
  })
})
