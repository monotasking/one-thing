/**
 * 诊断 CLI 的纯规则(D8 §5,O3)。
 *
 * 四件事在这里被钉死:
 *  - **闸的口径与装配层一致**:缺省 32/6、双成员 dm 房 6、`0 = 不限`、serial = 1 座。
 *    CLI 是唯一一处重述这套口径的地方(装配层那两个函数要 `store.getSession`),
 *    所以它必须有测试盯着 —— 口径漂了,命令行会理直气壮地报一个错误的「链闸没满」;
 *  - **`blockedBy` 复用的是同一个 `resolveCollabRoomHandBlock`**:界面说排队、命令行
 *    说没排队,比两边都不说更糟;
 *  - **进程外读不到的两样如实标注**:预算闸缺一格要出现在 caveats 里,「生成中」
 *    的措辞只有一处出处;
 *  - **名字解析先精确后模糊,命中多个不猜**:诊断工具猜错目标 = 你看的是另一间房。
 */
import { describe, expect, it } from 'vitest'

import { createCollabAgentAccount } from '../mind-rules.js'
import { createCollabRoomAccount, type CollabRoomAccount } from '../room-rules.js'
import {
  collabSchedulerDeadLetter,
  collabSchedulerGateBlock,
  collabSchedulerGrant,
  collabSchedulerJudgeDegraded,
  collabSchedulerJudgeVerdict,
  collabSchedulerSpeak,
  type CollabSchedulerLogRow,
} from '../scheduler-log-rules.js'
import {
  COLLAB_INSPECT_DEFAULT_MAX_CHAIN,
  COLLAB_INSPECT_DEFAULT_MAX_CONCURRENT,
  COLLAB_INSPECT_DM_PAIR_MAX_CHAIN,
  COLLAB_INSPECT_EXECUTING_NOTE,
  collabInspectGates,
  collabInspectRowAgentId,
  filterCollabInspectRows,
  formatCollabInspectAgentDetail,
  formatCollabInspectAgentLine,
  formatCollabInspectAgo,
  formatCollabInspectCaveats,
  formatCollabInspectDeadLetters,
  formatCollabInspectDuration,
  formatCollabInspectRoomDetail,
  formatCollabInspectRoomLine,
  formatCollabInspectRow,
  formatCollabInspectStamp,
  groupCollabInspectDeadLetters,
  matchCollabInspectTargets,
  shortCollabInspectId,
  summarizeCollabInspectAgent,
  summarizeCollabInspectRoom,
} from '../inspect-rules.js'

const NOW = 1_800_000_000_000

function roomWithLeases(
  roomId: string,
  leases: Array<{ agentId: string; leaseId: string; issuedAt?: number }>,
): CollabRoomAccount {
  const account = createCollabRoomAccount(roomId)
  return {
    ...account,
    floor: {
      ...account.floor,
      active: leases.map(lease => ({
        leaseId: lease.leaseId,
        epoch: account.floor.epoch,
        roomId,
        agentId: lease.agentId,
        issuedAt: lease.issuedAt ?? NOW - 5_000,
      })),
    },
    leaseReasons: Object.fromEntries(leases.map(lease => [lease.leaseId, 'mention' as const])),
  }
}

function withHands(
  account: CollabRoomAccount,
  agentIds: string[],
  at = NOW - 30_000,
): CollabRoomAccount {
  return {
    ...account,
    hands: agentIds.map(agentId => ({
      agentId,
      at,
      origin: 'hand' as const,
      reason: 'self-elected' as const,
    })),
  }
}

