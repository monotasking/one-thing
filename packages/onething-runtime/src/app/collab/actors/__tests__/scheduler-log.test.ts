/**
 * 调度时间轴的落盘面 + 三个写入点的接线(D8 §3.3/§3.4)。
 *
 * 四组:
 *  1. **落盘**:按日切文件、14 天清老、尾读的 limit / types 过滤;
 *  2. **一条消息的全链**:posted → hand → judge-open → grant → speak → yield,
 *     `triggeredBy` 一路可回溯 —— 这是「刚才为什么是那样」能被回答的证据;
 *  3. **死信三路出口**:计数(ActorBase 的环)/ 详情(时间轴)/ 首错闩锁(只响一次);
 *  4. **观测是旁路**:不配 sink 时账本一行不写,而房间的行为一个字都不变。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { InMemoryMailbox, createActorEvent, type ActorEvent } from '@onething/core/actors'
import {
  collabActorRef,
  collabAgentRaiseHand,
  collabAgentSpawnWorker,
  collabAgentSpeak,
  collabAgentYield,
  collabRefereeVerdictVerb,
  collabRoomPosted,
  collabSchedulerPosted,
  type CollabActorVerb,
  type CollabSchedulerLogRow,
} from '@onething/runtime/collab/actors'

const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-scheduler-log-'))
// P0.2 ③:被测模块改走 `sessionReads` / `sessionCommands`,而它们静态依赖真的
// `app/stores/sessions.ts`(→ settings → paths → 整棵存储树)。换成共用替身,只留
// 这个用例真正需要的那一口。
vi.mock('../../../session/reads.js', () => import('../../../session/testing/facade-mock.js'))
vi.mock('../../../session/commands.js', () => import('../../../session/testing/facade-mock.js'))

vi.mock('../../../stores/paths.js', () => ({ getStorePath: () => storeRoot }))

const {
  CollabAgentActor,
  CollabRoomActor,
  collabDeadLetterRoomId,
  collabSchedulerLogPath,
  createCollabDeadLetterSink,
  createCollabSchedulerLogFileStore,
  createCollabSchedulerLogMemoryStore,
  listCollabSchedulerLogFiles,
  resetCollabSchedulerLogWarnings,
  sweepCollabSchedulerLogs,
} = await import('../index.js')
type CollabRoomActorHost = import('../room-actor.js').CollabRoomActorHost
type CollabAgentActorHost = import('../agent-actor.js').CollabAgentActorHost
const { createCollabAgentAccountMemoryStore } = await import('../agent-mailbox.js')
const { createCollabScriptedMindPort } = await import('../mind-port.js')
const { createCollabNotebookMemoryStore } = await import('../notebook-store.js')
const { createCollabScriptedWorkerPort } = await import('../worker-child.js')

afterAll(() => {
  fs.rmSync(storeRoot, { recursive: true, force: true })
})

const ROOM = 'room-log-test'
const MEMBERS = [
  { id: 'ana', name: '阿娜' },
  { id: 'bo', name: '阿波' },
]

const day = (text: string): number => new Date(`${text}T12:00:00`).getTime()

beforeEach(() => {
  fs.rmSync(path.join(storeRoot, 'collab'), { recursive: true, force: true })
  resetCollabSchedulerLogWarnings()
})

/* ── 1. 落盘 ─────────────────────────────────────────────────────────────── */

