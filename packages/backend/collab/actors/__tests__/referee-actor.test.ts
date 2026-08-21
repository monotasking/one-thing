/**
 * RefereeActor + 房间的裁决窗(D3)。
 *
 * 这一份钉的是**跨两层**的那几条性质 —— 它们在纯层和 actor 层各自看都是对的,
 * 只有把真房间和真裁判接在一起才验得出来:
 *
 *  - **O(1)**:一个触发事件恰好一次裁决调用,N 个候选不是 N 次;
 *  - **降级链**:超时 / 端口崩 / 读不懂 → 回落举手 FIFO(= D1 的 `free`),
 *    而且**房间不悬死**(这是把裁决做成异步之后最贵的那个失败态);
 *  - **@ 直通**不进裁决窗;
 *  - **相位挂起**:非活跃相位的房不发牌,举手一只不丢,换相后当场兑现。
 */
import { InMemoryMailbox, type ActorEvent } from '@onething/core/actors'
import type { CollabAgentLike } from '@onething/runtime/collab'
import {
  collabAgentRaiseHand,
  collabRoomPosted,
  collabActorRef,
  type CollabActorVerb,
  type CollabRoomJudgmentRequest,
  type CollabRoomTranscriptMessage,
} from '@onething/runtime/collab/actors'
import { describe, expect, it, vi } from 'vitest'

import {
  CollabRefereeActor,
  createCollabScriptedRefereeJudgePort,
  type CollabRefereeActorHost,
  type CollabRefereeTrace,
  type CollabScriptedJudgement,
} from '../referee-actor.js'
import { createCollabRoomAccountMemoryStore } from '../room-account.js'
import { CollabRoomActor, type CollabRoomActorHost } from '../room-actor.js'

const MEMBERS: CollabAgentLike[] = [
  { id: 'ana', name: 'ana' },
  { id: 'bo', name: 'bo' },
  { id: 'cy', name: 'cy' },
]

interface Harness {
  room: CollabRoomActor
  referee: CollabRefereeActor
  judgePort: ReturnType<typeof createCollabScriptedRefereeJudgePort>
  windows: CollabRoomJudgmentRequest[]
  messages: CollabRoomTranscriptMessage[]
  post(content: string, id: string): Promise<void>
  raise(agentId: string, sourceMessageId?: string): Promise<void>
  /** 把开着的窗判掉。 */
  settle(): Promise<void>
  holders(): string[]
  tick(): number
}

function harness(options: {
  script?: readonly CollabScriptedJudgement[]
  maxConcurrent?: number
  timeoutMs?: number
  referee?: boolean
  /** D8 观测口:判完一次喊一声(时间轴上 judge-verdict / judge-degraded 的产生点)。 */
  onJudged?: (trace: CollabRefereeTrace) => void
} = {}): Harness {
  const roomId = 'room-1'
  let clock = 1_000
  const windows: CollabRoomJudgmentRequest[] = []
  const messages: CollabRoomTranscriptMessage[] = []
  const roomMailbox = new InMemoryMailbox<ActorEvent<CollabActorVerb>>()

  const roomHost: CollabRoomActorHost = {
    members: () => MEMBERS,
    frozen: () => false,
    overBudget: () => false,
    maxChain: () => Number.POSITIVE_INFINITY,
    maxConcurrent: () => options.maxConcurrent ?? 1,
    referee: () => options.referee !== false,
    openJudgment: request => {
      windows.push(request)
    },
    appendMessage: (_roomId, message) => {
      messages.push(message)
    },
    memberMailbox: () => undefined,
    newMessageId: seed => seed,
    now: () => clock,
  }

  const room = new CollabRoomActor({
    roomId,
    host: roomHost,
    store: createCollabRoomAccountMemoryStore(),
    mailbox: roomMailbox,
  })

  const judgePort = createCollabScriptedRefereeJudgePort(options.script ?? [])

  const refereeHost: CollabRefereeActorHost = {
    // **现取**:开窗那一刻的名单只是下限,举手是异步到的。
    candidates: () => room.account.hands,
    members: () => MEMBERS,
    recent: () => messages,
    roomOutbox: () => ({
      post: async verb => {
        await room.commit(room.decide(verb))
      },
    }),
    now: () => clock,
  }

  const referee = new CollabRefereeActor({
    refereeId: 'ref',
    host: refereeHost,
    judge: judgePort,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.onJudged ? { onJudged: options.onJudged } : {}),
    onError: () => {},
  })

  const drive = async (verb: CollabActorVerb): Promise<void> => {
    await room.commit(room.decide(verb))
  }

  return {
    room,
    referee,
    judgePort,
    windows,
    messages,
    tick: () => (clock += 100),
    post: async (content, id) => {
      clock += 100
      messages.push({ id, role: 'user', content, timestamp: clock })
      await drive(collabRoomPosted({
        roomId,
        author: collabActorRef('user', 'user'),
        message: { id, role: 'user', content, timestamp: clock },
      }))
    },
    raise: async (agentId, sourceMessageId) => {
      clock += 10
      await drive(collabAgentRaiseHand({
        roomId,
        agentId,
        ...(sourceMessageId ? { sourceMessageId } : {}),
      }))
    },
    settle: async () => {
      const open = windows.splice(0, windows.length)
      for (const request of open) await referee.adjudicate(request)
    },
    holders: () => [...new Set(room.account.floor.active.map(lease => lease.agentId))],
  }
}