describe('collabInspectGates —— 闸的口径与装配层对齐', () => {
  it('没配过 = 内置缺省(链 32 / 座 6),且永远带预算闸 caveat', () => {
    const { gates, caveats } = collabInspectGates(
      createCollabRoomAccount('r1'),
      { memberAgentIds: ['a', 'b', 'c'] },
      NOW,
    )
    expect(gates.maxChain).toBe(COLLAB_INSPECT_DEFAULT_MAX_CHAIN)
    expect(gates.maxConcurrent).toBe(COLLAB_INSPECT_DEFAULT_MAX_CONCURRENT)
    expect(gates.overBudget).toBe(false)
    // 进程外读不到用量账本 —— 这条 caveat 是它的唯一声明,不许悄悄消失。
    expect(caveats).toContain('budget-gate')
    // 群房(≥2 人、非私聊)挂裁判,与 roomHasReferee 同判据。
    expect(gates.referee).toBe(true)
  })

  it('双成员 dm 房的链闸缺省收紧到 6,并标成 pairDm', () => {
    const { gates } = collabInspectGates(
      createCollabRoomAccount('r1'),
      { dm: true, memberAgentIds: ['a', 'b'] },
      NOW,
    )
    expect(gates.maxChain).toBe(COLLAB_INSPECT_DM_PAIR_MAX_CHAIN)
    expect(gates.pairDm).toBe(true)
    // 私聊不挂裁判。
    expect(gates.referee).toBeUndefined()
  })

  it('0 = 不限,负数按「没配」,serial 房座位钉成 1', () => {
    const unlimited = collabInspectGates(
      createCollabRoomAccount('r1'),
      { memberAgentIds: ['a', 'b'], budgets: { maxChain: 0, maxConcurrentTurns: 0 } },
      NOW,
    ).gates
    expect(unlimited.maxChain).toBe(Number.POSITIVE_INFINITY)
    expect(unlimited.maxConcurrent).toBe(Number.POSITIVE_INFINITY)

    const negative = collabInspectGates(
      createCollabRoomAccount('r1'),
      { memberAgentIds: ['a'], budgets: { maxChain: -3 } },
      NOW,
    ).gates
    expect(negative.maxChain).toBe(COLLAB_INSPECT_DEFAULT_MAX_CHAIN)

    const serial = collabInspectGates(
      createCollabRoomAccount('r1'),
      { memberAgentIds: ['a', 'b'], responseMode: 'serial' },
      NOW,
    ).gates
    expect(serial.maxConcurrent).toBe(1)
  })

  it('读不到房间配置时另记一条 caveat —— 闸按缺省算这件事必须说出来', () => {
    const { gates, caveats } = collabInspectGates(createCollabRoomAccount('r1'), null, NOW)
    expect(caveats).toEqual(['budget-gate', 'no-room-config'])
    expect(gates.members).toEqual([])
    expect(gates.frozen).toBe(false)
  })
})