describe('落盘与轮转', () => {
  it('按日切文件:同一天追加同一个文件,跨天开新的', () => {
    const store = createCollabSchedulerLogFileStore()
    store.append(ROOM, collabSchedulerPosted({ at: day('2026-08-02'), messageId: 'm1', authorKind: 'user' }))
    store.append(ROOM, collabSchedulerPosted({ at: day('2026-08-03'), messageId: 'm2', authorKind: 'user' }))
    store.append(ROOM, collabSchedulerPosted({ at: day('2026-08-03'), messageId: 'm3', authorKind: 'user' }))

    const dir = path.dirname(collabSchedulerLogPath(ROOM, day('2026-08-03')))
    expect(listCollabSchedulerLogFiles(dir)).toEqual([
      'scheduler-log-2026-08-02.jsonl',
      'scheduler-log-2026-08-03.jsonl',
    ])
    const today = fs.readFileSync(collabSchedulerLogPath(ROOM, day('2026-08-03')), 'utf-8')
    expect(today.trim().split('\n')).toHaveLength(2)
  })

  it('落盘目录就是房间 actor 目录 —— 删房那条既有路径顺手把它带走', () => {
    expect(collabSchedulerLogPath(ROOM, day('2026-08-03')))
      .toBe(path.join(storeRoot, 'collab', ROOM, 'actors', 'scheduler-log-2026-08-03.jsonl'))
  })

  it('清老只删 14 天前的,房账与别的文件一根汗毛不动', () => {
    const store = createCollabSchedulerLogFileStore()
    for (const date of ['2026-07-19', '2026-07-20', '2026-07-21', '2026-08-03']) {
      store.append(ROOM, collabSchedulerPosted({ at: day(date), messageId: date, authorKind: 'user' }))
    }
    const dir = path.dirname(collabSchedulerLogPath(ROOM, day('2026-08-03')))
    fs.writeFileSync(path.join(dir, 'room.json'), '{}', 'utf-8')

    const removed = sweepCollabSchedulerLogs({ now: day('2026-08-03') })

    expect(removed).toBe(2)
    expect(listCollabSchedulerLogFiles(dir)).toEqual([
      'scheduler-log-2026-07-21.jsonl',
      'scheduler-log-2026-08-03.jsonl',
    ])
    expect(fs.existsSync(path.join(dir, 'room.json'))).toBe(true)
  })

  it('尾读**新在前**,跨文件接着往回翻,limit 到了就不再打开更老的文件', () => {
    const store = createCollabSchedulerLogFileStore()
    store.append(ROOM, collabSchedulerPosted({ at: day('2026-08-01'), messageId: 'old', authorKind: 'user' }))
    store.append(ROOM, collabSchedulerPosted({ at: day('2026-08-03'), messageId: 'a', authorKind: 'user' }))
    store.append(ROOM, collabSchedulerPosted({ at: day('2026-08-03'), messageId: 'b', authorKind: 'user' }))

    expect(store.readTail(ROOM, { limit: 2 }).map(row => (row as { messageId?: string }).messageId))
      .toEqual(['b', 'a'])
    expect(store.readTail(ROOM).map(row => (row as { messageId?: string }).messageId))
      .toEqual(['b', 'a', 'old'])
  })

  it('types 过滤:只要问的那几类', () => {
    const store = createCollabSchedulerLogFileStore()
    const at = day('2026-08-03')
    store.append(ROOM, collabSchedulerPosted({ at, messageId: 'm1', authorKind: 'user' }))
    store.append(ROOM, { type: 'speak', at, agentId: 'ana', leaseId: 'L1', messageId: 'm2' })
    store.append(ROOM, { type: 'yield', at, agentId: 'ana', leaseId: 'L1' })

    expect(store.readTail(ROOM, { types: ['speak'] }).map(row => row.type)).toEqual(['speak'])
    expect(store.readTail(ROOM, { types: ['speak', 'yield'] }).map(row => row.type))
      .toEqual(['yield', 'speak'])
    expect(store.readTail(ROOM, { limit: 0 })).toEqual([])
  })

  it('没写过账的房读出来是空,不是异常 —— 「没有刚才」也是一个答案', () => {
    expect(createCollabSchedulerLogFileStore().readTail('never-touched')).toEqual([])
    expect(listCollabSchedulerLogFiles(path.join(storeRoot, 'nope'))).toEqual([])
  })

  it('内存 store 与落盘 store 的可见行为一致(走同一趟渲染/解析)', () => {
    const memory = createCollabSchedulerLogMemoryStore()
    const at = day('2026-08-03')
    memory.append(ROOM, collabSchedulerPosted({ at, messageId: 'm1', authorKind: 'user' }))
    memory.append(ROOM, { type: 'speak', at, agentId: 'ana', leaseId: 'L1', messageId: 'm2' })
    expect(memory.rows(ROOM).map(row => row.type)).toEqual(['posted', 'speak'])
    expect(memory.readTail(ROOM, { types: ['posted'] }).map(row => row.type)).toEqual(['posted'])
  })
})

/* ── 2. 一条消息的全链 ───────────────────────────────────────────────────── */