/* ── O(1) ───────────────────────────────────────────────────────────────── */

describe('批量举手裁决是 O(1)', () => {
  it('一个触发事件、三个候选 → 恰好一扇窗、恰好一次裁决调用', async () => {
    const h = harness({
      maxConcurrent: 3,
      script: [{ roomId: 'room-1', grants: ['bo', 'ana', 'cy'] }],
    })
    await h.post('这版排期谁来看看?', 'm1')
    await h.raise('ana', 'm1')
    await h.raise('bo', 'm1')
    await h.raise('cy', 'm1')

    // 三个人举手,一扇窗 —— 窗按触发事件开,不按候选开。
    expect(h.windows).toHaveLength(1)
    await h.settle()
    // **一次调用覆盖三个候选**。v2 那侧这里是三次。
    expect(h.judgePort.calls).toHaveLength(1)
    expect(h.judgePort.calls[0].candidates.map(hand => hand.agentId)).toEqual(['ana', 'bo', 'cy'])
    expect(h.referee.judgements).toHaveLength(1)
    expect(h.referee.judgements[0].candidateCount).toBe(3)
  })

  it('裁决的次序压过举手的先后 —— 那正是买这次调用的理由', async () => {
    const h = harness({
      maxConcurrent: 3,
      script: [{ roomId: 'room-1', grants: ['cy', 'ana'] }],
    })
    await h.post('谁先说?', 'm1')
    await h.raise('ana', 'm1')
    await h.raise('bo', 'm1')
    await h.raise('cy', 'm1')
    await h.settle()

    const order = h.room.account.floor.active.map(lease => lease.agentId)
    expect(order).toEqual(['cy', 'ana'])
    // 判过、没被点名的 bo **当场放下**:裁决是对这一批候选的终审,「这轮你不说」
    // 就是答案本身。留着它只会让下一条消息的裁决窗里混进一只旧话题的手 ——
    // 而下一条消息 bo 本来就会重新举手(D6-a:每条房间事实人人机械举手)。
    expect(h.room.account.hands).toEqual([])
  })

  it('裁决答空 = 这轮谁都不该说:没人拿牌,手当场放下', async () => {
    const h = harness({ script: [{ roomId: 'room-1', grants: [] }] })
    await h.post('随便聊聊。', 'm1')
    await h.raise('ana', 'm1')
    await h.settle()

    expect(h.holders()).toEqual([])
    // 真机走查抓到的那条:空裁决之后队列必须清零,否则状态条永远写着「N 人排队中」
    // 而座位全空(docs/audit/collab-v3-walkthrough-2026-08-03.md 走查发现 1)。
    expect(h.room.account.hands).toEqual([])
    // 窗关了 —— 「谁都不该说」是裁决意见,落地就是没人授牌,不需要一个 stay_silent 动词。
    expect(h.room.account.judgment).toBeUndefined()
  })

  it('窗在飞期间才举的手不连坐 —— 它没被判过,留着进下一扇窗', async () => {
    const h = harness({ script: [{ roomId: 'room-1', grants: [] }] })
    await h.post('随便聊聊。', 'm1')
    await h.raise('ana', 'm1')
    await h.raise('bo', 'm1')

    // 不 await:候选在 `adjudicate` 的同步段就现取完了(ana + bo),模型那一步还在飞。
    const flying = h.referee.adjudicate(h.windows.splice(0, h.windows.length)[0])
    // 就在这时 cy 举手 —— 它的手一次都没被送进模型。
    await h.raise('cy', 'm1')
    await flying

    // 空裁决放掉被判过的两只,cy 活着(它等的是下一扇窗,不是这一份答案)。
    expect(h.room.account.hands.map(hand => hand.agentId)).toEqual(['cy'])
    expect(h.judgePort.calls[0].candidates.map(hand => hand.agentId)).toEqual(['ana', 'bo'])
  })

  it('没人举手不买调用 —— 空名单不值一次模型往返', async () => {
    const h = harness()
    await h.post('自言自语。', 'm1')
    expect(h.windows).toHaveLength(0)
    expect(h.judgePort.calls).toHaveLength(0)
  })
})

