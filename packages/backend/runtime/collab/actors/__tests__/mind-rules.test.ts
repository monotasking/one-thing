/**
 * AgentActor 的纯规则:账的转换、举手评估、drive 组装。
 *
 * 账那一组的重点全在**只前进**与**幂等**上 —— mailbox 是 at-least-once,
 * 崩在一批中间重启后那一批原样重投,而重投必须既不让水位倒退、也不折出第二条。
 */
import { describe, expect, it } from 'vitest'

import {
  advanceCollabAgentDelivered,
  advanceCollabAgentRead,
  buildCollabMindDrive,
  clearCollabAgentHand,
  collabAgentLeaseOf,
  collabAgentRoomAccount,
  collabPostedSpeakerId,
  createCollabAgentAccount,
  createCollabHeuristicHandEvaluator,
  dropCollabAgentLease,
  normalizeCollabAgentAccount,
  pushCollabAgentFold,
  raiseCollabAgentHand,
  recordCollabAgentLease,
  recordCollabAgentTurn,
  recordCollabAgentWorkerResult,
  takeCollabAgentFold,
} from '../mind-rules.js'
import { collabActorRef, collabRoomPosted } from '../protocol.js'
import type { CollabFoldEntry } from '../envelope-fold.js'

const ROOM = 'room-1'
const MEMBERS = [
  { id: 'iris', name: '小艾' },
  { id: 'bram', name: '阿布' },
]

function fold(key: string, at = 1_000, roomId = 'room-2'): CollabFoldEntry {
  return { kind: 'got', at, roomId, key, count: 1 }
}

describe('账:两个水位', () => {
  it('投递水位只前进 —— 重投与迟到都不让它动', () => {
    let account = createCollabAgentAccount('iris')
    account = advanceCollabAgentDelivered(account, ROOM, 'm2', 2_000)
    const forward = account
    account = advanceCollabAgentDelivered(account, ROOM, 'm1', 1_000)
    expect(account).toBe(forward)
    account = advanceCollabAgentDelivered(account, ROOM, 'm2', 2_000)
    expect(account).toBe(forward)
    expect(collabAgentRoomAccount(account, ROOM).deliveredMessageId).toBe('m2')
  })

  it('已读水位是另一格,不被投递水位带着走', () => {
    let account = createCollabAgentAccount('iris')
    account = advanceCollabAgentDelivered(account, ROOM, 'm5', 5_000)
    expect(collabAgentRoomAccount(account, ROOM).readMessageId).toBeUndefined()
    account = advanceCollabAgentRead(account, ROOM, 'm5', 5_000)
    expect(collabAgentRoomAccount(account, ROOM).readMessageId).toBe('m5')
    // 一个 abort 的回合把旧的候选值交回来,水位不回退。
    account = advanceCollabAgentRead(account, ROOM, 'm3', 3_000)
    expect(collabAgentRoomAccount(account, ROOM).readMessageId).toBe('m5')
  })

  it('没有 messageId 的候选值不推已读水位(推了就无从定位)', () => {
    const account = createCollabAgentAccount('iris')
    expect(advanceCollabAgentRead(account, ROOM, undefined, 1)).toBe(account)
  })

  it('回合计数决定「首轮铺底」', () => {
    let account = createCollabAgentAccount('iris')
    expect(collabAgentRoomAccount(account, ROOM).turns).toBe(0)
    account = recordCollabAgentTurn(account, ROOM, 9_000)
    expect(collabAgentRoomAccount(account, ROOM)).toMatchObject({ turns: 1, lastTurnAt: 9_000 })
  })
})