interface Harness {
  actor: InstanceType<typeof CollabRoomActor>
  log: ReturnType<typeof createCollabSchedulerLogMemoryStore>
  mailbox: InMemoryMailbox<ActorEvent<CollabActorVerb>>
  failFor: Set<string>
  clock: { now: number }
}

function harness(options: { referee?: boolean; withLog?: boolean; frozen?: boolean } = {}): Harness {
  const log = createCollabSchedulerLogMemoryStore()
  const mailbox = new InMemoryMailbox<ActorEvent<CollabActorVerb>>()
  const failFor = new Set<string>()
  const clock = { now: 1_000 }
  const host: CollabRoomActorHost = {
    members: () => MEMBERS,
    frozen: () => options.frozen === true,
    overBudget: () => false,
    maxChain: () => Number.POSITIVE_INFINITY,
    maxConcurrent: () => 1,
    referee: () => options.referee === true,
    appendMessage: () => {},
    memberMailbox: agentId => ({
      append: async () => {
        if (failFor.has(agentId)) throw new Error(`mailbox ${agentId} is down\n  at somewhere`)
        await Promise.resolve()
      },
    }),
    newMessageId: seed => seed,
    now: () => clock.now,
  }
  const actor = new CollabRoomActor({
    roomId: ROOM,
    host,
    mailbox,
    ...(options.withLog === false ? {} : { schedulerLog: log }),
  })
  return { actor, log, mailbox, failFor, clock }
}

function userPosted(id: string, text = '大家看一下'): CollabActorVerb {
  return collabRoomPosted({
    roomId: ROOM,
    author: collabActorRef('user', 'user'),
    message: { id, role: 'user', content: text, timestamp: 1_000 },
  })
}

function rowsOf(log: Harness['log'], type: CollabSchedulerLogRow['type']): CollabSchedulerLogRow[] {
  return log.rows(ROOM).filter(row => row.type === type)
}