/* ── 降级链 ─────────────────────────────────────────────────────────────── */

describe('降级链:失败一律回落举手 FIFO(= D1 的 free)', () => {
  const FIFO_CASES: Array<[string, CollabScriptedJudgement]> = [
    ['端口崩了', { roomId: 'room-1', throws: true }],
    ['读不懂', { roomId: 'room-1', degraded: true }],
  ]

  for (const [label, judgement] of FIFO_CASES) {
    it(`${label} → 按举手先后发牌,房间不悬死`, async () => {
      const h = harness({ maxConcurrent: 3, script: [judgement] })
      await h.post('都说说。', 'm1')
      await h.raise('cy', 'm1')
      await h.raise('ana', 'm1')
      await h.settle()

      // FIFO = 举手时刻序(cy 先举)。这正是 D1 `free` 的行为。
      expect(h.room.account.floor.active.map(lease => lease.agentId)).toEqual(['cy', 'ana'])
      expect(h.room.account.judgment).toBeUndefined()
      expect(h.referee.judgements[0].degraded).toBe(true)
    })
  }

  it('端口挂住不返回 → 死线到点降级,窗关上,房间照常发牌', async () => {
    vi.useFakeTimers()
    try {
      const h = harness({
        maxConcurrent: 2,
        timeoutMs: 50,
        script: [{ roomId: 'room-1', hangs: true }],
      })
      await h.post('都说说。', 'm1')
      await h.raise('ana', 'm1')
      await h.raise('bo', 'm1')

      const open = h.windows.splice(0, h.windows.length)
      const settling = h.referee.adjudicate(open[0])
      await vi.advanceTimersByTimeAsync(60)
      const verdict = await settling

      expect(verdict.degraded).toBe(true)
      // **房间没有被挂住**:窗关了,两只手按 FIFO 拿到了牌。
      expect(h.room.account.judgment).toBeUndefined()
      expect(h.room.account.floor.active.map(lease => lease.agentId)).toEqual(['ana', 'bo'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('挂了裁判却没人来判:窗一直开着 = 房间不发牌(这是要能看见的失败态)', async () => {
    const h = harness()
    await h.post('都说说。', 'm1')
    await h.raise('ana', 'm1')
    // 不 settle —— 模拟裁判进程没起来。
    expect(h.holders()).toEqual([])
    expect(h.room.account.judgment?.state).toBe('pending')

    // 一条新的人类消息把陈旧的窗顶掉,房间自己恢复(不需要外部对账器)。
    await h.post('还在吗?', 'm2')
    expect(h.room.account.judgment?.token).not.toBe('room-1#J1')
  })

  it('迟到的裁决认不领当前的窗 → 丢弃,不拿去发牌', async () => {
    const h = harness({ script: [{ roomId: 'room-1', grants: ['ana'] }] })
    await h.post('第一条。', 'm1')
    await h.raise('ana', 'm1')
    const stale = h.windows.splice(0, 1)[0]

    // 窗还开着的时候人类又说了一句 —— 旧窗作废。
    await h.post('第二条。', 'm2')
    await h.referee.adjudicate(stale)

    expect(h.holders()).toEqual([])
  })
})

/* ── @ 直通 ─────────────────────────────────────────────────────────────── */

describe('@ 不进裁决窗', () => {
  it('被 @ 的人当场拿牌,裁决只处理其余的手', async () => {
    const h = harness({
      maxConcurrent: 2,
      script: [{ roomId: 'room-1', grants: ['bo'] }],
    })
    await h.raise('bo', 'm0')
    h.tick()
    await h.room.commit(h.room.decide(collabRoomPosted({
      roomId: 'room-1',
      author: collabActorRef('user', 'user'),
      message: {
        id: 'm1',
        role: 'user',
        content: '@ana 你看一下',
        timestamp: 2_000,
        mentions: [{ agentId: 'ana', label: 'ana' }],
      },
    })))

    // ana 立刻在场上 —— 它没有等任何裁决。
    expect(h.holders()).toContain('ana')
    await h.settle()
    // 裁判看到的候选里没有 ana(它已经拿牌了)。
    const asked = h.judgePort.calls.flatMap(call => call.candidates.map(hand => hand.agentId))
    expect(asked).not.toContain('ana')
  })
})

/* ── 相位 ───────────────────────────────────────────────────────────────── */

describe('phase:非活跃相位举手挂起不丢', () => {
  it('夜相里群房不发牌,换到昼相后队里的手当场兑现', async () => {
    const h = harness({ referee: false })
    // 裁判把这间房设成 phase 档,当前相位活跃的是别的房。
    await h.referee.changePhase({
      phase: 'night',
      rooms: ['room-1'],
      activeRooms: ['wolf-den'],
    })
    await h.raise('ana', 'm1')
    await h.raise('bo', 'm1')

    expect(h.holders()).toEqual([])
    // 一只手都没丢。
    expect(h.room.account.hands.map(hand => hand.agentId)).toEqual(['ana', 'bo'])

    await h.referee.changePhase({
      phase: 'day',
      rooms: ['room-1'],
      activeRooms: ['room-1'],
    })
    expect(h.room.account.phase).toBe('day')
    // 换相后重新裁决 —— 挂着的手按 FIFO 兑现(座位只有一个)。
    expect(h.holders()).toEqual(['ana'])
    expect(h.room.account.hands.map(hand => hand.agentId)).toEqual(['bo'])
  })

  it('换相即换代:上一相的牌一律作废', async () => {
    const h = harness({ referee: false })
    await h.referee.changePhase({ phase: 'night', rooms: ['room-1'], activeRooms: ['room-1'] })
    await h.raise('ana', 'm1')
    const epochBefore = h.room.account.floor.epoch
    expect(h.holders()).toEqual(['ana'])

    await h.referee.changePhase({ phase: 'day', rooms: ['room-1'], activeRooms: ['wolf-den'] })
    expect(h.room.account.floor.epoch).toBeGreaterThan(epochBefore)
    // 天亮了,狼手里那张夜牌开不了口。
    expect(h.holders()).toEqual([])
  })
})

/* ── 换档 ───────────────────────────────────────────────────────────────── */

describe('换档', () => {
  it('换档不凭空起一场对话:空房切成 ring,没有人被发牌', async () => {
    const h = harness({ referee: false })
    await h.referee.setFloorPolicy('room-1', 'ring', { order: ['bo', 'ana', 'cy'] })
    expect(h.room.account.policy.name).toBe('ring')
    // 「把模式改成接力」不等于「开始一场对话」—— 后者要烧真钱。
    expect(h.holders()).toEqual([])
  })

  /** 队里挂着两只手、一张牌都还没发的房 —— 裁决窗开着、还没人来判的那一刻。 */
  const withQueuedHands = async (): Promise<Harness> => {
    const h = harness()
    await h.post('都说说。', 'm1')
    await h.raise('ana', 'm1')
    await h.raise('bo', 'm1')
    expect(h.holders()).toEqual([])
    return h
  }

  it('换档之后队里已经有手 → 当场按新策略排,不等下一条消息', async () => {
    const h = await withQueuedHands()
    // 裁决还没回来就被换了档:在飞的窗作废,队里的手改按环序排(环首是 bo)。
    await h.referee.setFloorPolicy('room-1', 'ring', { order: ['bo', 'ana', 'cy'] })
    expect(h.room.account.judgment).toBeUndefined()
    expect(h.holders()).toEqual(['bo'])
  })

  it('换档清空上一档的游标 —— 半份旧游标比没有游标更糟', async () => {
    const h = await withQueuedHands()
    await h.referee.setFloorPolicy('room-1', 'ring', { order: ['ana', 'bo', 'cy'] })
    expect(h.room.account.policyState?.ringCursor).toBe(1)
    await h.referee.setFloorPolicy('room-1', 'waves', { waves: [['cy']] })
    expect(h.room.account.policyState?.ringCursor).toBeUndefined()
  })
})

/* ── D8 观测:判决账 ─────────────────────────────────────────────────────── */

describe('判决账(D8 §3.3)', () => {
  it('判完一次喊一声,而且**why / elapsedMs / model 三格都在**', async () => {
    const seen: CollabRefereeTrace[] = []
    const h = harness({
      script: [{ roomId: 'room-1', grants: ['bo'], why: '阿波手上正好有那张卡', model: 'gpt-5-mini' }],
      onJudged: trace => { seen.push(trace) },
    })
    await h.post('这版排期谁来看看?', 'm1')
    await h.raise('ana', 'm1')
    await h.raise('bo', 'm1')
    await h.settle()

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      roomId: 'room-1',
      degraded: false,
      grants: ['bo'],
      why: '阿波手上正好有那张卡',
      model: 'gpt-5-mini',
      candidateCount: 2,
    })
    // 三格在 D8 之前用完即弃 —— 这一条钉的就是「接住了」。
    expect(typeof seen[0]?.elapsedMs).toBe('number')
    expect(seen[0]?.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('降级与空裁决在账上分得开 —— 前者是链断了,后者是读懂了的沉默', async () => {
    const broken: CollabRefereeTrace[] = []
    const silent: CollabRefereeTrace[] = []
    const a = harness({
      script: [{ roomId: 'room-1', degraded: true }],
      onJudged: trace => { broken.push(trace) },
    })
    await a.post('第一次', 'm1')
    await a.raise('ana', 'm1')
    await a.settle()

    const b = harness({
      script: [{ roomId: 'room-1', grants: [] }],
      onJudged: trace => { silent.push(trace) },
    })
    await b.post('第二次', 'm2')
    await b.raise('bo', 'm2')
    await b.settle()

    // 同样是「没人被授牌」,账上一个是 `degraded`(必须修),一个不是(不用管)。
    expect(broken[0]).toMatchObject({ degraded: true, reason: 'unreadable' })
    expect(silent[0]).toMatchObject({ degraded: false, grants: [] })
    expect(silent[0]?.reason).toBeUndefined()
  })

  it('没人举手 = 不买调用,但账上仍然有一行(「这一轮什么都没发生」也要说得出来)', async () => {
    const seen: CollabRefereeTrace[] = []
    // 不挂裁判:举手直接授牌,队里因此是空的 —— 这正是「没什么可排的」那个场景。
    const h = harness({ referee: false, onJudged: trace => { seen.push(trace) } })
    await h.post('随口一句', 'm1')
    await h.raise('ana', 'm1')
    await h.referee.adjudicate({
      roomId: 'room-1',
      token: 'room-1#J99',
      openedAt: 1,
      candidates: [],
    })

    expect(h.judgePort.calls).toHaveLength(0)
    const skipped = seen.filter(trace => trace.skipped)
    expect(skipped).toHaveLength(1)
    expect(skipped[0]).toMatchObject({ reason: 'no-candidates', candidateCount: 0, degraded: false })
  })

  it('观测口自己炸了不打断裁决(旁路不许改主路)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = harness({
      script: [{ roomId: 'room-1', grants: ['ana'] }],
      onJudged: () => { throw new Error('观测口崩了') },
    })
    await h.post('谁来', 'm1')
    await h.raise('ana', 'm1')
    await expect(h.settle()).resolves.toBeUndefined()
    expect(h.referee.judgements).toHaveLength(1)
    warn.mockRestore()
  })
})