describe('summarizeCollabInspectRoom', () => {
  it('租约表 / 举手 / 座位 / 链闸从账现算,判据落在等座位', () => {
    const account = withHands(
      roomWithLeases('r1', [{ agentId: 'a1', leaseId: 'lease-1', issuedAt: NOW - 90_000 }]),
      ['a2'],
    )
    const summary = summarizeCollabInspectRoom({
      roomId: 'r1',
      name: '产品组',
      account: { ...account, chainCount: 4 },
      room: { memberAgentIds: ['a1', 'a2'], budgets: { maxConcurrentTurns: 1 } },
      now: NOW,
    })

    expect(summary.leases).toEqual([
      { agentId: 'a1', leaseId: 'lease-1', since: NOW - 90_000, heldMs: 90_000, epoch: 1, reason: 'mention' },
    ])
    expect(summary.seats).toEqual({ used: 1, max: 1 })
    expect(summary.chain).toEqual({ value: 4, max: COLLAB_INSPECT_DEFAULT_MAX_CHAIN })
    // 座位满 → 举着的那只手卡在「等座位」,与 UI 徽标同一个判据函数。
    expect(summary.hands).toHaveLength(1)
    expect(summary.hands[0]?.blockedBy).toBe('seats')
    expect(summary.hands[0]?.waitedMs).toBe(30_000)
  })

  it('裁决窗开着时判据是 judging;链闸顶格时是 chain', () => {
    const base = withHands(createCollabRoomAccount('r1'), ['a1'])
    const judging = summarizeCollabInspectRoom({
      roomId: 'r1',
      account: { ...base, judgment: { token: 't1', openedAt: NOW - 400, state: 'pending' } },
      room: { memberAgentIds: ['a1', 'a2'] },
      now: NOW,
    })
    expect(judging.hands[0]?.blockedBy).toBe('judging')
    expect(judging.judgment.state).toBe('pending')
    expect(judging.judgment.ageMs).toBe(400)

    const chained = summarizeCollabInspectRoom({
      roomId: 'r1',
      account: { ...base, chainCount: 8 },
      room: { memberAgentIds: ['a1', 'a2'], budgets: { maxChain: 8 } },
      now: NOW,
    })
    expect(chained.hands[0]?.blockedBy).toBe('chain')
  })

  it('时间轴给三样账里没有的东西:进程内记下的闸、裁决回放、死信计数', () => {
    const tail: CollabSchedulerLogRow[] = [
      // 尾读是新在前 —— 同一个人的两条 gate-block,取最近那条。
      collabSchedulerGateBlock({ at: NOW - 1_000, agentId: 'a1', gate: 'budget' }),
      collabSchedulerJudgeVerdict({
        at: NOW - 2_000,
        token: 'j-7',
        order: ['a1', 'a2'],
        why: '他先被点名',
        elapsedMs: 1_234,
        model: 'test-model',
      }),
      collabSchedulerJudgeDegraded({ at: NOW - 9_000, token: 'j-6', reason: 'timeout' }),
      collabSchedulerDeadLetter({ at: NOW - 12_000, actor: 'room:r1', eventType: 'agent:speak', error: 'boom' }),
      collabSchedulerGateBlock({ at: NOW - 30_000, agentId: 'a1', gate: 'chain' }),
    ]
    const summary = summarizeCollabInspectRoom({
      roomId: 'r1',
      account: withHands(createCollabRoomAccount('r1'), ['a1']),
      room: { memberAgentIds: ['a1', 'a2'] },
      tail,
      now: NOW,
    })

    // 重算的判据(缺预算闸那一格)与账上的原话并存 —— 这正是预算闸 caveat 的用处。
    // 群房挂裁判、座位全空还举着手 = 等下一扇窗,不是等座位(真机走查那句假话)。
    expect(summary.hands[0]?.blockedBy).toBe('judging')
    expect(summary.hands[0]?.loggedGate).toBe('budget')
    expect(summary.judgment.lastVerdict).toEqual({
      at: NOW - 2_000,
      token: 'j-7',
      order: ['a1', 'a2'],
      why: '他先被点名',
      elapsedMs: 1_234,
      model: 'test-model',
    })
    expect(summary.judgment.lastDegraded?.reason).toBe('timeout')
    expect(summary.deadLetters).toBe(1)
    expect(summary.lastEventAt).toBe(NOW - 1_000)
  })
})

describe('summarizeCollabInspectAgent', () => {
  it('持牌与举手扫各房账(不读 agent 账那份备份),涉入房按最近开口排序', () => {
    const account = createCollabAgentAccount('a1')
    account.rooms = {
      r1: { turns: 3, lastTurnAt: NOW - 60_000 },
      r2: { turns: 9, lastTurnAt: NOW - 10_000 },
      r3: { turns: 0 },
    }
    // agent 账上留着一张房间那侧早就换掉的牌 —— 它不该出现在输出里。
    account.leases = [{ roomId: 'r9', leaseId: 'ghost', epoch: 1, issuedAt: NOW - 1_000 }]
    account.hands = ['r9']

    const summary = summarizeCollabInspectAgent({
      agentId: 'a1',
      name: 'Iris',
      account,
      inbox: { depth: 4, oldestAt: NOW - 20_000 },
      rooms: [
        { roomSessionId: 'r1', name: '产品组', account: roomWithLeases('r1', [{ agentId: 'a1', leaseId: 'lease-1' }]) },
        { roomSessionId: 'r2', account: withHands(createCollabRoomAccount('r2'), ['a1'], NOW - 7_000) },
        { roomSessionId: 'r9', account: createCollabRoomAccount('r9') },
      ],
      deadLetters: 2,
      now: NOW,
    })

    expect(summary.leases).toEqual([
      { roomSessionId: 'r1', roomName: '产品组', leaseId: 'lease-1', since: NOW - 5_000, heldMs: 5_000 },
    ])
    expect(summary.hands).toEqual([{ roomSessionId: 'r2', at: NOW - 7_000, waitedMs: 7_000 }])
    expect(summary.rooms.map(room => room.roomSessionId)).toEqual(['r2', 'r1', 'r3'])
    expect(summary.lastTurnAt).toBe(NOW - 10_000)
    expect(summary.inbox.depth).toBe(4)
    expect(summary.deadLetters).toBe(2)
  })

  it('工作卡按账原样投影,不带 summary(那是模型写的正文)', () => {
    const account = createCollabAgentAccount('a1')
    account.workers = [
      {
        cardId: 'card-1',
        roomId: 'r1',
        workerId: 'w1',
        status: 'running',
        startedAt: NOW - 120_000,
        summary: '这是正文,不该出现',
      } as never,
    ]
    const summary = summarizeCollabInspectAgent({
      agentId: 'a1', account, rooms: [], now: NOW,
    })
    expect(summary.workers).toEqual([
      { cardId: 'card-1', roomSessionId: 'r1', status: 'running', since: NOW - 120_000, ageMs: 120_000 },
    ])
    expect(JSON.stringify(summary)).not.toContain('这是正文')
  })
})