describe('一条消息的全链', () => {
  it('posted → hand → judge-open → grant → speak → yield,triggeredBy 一路回溯得上', () => {
    const h = harness({ referee: true })

    // ① 用户说了一句。
    h.actor.decide(userPosted('m1'))
    // ② 阿娜举手 —— 带着触发它的那条消息。裁判在场,窗当场开。
    const opened = h.actor.decide(collabAgentRaiseHand({ roomId: ROOM, agentId: 'ana', sourceMessageId: 'm1' }))
    const token = opened.judgment?.token
    expect(token).toBeDefined()
    // ③ 裁判答了(答案以 set-floor-policy 的形式投回来),牌发出去。
    const granted = h.actor.decide(collabRefereeVerdictVerb({
      roomId: ROOM,
      refereeId: 'referee',
      verdict: { token: token!, grants: ['ana'], why: '她提的问题' },
    }))
    const leaseId = granted.granted[0]?.leaseId
    expect(leaseId).toBeDefined()
    // ④ 说话。⑤ 让位。
    h.actor.decide(collabAgentSpeak({ roomId: ROOM, agentId: 'ana', leaseId: leaseId!, content: '这个我来' }))
    h.actor.decide(collabAgentYield({ roomId: ROOM, agentId: 'ana', leaseId: leaseId!, reason: 'done' }))

    const kinds = h.log.rows(ROOM).map(row => row.type)
    expect(kinds).toContain('posted')
    expect(kinds).toContain('hand')
    expect(kinds).toContain('judge-open')
    expect(kinds).toContain('grant')
    expect(kinds).toContain('speak')
    expect(kinds).toContain('yield')

    // 因果链:每一环都指得回上一环。
    expect(rowsOf(h.log, 'posted')[0]).toMatchObject({ messageId: 'm1', authorKind: 'user', chainReset: true })
    expect(rowsOf(h.log, 'hand')[0]).toMatchObject({ agentId: 'ana', triggeredBy: 'm1' })
    expect(rowsOf(h.log, 'judge-open')[0]).toMatchObject({ token, candidates: ['ana'], triggeredBy: 'm1' })
    expect(rowsOf(h.log, 'grant')[0]).toMatchObject({ agentId: 'ana', leaseId, triggeredBy: token })
    expect(rowsOf(h.log, 'speak')[0]).toMatchObject({ agentId: 'ana', leaseId, triggeredBy: leaseId })
    expect(rowsOf(h.log, 'yield')[0]).toMatchObject({ agentId: 'ana', leaseId, triggeredBy: leaseId })
  })

  it('speak 行只带 messageId —— 说了什么不进这本账', () => {
    const h = harness()
    h.actor.decide(userPosted('m1'))
    const granted = h.actor.decide(collabAgentRaiseHand({ roomId: ROOM, agentId: 'ana', sourceMessageId: 'm1' }))
    const leaseId = granted.granted[0]?.leaseId
    expect(leaseId).toBeDefined()
    h.actor.decide(collabAgentSpeak({
      roomId: ROOM,
      agentId: 'ana',
      leaseId: leaseId!,
      content: '这句话绝对不能出现在诊断账里',
    }))

    const speak = rowsOf(h.log, 'speak')[0]
    expect(speak).toBeDefined()
    expect(JSON.stringify(h.log.rows(ROOM))).not.toContain('这句话绝对不能出现在诊断账里')
    expect(Object.keys(speak!).sort())
      .toEqual(['agentId', 'at', 'leaseId', 'messageId', 'triggeredBy', 'type'])
  })

  it('举手被闸拦住时记一行 gate-block,而**同一只手同一道闸只记一次**', () => {
    const h = harness({ referee: true })
    h.actor.decide(userPosted('m1'))
    h.actor.decide(collabAgentRaiseHand({ roomId: ROOM, agentId: 'ana', sourceMessageId: 'm1' }))
    // 窗还开着,阿娜的手挂着;再来一条消息不该把同一句话再记一遍。
    h.actor.decide(userPosted('m2'))
    h.actor.decide(userPosted('m3'))

    const blocks = rowsOf(h.log, 'gate-block')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ agentId: 'ana', gate: 'judging' })
  })

  it('持牌的人再举手是空操作 —— 账上不该多出一次根本没发生的等待', () => {
    const h = harness()
    h.actor.decide(userPosted('m1'))
    h.actor.decide(collabAgentRaiseHand({ roomId: ROOM, agentId: 'ana', sourceMessageId: 'm1' }))
    const before = rowsOf(h.log, 'hand').length
    h.actor.decide(collabAgentRaiseHand({ roomId: ROOM, agentId: 'ana', sourceMessageId: 'm1' }))
    expect(rowsOf(h.log, 'hand')).toHaveLength(before)
  })

  it('换代:在外的牌被收回,revoke 行按牌号可回溯', async () => {
    const h = harness()
    h.actor.decide(userPosted('m1'))
    const granted = h.actor.decide(collabAgentRaiseHand({ roomId: ROOM, agentId: 'ana', sourceMessageId: 'm1' }))
    const leaseId = granted.granted[0]?.leaseId
    expect(leaseId).toBeDefined()

    await h.actor.bumpEpoch('epoch-bumped')

    const revokes = rowsOf(h.log, 'revoke')
    expect(revokes).toHaveLength(1)
    expect(revokes[0]).toMatchObject({ agentId: 'ana', leaseId, triggeredBy: leaseId })
  })

  it('不配 sink = 一行不写,而房间的行为一个字都不变(观测是旁路)', () => {
    const withLog = harness()
    const without = harness({ withLog: false })
    for (const h of [withLog, without]) {
      h.actor.decide(userPosted('m1'))
      h.actor.decide(collabAgentRaiseHand({ roomId: ROOM, agentId: 'ana', sourceMessageId: 'm1' }))
    }
    expect(without.log.rows(ROOM)).toEqual([])
    // 两边的账逐格相同 —— 记不记账不改变任何一个决策。
    expect(without.actor.account).toEqual(withLog.actor.account)
  })
})

/* ── 3. 死信三路出口 ─────────────────────────────────────────────────────── */

function deadLetter(eventType: string, id = 'evt-1'): {
  event: ActorEvent<CollabActorVerb>
  error: Error
  at: number
} {
  const verb = userPosted('m1')
  return {
    event: createActorEvent<CollabActorVerb>({
      id,
      at: 5_000,
      type: eventType,
      from: collabActorRef('user', 'user'),
      to: collabActorRef('room', ROOM),
      payload: verb,
    }),
    error: new Error('handler blew up\n  at deep/in/the/stack.ts:42'),
    at: 5_000,
  }
}