describe('账:折叠缓冲', () => {
  it('同一封信重投折不出第二条', () => {
    let account = createCollabAgentAccount('iris')
    account = pushCollabAgentFold(account, fold('got:room-2:m1'))
    const once = account
    account = pushCollabAgentFold(account, fold('got:room-2:m1'))
    expect(account).toBe(once)
    expect(account.fold).toHaveLength(1)
  })

  it('容量满了丢最旧的**并计数**(截断要说出来)', () => {
    let account = createCollabAgentAccount('iris')
    for (let index = 0; index < 5; index += 1) {
      account = pushCollabAgentFold(account, fold(`k${index}`, index), { max: 3 })
    }
    expect(account.fold).toHaveLength(3)
    expect(account.foldDropped).toBe(2)
    expect(account.fold[0].key).toBe('k2')
  })

  it('取走即清,并推进折叠位点;幂等窗口**不清**(重投在取走之后才来)', () => {
    let account = createCollabAgentAccount('iris')
    account = pushCollabAgentFold(account, fold('k1'))
    const first = takeCollabAgentFold(account, 7_000)
    expect(first.entries).toHaveLength(1)
    expect(first.since).toBeUndefined()
    expect(first.account.fold).toEqual([])
    expect(first.account.foldedAt).toBe(7_000)

    const replayed = pushCollabAgentFold(first.account, fold('k1'))
    expect(replayed.fold).toEqual([])

    const second = takeCollabAgentFold(first.account, 8_000)
    expect(second.since).toBe(7_000)
  })
})

describe('账:手与牌', () => {
  it('举手幂等;拿到牌就把手放下', () => {
    let account = createCollabAgentAccount('iris')
    account = raiseCollabAgentHand(account, ROOM)
    expect(raiseCollabAgentHand(account, ROOM)).toBe(account)
    account = recordCollabAgentLease(account, { roomId: ROOM, leaseId: 'L1', epoch: 1, issuedAt: 1 })
    expect(account.hands).toEqual([])
    expect(collabAgentLeaseOf(account, ROOM)?.leaseId).toBe('L1')
  })

  it('同房重复发牌以新的为准(换代之后房间会重发)', () => {
    let account = createCollabAgentAccount('iris')
    account = recordCollabAgentLease(account, { roomId: ROOM, leaseId: 'L1', epoch: 1, issuedAt: 1 })
    account = recordCollabAgentLease(account, { roomId: ROOM, leaseId: 'L2', epoch: 2, issuedAt: 2 })
    expect(account.leases).toHaveLength(1)
    expect(collabAgentLeaseOf(account, ROOM)?.leaseId).toBe('L2')
  })

  it('收牌与放手都是幂等的', () => {
    let account = createCollabAgentAccount('iris')
    account = recordCollabAgentLease(account, { roomId: ROOM, leaseId: 'L1', epoch: 1, issuedAt: 1 })
    account = dropCollabAgentLease(account, 'L1')
    expect(dropCollabAgentLease(account, 'L1')).toBe(account)
    expect(clearCollabAgentHand(account, ROOM)).toBe(account)
  })

  it('子 actor 结果只记账(D4 占位)', () => {
    expect(recordCollabAgentWorkerResult(createCollabAgentAccount('iris')).workerResults).toBe(1)
  })
})

describe('账:认盘', () => {
  it('认不出的形状退回新账', () => {
    expect(normalizeCollabAgentAccount(null, 'iris')).toEqual(createCollabAgentAccount('iris'))
    expect(normalizeCollabAgentAccount({ agentId: 'bram' }, 'iris').agentId).toBe('iris')
    expect(normalizeCollabAgentAccount({ agentId: 'bram' }, 'iris').rooms).toEqual({})
  })

  it('一份真账原样认回来', () => {
    let account = createCollabAgentAccount('iris')
    account = advanceCollabAgentDelivered(account, ROOM, 'm1', 1_000)
    account = advanceCollabAgentRead(account, ROOM, 'm1', 1_000)
    account = recordCollabAgentLease(account, { roomId: ROOM, leaseId: 'L1', epoch: 3, issuedAt: 5 })
    account = pushCollabAgentFold(account, fold('k1'))
    const round = normalizeCollabAgentAccount(JSON.parse(JSON.stringify(account)), 'iris')
    expect(round).toEqual(account)
  })

  it('半份账里的坏条目被丢掉,而不是带着一个 undefined 往下走', () => {
    const account = normalizeCollabAgentAccount(
      { agentId: 'iris', leases: [{ roomId: 'r' }, 'nope', { roomId: 'r2', leaseId: 'L' }] },
      'iris',
    )
    expect(account.leases).toEqual([{ roomId: 'r2', leaseId: 'L', epoch: 1, issuedAt: 0 }])
  })
})