describe('时间轴过滤与死信分组', () => {
  const rows: CollabSchedulerLogRow[] = [
    collabSchedulerSpeak({ at: 3, agentId: 'a1', leaseId: 'l1', messageId: 'm1' }),
    collabSchedulerGrant({ at: 2, agentId: 'a2', leaseId: 'l2', reason: 'mention' }),
    collabSchedulerDeadLetter({ at: 1, actor: 'agent:a1', eventType: 'room:posted', error: 'bad' }),
  ]

  it('按类型 / 按人过滤,limit 截断,次序原样', () => {
    expect(filterCollabInspectRows(rows, { types: ['grant'] })).toHaveLength(1)
    expect(filterCollabInspectRows(rows, { agentId: 'a1' }).map(row => row.type)).toEqual(['speak'])
    expect(filterCollabInspectRows(rows, { limit: 2 })).toHaveLength(2)
  })

  it('行里那个「这是谁」的格子:没有主人的行返回 undefined', () => {
    expect(collabInspectRowAgentId(rows[0]!)).toBe('a1')
    expect(collabInspectRowAgentId(
      collabSchedulerJudgeVerdict({ at: 1, token: 't', order: [], elapsedMs: 1 }),
    )).toBeUndefined()
  })

  it('死信按 actor 分组,取最近一条的错误首行', () => {
    const groups = groupCollabInspectDeadLetters([
      { roomId: 'r1', row: collabSchedulerDeadLetter({ at: 1, actor: 'agent:a1', eventType: 'room:posted', error: '旧' }) },
      { roomId: 'r2', row: collabSchedulerDeadLetter({ at: 5, actor: 'agent:a1', eventType: 'agent:wake', error: '新' }) },
      { roomId: 'r1', row: collabSchedulerDeadLetter({ at: 3, actor: 'room:r1', eventType: 'agent:speak', error: 'x' }) },
    ])
    expect(groups.map(group => group.actor)).toEqual(['agent:a1', 'room:r1'])
    expect(groups[0]).toMatchObject({
      count: 2,
      eventTypes: ['room:posted', 'agent:wake'],
      rooms: ['r1', 'r2'],
      latestError: '新',
    })
  })
})

describe('matchCollabInspectTargets —— 先精确后模糊,命中多个不猜', () => {
  const entries = [
    { id: 'room-aaa', name: 'Nova' },
    { id: 'room-bbb', name: 'Nova ⇄ Iris' },
    { id: 'room-ccc', name: '产品组' },
  ]

  it('id 全等赢过一切', () => {
    expect(matchCollabInspectTargets('room-bbb', entries).map(entry => entry.id)).toEqual(['room-bbb'])
  })

  it('名字全等(忽略大小写)赢过子串 —— 「Nova」不该变成两间房', () => {
    expect(matchCollabInspectTargets('nova', entries).map(entry => entry.id)).toEqual(['room-aaa'])
  })

  it('只剩子串时如实返回全部候选,由调用方拒绝', () => {
    expect(matchCollabInspectTargets('Iris', entries).map(entry => entry.id)).toEqual(['room-bbb'])
    expect(matchCollabInspectTargets('room-', entries)).toHaveLength(3)
    expect(matchCollabInspectTargets('   ', entries)).toEqual([])
  })
})