describe('死信三路出口', () => {
  it('①计数:一封投不出去的信进环,房间快照读得到', async () => {
    const h = harness()
    h.failFor.add('ana')
    h.actor.start()
    await h.mailbox.append(createActorEvent<CollabActorVerb>({
      id: 'e1',
      at: 1_000,
      type: 'room:posted',
      from: collabActorRef('user', 'user'),
      to: collabActorRef('room', ROOM),
      payload: userPosted('m1'),
    }))
    await h.actor.drain()
    await h.actor.stop()

    expect(h.actor.deadLetterCount).toBe(1)
    // 「它没回应」与「它试过但炸了」第一次在快照上分得开。
    expect(h.actor.snapshot().deadLetterCount).toBe(1)
  })

  it('②详情:一行进时间轴,带 actor / 事件类型 / 错误**首行**', () => {
    const log = createCollabSchedulerLogMemoryStore()
    const sink = createCollabDeadLetterSink({
      actorId: `room:${ROOM}`,
      roomId: ROOM,
      log,
      warned: new Set(),
      warn: () => {},
    })
    sink(deadLetter('room:posted'))

    expect(log.rows(ROOM)).toEqual([{
      type: 'dead-letter',
      at: 5_000,
      triggeredBy: 'evt-1',
      actor: `room:${ROOM}`,
      error: 'handler blew up',
      eventType: 'room:posted',
    }])
  })

  it('③告警:每 actor 每类只响一次,换一类事件再响一次', () => {
    const log = createCollabSchedulerLogMemoryStore()
    const said: string[] = []
    const sink = createCollabDeadLetterSink({
      actorId: `room:${ROOM}`,
      roomId: ROOM,
      log,
      warned: new Set(),
      warn: message => { said.push(message) },
    })

    sink(deadLetter('room:posted', 'e1'))
    sink(deadLetter('room:posted', 'e2'))
    sink(deadLetter('room:posted', 'e3'))
    expect(said).toHaveLength(1)
    expect(said[0]).toContain('room:posted')

    sink(deadLetter('agent:speak', 'e4'))
    expect(said).toHaveLength(2)
    // 闩锁只压 console,详情一条不少 —— 三路各管各的。
    expect(log.rows(ROOM)).toHaveLength(4)
  })

  it('寻不到房的信只留计数与告警,不硬塞进某间房的账', () => {
    const log = createCollabSchedulerLogMemoryStore()
    const said: string[] = []
    const sink = createCollabDeadLetterSink({
      actorId: 'agent:ana',
      log,
      warned: new Set(),
      warn: message => { said.push(message) },
    })
    const orphan = deadLetter('agent:note')
    ;(orphan.event as { payload: unknown }).payload = { type: 'agent:note', agentId: 'ana', text: 'x' }

    sink(orphan)

    expect(log.rows(ROOM)).toEqual([])
    expect(said).toHaveLength(1)
    expect(collabDeadLetterRoomId({ type: 'agent:note' })).toBeUndefined()
    expect(collabDeadLetterRoomId({ roomId: ROOM })).toBe(ROOM)
    expect(collabDeadLetterRoomId(null)).toBeUndefined()
  })
})

/* ── 4. 工作卡两类行(产生点在 AgentActor)──────────────────────────────── */