describe('举手评估:D2 启发式', () => {
  const evaluator = createCollabHeuristicHandEvaluator()
  const base = { agentId: 'iris', roomId: ROOM, members: MEMBERS }

  it('被 @ 就举手', async () => {
    const verdict = await evaluator.evaluate({
      ...base,
      author: collabActorRef('user', 'user'),
      message: { id: 'm1', role: 'user', content: '@小艾 看一下', mentions: [{ agentId: 'iris', label: '小艾' }] },
    })
    expect(verdict).toMatchObject({ raise: true, reason: 'mention' })
  })

  it('私聊里人类说话就举手', async () => {
    const verdict = await evaluator.evaluate({
      ...base,
      dm: true,
      author: collabActorRef('user', 'user'),
      message: { id: 'm1', role: 'user', content: '在吗' },
    })
    expect(verdict).toMatchObject({ raise: true, reason: 'self-elected' })
  })

  it('群里没点到自己就不举手 —— D2 没有意愿判定,「不确定就说话」在真机上是刷屏', async () => {
    const verdict = await evaluator.evaluate({
      ...base,
      author: collabActorRef('agent', 'bram'),
      message: { id: 'm1', role: 'assistant', agentId: 'bram', content: '我先说两句' },
    })
    expect(verdict.raise).toBe(false)
  })

  it('自己说的话不构成举手理由', async () => {
    const verdict = await evaluator.evaluate({
      ...base,
      author: collabActorRef('agent', 'iris'),
      message: {
        id: 'm1',
        role: 'assistant',
        agentId: 'iris',
        content: '@小艾 自言自语',
        mentions: [{ agentId: 'iris', label: '小艾' }],
      },
    })
    expect(verdict.raise).toBe(false)
  })

  it('运营行/drive 不是发言时机(判据走单一分类器,不比字符串)', async () => {
    const verdict = await evaluator.evaluate({
      ...base,
      dm: true,
      author: collabActorRef('user', 'user'),
      message: { id: 'm1', role: 'user', content: '@小艾 驱动', source: 'collab' },
    })
    expect(verdict.raise).toBe(false)
  })
})

describe('drive 组装', () => {
  it('三块按序拼,空块不留空行', () => {
    expect(buildCollabMindDrive({ roomContext: '房', envelope: '', notebook: '本' }))
      .toBe('房\n\n本')
  })

  it('三块全空时走兜底(空 drive 就是一条什么都没有的消息)', () => {
    expect(buildCollabMindDrive({ roomContext: '', fallback: '<Notification count="0"/>' }))
      .toBe('<Notification count="0"/>')
  })

  it('没有尾注块 —— 措辞劝导于 2026-08-02 整块删除', () => {
    const drive = buildCollabMindDrive({ roomContext: '房', envelope: '别处', notebook: '本' })
    expect(drive).not.toContain('<turn')
    expect(drive).not.toContain('Your turn')
  })
})

describe('posted 的说话人', () => {
  const message = { id: 'm1', role: 'assistant', content: 'x', agentId: 'bram' }

  it('作者是权威;用户没有 agentId', () => {
    expect(collabPostedSpeakerId(collabRoomPosted({
      roomId: ROOM, author: collabActorRef('agent', 'bram'), message,
    }))).toBe('bram')
    expect(collabPostedSpeakerId(collabRoomPosted({
      roomId: ROOM, author: collabActorRef('user', 'user'), message: { id: 'm', role: 'user', content: 'x' },
    }))).toBeUndefined()
  })

  it('系统行退回消息自己的 agentId(迁移期的旧转录)', () => {
    expect(collabPostedSpeakerId(collabRoomPosted({
      roomId: ROOM, author: collabActorRef('room', ROOM), message,
    }))).toBe('bram')
  })
})