describe('格式化', () => {
  it('时长只留两个有效位', () => {
    expect(formatCollabInspectDuration(320)).toBe('320ms')
    expect(formatCollabInspectDuration(3_200)).toBe('3.2s')
    expect(formatCollabInspectDuration(72_340)).toBe('1m12s')
    expect(formatCollabInspectDuration(3_900_000)).toBe('1h05m')
    expect(formatCollabInspectDuration(200_000_000)).toBe('2d07h')
    expect(formatCollabInspectDuration(-1)).toBe('?')
  })

  it('时刻与「多久以前」:读不到时是 (无),不是 1970', () => {
    expect(formatCollabInspectStamp(NOW)).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(formatCollabInspectStamp(0)).toBe('(无)')
    expect(formatCollabInspectAgo(undefined, NOW)).toBe('(无)')
    expect(formatCollabInspectAgo(NOW - 5_000, NOW)).toBe('5.0s前')
    expect(shortCollabInspectId('0bf0f6bc-d708-426d')).toBe('0bf0f6bc…')
    expect(shortCollabInspectId('short')).toBe('short')
  })

  it('时间轴一行带因果引用,裁决行带 why 与耗时', () => {
    const line = formatCollabInspectRow(
      collabSchedulerJudgeVerdict({
        at: NOW, token: 'j-1', order: ['a1'], why: '他被点名了', elapsedMs: 900, model: 'm', triggeredBy: 'msg-42',
      }),
      { label: id => (id === 'a1' ? 'Iris' : undefined) },
    )
    expect(line).toContain('judge-verdict')
    expect(line).toContain('Iris')
    expect(line).toContain('why=他被点名了')
    expect(line).toContain('耗时=900ms')
    expect(line).toContain('← msg-42')
  })

  it('总览一行:「持牌」而不是「发言中」,死信亮 ! 前缀', () => {
    const summary = summarizeCollabInspectRoom({
      roomId: 'r1',
      name: '产品组',
      account: withHands(roomWithLeases('r1', [{ agentId: 'a1', leaseId: 'l1' }]), ['a2']),
      room: { memberAgentIds: ['a1', 'a2'], budgets: { maxConcurrentTurns: 1 } },
      tail: [collabSchedulerDeadLetter({ at: NOW, actor: 'room:r1', eventType: 'x', error: 'e' })],
      now: NOW,
    })
    const line = formatCollabInspectRoomLine(summary, { label: id => (id === 'a1' ? 'Iris' : undefined) })
    expect(line).toContain('持牌 1/1')
    expect(line).not.toContain('发言中')
    expect(line).toContain('举手 1(等座位)')
    expect(line).toContain('!死信1')
  })

  it('两份详情都印那条「生成中读不到」的声明,措辞只有一处出处', () => {
    const room = summarizeCollabInspectRoom({
      roomId: 'r1', account: createCollabRoomAccount('r1'), room: { memberAgentIds: ['a1'] }, tail: [], now: NOW,
    })
    const roomLines = formatCollabInspectRoomDetail(room, [], NOW).join('\n')
    expect(roomLines).toContain(COLLAB_INSPECT_EXECUTING_NOTE)
    expect(roomLines).toContain('判据不含预算闸')

    const agent = summarizeCollabInspectAgent({
      agentId: 'a1', account: createCollabAgentAccount('a1'), rooms: [], now: NOW,
    })
    expect(formatCollabInspectAgentDetail(agent, NOW).join('\n')).toContain(COLLAB_INSPECT_EXECUTING_NOTE)
    expect(formatCollabInspectAgentLine(agent, NOW)).toContain('持牌 0')
    expect(formatCollabInspectCaveats(['budget-gate'])[0]).toMatch(/^!/)
  })

  it('死信为空时说「常绿即健康」,不是一个空白屏', () => {
    expect(formatCollabInspectDeadLetters([], NOW).join('\n')).toContain('常绿即健康')
  })
})