describe('工作卡记账', () => {
  const AGENT = 'ana'
  const CARD = 'card-42'

  async function settle(times = 24): Promise<void> {
    for (let index = 0; index < times; index += 1) await Promise.resolve()
  }

  it('派手与交活各记一行,triggeredBy 从卡号走到手号', async () => {
    const log = createCollabSchedulerLogMemoryStore()
    const mailbox = new InMemoryMailbox<ActorEvent<CollabActorVerb>>()
    const clock = { now: 2_000 }
    let ordinal = 0
    const deliver = (verb: CollabActorVerb): Promise<void> => {
      ordinal += 1
      return mailbox.append(createActorEvent<CollabActorVerb>({
        id: `w-${ordinal}`,
        at: clock.now,
        type: verb.type,
        from: collabActorRef('agent', AGENT),
        to: collabActorRef('agent', AGENT),
        payload: verb,
      }))
    }
    const host: CollabAgentActorHost = {
      execSessionId: (agentId, roomId) => `agent-exec-${agentId}-${roomId}`,
      buildRoomContext: () => '',
      roomOutbox: () => ({ post: () => Promise.resolve() }),
      members: () => MEMBERS,
      now: () => clock.now,
    }
    const actor = new CollabAgentActor({
      agentId: AGENT,
      host,
      mindPort: createCollabScriptedMindPort([]),
      notebook: createCollabNotebookMemoryStore(),
      mailbox,
      store: createCollabAgentAccountMemoryStore(),
      schedulerLog: log,
      worker: {
        port: createCollabScriptedWorkerPort([{ cardId: CARD, outcome: 'complete', summary: '这句摘要不该进诊断账' }]),
        postResult: verb => deliver(verb),
      },
    })

    actor.start()
    await deliver(collabAgentSpawnWorker({
      agentId: AGENT,
      workerId: 'w1',
      cardId: CARD,
      roomId: ROOM,
      title: '写纪要',
    }))
    await settle()
    await actor.drain()
    await settle()
    await actor.drain()
    await actor.stop()

    const rows = log.rows(ROOM)
    expect(rows.map(row => row.type)).toEqual(['worker-spawn', 'worker-result'])
    expect(rows[0]).toMatchObject({ agentId: AGENT, workerId: 'w1', cardId: CARD, triggeredBy: CARD })
    expect(rows[1]).toMatchObject({ agentId: AGENT, workerId: 'w1', cardId: CARD, triggeredBy: 'w1' })
    // 交回父的那句话是模型写的正文 —— 它归工作会话与看板,不进这本账。
    expect(JSON.stringify(rows)).not.toContain('这句摘要不该进诊断账')
  })
})

/* ── 5. 快照的三格新字段(§3.2 供数)────────────────────────────────────── */

describe('房间快照的 D8 三格', () => {
  it('空闲房:裁决 idle、没有相位、没有死信', () => {
    const snapshot = harness().actor.snapshot()
    expect(snapshot.judgment).toEqual({ state: 'idle' })
    expect(snapshot.phase).toBeUndefined()
    expect(snapshot.deadLetterCount).toBe(0)
  })

  it('窗开着 = inflight,候选就是队里那几只手', () => {
    const h = harness({ referee: true })
    h.actor.decide(userPosted('m1'))
    h.actor.decide(collabAgentRaiseHand({ roomId: ROOM, agentId: 'ana', sourceMessageId: 'm1' }))

    const snapshot = h.actor.snapshot()
    expect(snapshot.judgment).toMatchObject({ state: 'inflight', candidates: ['ana'] })
    // 「排队中」不再是笼统词:这一只手卡在裁决上,而那是几秒后自解的一格。
    expect(snapshot.queue.map(entry => entry.blockedBy)).toEqual(['judging'])
  })

  it('座位满了 = seats;没有引擎在跑时 executing 一律 false(诚实,不是占位)', () => {
    const h = harness()
    h.actor.decide(userPosted('m1'))
    h.actor.decide(collabAgentRaiseHand({ roomId: ROOM, agentId: 'ana', sourceMessageId: 'm1' }))
    h.actor.decide(collabAgentRaiseHand({ roomId: ROOM, agentId: 'bo', sourceMessageId: 'm1' }))

    const snapshot = h.actor.snapshot()
    expect(snapshot.turns).toHaveLength(1)
    // 持牌 ≠ 在生成:登记簿里没有这条会话,所以它是「持牌等大脑」。
    expect(snapshot.turns[0]?.executing).toBe(false)
    expect(snapshot.queue.map(entry => entry.blockedBy)).toEqual(['seats'])
  })

  it('冻结压过座位 —— 闸的次序读错了,给用户的那句话就是错的', () => {
    // 同一个局面(两只手、一个座位),差别只有房间冻没冻:
    // 「再等等」是几秒后自解的事,「去解冻」是必须有人动手的事。
    const open = harness()
    const frozen = harness({ frozen: true })
    for (const h of [open, frozen]) {
      h.actor.decide(userPosted('m1'))
      h.actor.decide(collabAgentRaiseHand({ roomId: ROOM, agentId: 'ana', sourceMessageId: 'm1' }))
      h.actor.decide(collabAgentRaiseHand({ roomId: ROOM, agentId: 'bo', sourceMessageId: 'm1' }))
    }
    expect(open.actor.snapshot().queue[0]?.blockedBy).toBe('seats')
    expect(frozen.actor.snapshot().queue.map(entry => entry.blockedBy)).toEqual(['frozen', 'frozen'])
  })
})
