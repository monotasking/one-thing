import { createFloorLeaseLedger, issueFloorLease } from '@onething/backend/runtime/collab/kernel'
import { describe, expect, it } from 'vitest'

import {
  COLLAB_ACTOR_VERB_TABLE_IS_EXHAUSTIVE,
  COLLAB_ACTOR_VERB_TYPES,
  collabActorVerbDirection,
  collabActorVerbSender,
  collabAgentDmOpen,
  collabAgentNote,
  collabAgentRaiseHand,
  collabAgentSpawnWorker,
  collabAgentSpeak,
  collabAgentWake,
  collabAgentWorkerResult,
  collabAgentYield,
  collabRefereeSetFloorPolicy,
  collabRoomCardEvent,
  collabRoomFloorGranted,
  collabRoomFloorRevoked,
  collabRoomMembershipChanged,
  collabRoomPhaseChanged,
  collabRoomPosted,
  isCollabActorVerbType,
  type CollabActorVerb,
} from '../protocol.js'

const LEASE = issueFloorLease(createFloorLeaseLedger('r1'), { agentId: 'a1', now: 0, leaseId: 'L1' }).lease

/** 每个动词一个样本。穷尽测试拿它当「实际造得出来」的证据。 */
const SAMPLES: CollabActorVerb[] = [
  collabRoomPosted({
    roomId: 'r1',
    author: { kind: 'user', id: 'user' },
    message: { id: 'm1', role: 'user', content: 'hi', timestamp: 1 },
  }),
  collabRoomFloorGranted({ roomId: 'r1', agentId: 'a1', lease: LEASE }),
  collabRoomFloorRevoked({ roomId: 'r1', agentId: 'a1', leaseId: 'L1', reason: 'yield' }),
  collabRoomPhaseChanged({ roomId: 'r1', phase: 'night', previousPhase: 'day', epoch: 2 }),
  collabRoomMembershipChanged({ roomId: 'r1', joined: ['a2'], left: [] }),
  collabRoomCardEvent({ roomId: 'r1', cardId: 'c1', event: 'assigned', assigneeId: 'a1' }),
  collabAgentRaiseHand({ roomId: 'r1', agentId: 'a1', why: '我有数据', urgency: 'high' }),
  collabAgentSpeak({ roomId: 'r1', agentId: 'a1', leaseId: 'L1', content: '我来说' }),
  collabAgentYield({ roomId: 'r1', agentId: 'a1', leaseId: 'L1', reason: 'done' }),
  collabAgentDmOpen({ agentId: 'a1', peerId: 'a2', peerKind: 'agent' }),
  collabAgentWake({ agentId: 'a1', roomId: 'r2', peerId: 'a3' }),
  collabRefereeSetFloorPolicy({ roomId: 'r1', refereeId: 'ref', policy: 'ring', params: { order: ['a1', 'a2'] } }),
  collabAgentNote({ agentId: 'a1', note: '记一笔' }),
  collabAgentSpawnWorker({ agentId: 'a1', workerId: 'w1', cardId: 'c1', roomId: 'r1' }),
  collabAgentWorkerResult({
    agentId: 'a1',
    workerId: 'w1',
    cardId: 'c1',
    roomId: 'r1',
    outcome: 'complete',
    summary: '做完了',
    evidence: [{ kind: 'file', ref: 'src/a.ts' }],
  }),
]

describe('collab actor protocol', () => {
  it('动词表与联合类型双向穷尽(C3 纪律)', () => {
    // 类型层已经把两个方向都钉死了,这里再钉一遍运行时的:新增动词漏登记 → 红。
    expect(COLLAB_ACTOR_VERB_TABLE_IS_EXHAUSTIVE).toBe(true)
    expect([...COLLAB_ACTOR_VERB_TYPES]).toEqual([
      'room:posted',
      'room:floor-granted',
      'room:floor-revoked',
      'room:phase-changed',
      'room:membership-changed',
      'room:card-event',
      'agent:raise-hand',
      'agent:speak',
      'agent:yield',
      'agent:dm-open',
      'agent:wake',
      'referee:set-floor-policy',
      'agent:note',
      'agent:spawn-worker',
      'agent:worker-result',
    ])
  })

  it('每个登记在表里的动词都有一个能造出来的样本', () => {
    expect(SAMPLES.map(verb => verb.type).sort()).toEqual([...COLLAB_ACTOR_VERB_TYPES].sort())
  })

  it('方向按蓝图 §2 的四组分', () => {
    const byDirection: Record<string, string[]> = {}
    for (const verb of SAMPLES) {
      const direction = collabActorVerbDirection(verb)
      byDirection[direction] = [...(byDirection[direction] ?? []), verb.type]
    }
    expect(byDirection).toEqual({
      'room->agent': [
        'room:posted',
        'room:floor-granted',
        'room:floor-revoked',
        'room:phase-changed',
        'room:membership-changed',
        'room:card-event',
      ],
      'agent->room': ['agent:raise-hand', 'agent:speak', 'agent:yield', 'agent:dm-open', 'agent:wake'],
      'referee->room': ['referee:set-floor-policy'],
      'agent->self': ['agent:note', 'agent:spawn-worker', 'agent:worker-result'],
    })
  })

  it('发起方地址按方向推出来', () => {
    expect(collabActorVerbSender(SAMPLES[0])).toEqual({ kind: 'room', id: 'r1' })
    expect(collabActorVerbSender(collabAgentSpeak({ roomId: 'r1', agentId: 'a1', leaseId: 'L1', content: 'x' })))
      .toEqual({ kind: 'agent', id: 'a1' })
    expect(collabActorVerbSender(collabRefereeSetFloorPolicy({ roomId: 'r1', refereeId: 'ref', policy: 'free' })))
      .toEqual({ kind: 'referee', id: 'ref' })
    expect(collabActorVerbSender(collabAgentNote({ agentId: 'a1', note: 'n' })))
      .toEqual({ kind: 'agent', id: 'a1' })
  })

  it('未登记的动词名不被认', () => {
    expect(isCollabActorVerbType('agent:speak')).toBe(true)
    expect(isCollabActorVerbType('agent:shout')).toBe(false)
  })

  it('构造函数只补 type,其余字段原样透传', () => {
    expect(collabAgentSpeak({ roomId: 'r1', agentId: 'a1', leaseId: 'L1', content: '你好', mentions: [] })).toEqual({
      type: 'agent:speak',
      roomId: 'r1',
      agentId: 'a1',
      leaseId: 'L1',
      content: '你好',
      mentions: [],
    })
  })

  it('speak 必须带租约 —— 「说话即行动」的结构保证在类型层就成立', () => {
    const verb = collabAgentSpeak({ roomId: 'r1', agentId: 'a1', leaseId: LEASE.leaseId, content: 'x' })
    expect(verb.leaseId).toBe('L1')
  })

  it('未知动词名进 direction 会炸而不是静默返回', () => {
    expect(() => collabActorVerbDirection({ type: 'agent:shout' } as unknown as CollabActorVerb))
      .toThrow(/unhandled verb/)
  })
})
