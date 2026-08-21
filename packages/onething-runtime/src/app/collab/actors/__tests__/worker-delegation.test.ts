/**
 * 金重放:群里派活 → 派手 → 干完 → **下一轮对话回合的信封里看得见**(D4 闭环)。
 *
 * 这份剧本存在的理由与狼人杀那份对称:那一份钉的是「别房的正文进不来」,这一份
 * 钉的是「**自己的活干完了,不用问就知道**」——收养回声机制的泛化(§5 复用清单
 * 最后一行)。两者其实是同一条不变量的两面:进 drive 的只能是信封,而信封必须
 * 真的到得了。
 *
 * ## 环里有几个假件
 *
 * 两个端口(心智 / 工作)是剧本化的,看板是录音机 —— 三样都是**行为**的替身,
 * 不是**结构**的替身:谁在什么时候被点到、派了几只手、账怎么推进、信封长什么样,
 * 全是真的。房间这一侧刻意用一个记录用的投递口而不是 `CollabRoomActor`:D4 要
 * 验的是「一双手的一生」,把发言权仲裁也拉进来只会让这份快照在 D3 改发牌策略时
 * 跟着变 —— 一个会因为别处改动而飘的快照,比没有快照更糟。
 *
 * ## 派活的触发源在这里是脚本
 *
 * 真机上 `agent:spawn-worker` 由对话回合里的 `board start` 发出(生产触发点 D6
 * 接线)。D4 阶段由剧本在「它答应了那一轮」之后投进去 —— 时序与真机一致:
 * **assign = 通知 ≠ 开工**,开工是它自己在回合里作出的决定(§8 保留的已拍板决策)。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { InMemoryMailbox, createActorEvent, type ActorEvent } from '@onething/core/actors'
import {
  collabActorRef,
  collabAgentSpawnWorker,
  collabRoomFloorGranted,
  collabRoomPosted,
  formatCollabActorVerb,
  type CollabActorVerb,
} from '@onething/runtime/collab/actors'

vi.mock('@onething/runtime/storage', () => ({ getOnethingStorePath: () => '/tmp/onething-worker-golden-test' }))

const { CollabAgentActor } = await import('../agent-actor.js')
const { createCollabAgentAccountMemoryStore } = await import('../agent-mailbox.js')
const { createCollabScriptedMindPort } = await import('../mind-port.js')
const { createCollabNotebookMemoryStore } = await import('../notebook-store.js')
const { createCollabScriptedWorkerPort, createCollabWorkerBoardRecorder } = await import('../worker-child.js')
type CollabAgentActorHost = import('../agent-actor.js').CollabAgentActorHost

const GOLDEN = join(__dirname, '../../../../collab/actors/__tests__/golden/worker-delegation.expected.txt')

const AGENT = 'iris'
const ROOM = 'product-room'
const CARD = 'c-42'
/** 卡的产出摘要。它在 drive 里出现一次就是一次「信封带了正文」。 */
const WORK_SUMMARY = '纪要写好了,落在 notes/0803.md'

interface ReplayResult {
  lines: string[]
  drives: string[]
  snapshot: string
  workerResults: number
  workers: { cardId: string; status: string; outcome?: string; workSessionId?: string }[]
}

async function tick(times = 24): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve()
}

/**
 * 信封里的时刻按**本机时区**渲染(`formatCollabMessageTime`)。原样进快照的话,
 * 这份金重放在另一个时区的机器上会红 —— 而它要钉的是信封的**结构**,不是那台
 * 机器在哪个时区。所以时刻打码,其余逐字节。
 */
function scrubTimes(text: string): string {
  return text.replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/g, '<time>')
}

/** 跑一遍闭环。时钟从剧本派生 —— 不碰 `Date.now()`,快照因此逐字节稳定。 */
async function replay(): Promise<ReplayResult> {
  const clock = { now: 1_000 }
  const trace: string[] = []
  const mailbox = new InMemoryMailbox<ActorEvent<CollabActorVerb>>()

  const mind = createCollabScriptedMindPort([
    // 第一轮:群里被点名派活,它答应下来(真机上同一轮里调 board start)。
    { agentId: AGENT, roomId: ROOM, says: ['好,我来写,写完发群里'] },
    // 第二轮:活已经干完了 —— 它读到的是信封,不是正文。
    { agentId: AGENT, roomId: ROOM, says: ['纪要交了,细节在卡上'] },
  ])
  const work = createCollabScriptedWorkerPort([{
    cardId: CARD,
    outcome: 'complete',
    summary: WORK_SUMMARY,
    evidence: [{ kind: 'file', ref: 'notes/0803.md' }, { kind: 'tool', ref: 'write', count: 1 }],
    workSessionId: 'work-42',
  }])
  const board = createCollabWorkerBoardRecorder({ digest: () => `<card id="${CARD}" status="doing"/>` })

  let ordinal = 0
  const deliver = (verb: CollabActorVerb, from: 'room' | 'self'): Promise<void> => {
    ordinal += 1
    trace.push(`in   ${formatCollabActorVerb(verb)}`)
    return mailbox.append(createActorEvent<CollabActorVerb>({
      id: `golden-${ordinal}`,
      at: clock.now,
      type: verb.type,
      from: from === 'room' ? collabActorRef('room', ROOM) : collabActorRef('agent', AGENT),
      to: collabActorRef('agent', AGENT),
      payload: verb,
    }))
  }

  const host: CollabAgentActorHost = {
    execSessionId: (agentId, roomId) => `agent-exec-${agentId}-${roomId}`,
    buildRoomContext: input => `<ChatRoom id="${input.roomId}" bootstrap="${input.bootstrap}"/>`,
    roomOutbox: roomId => ({
      post: verb => {
        trace.push(`out  ${formatCollabActorVerb(verb)}`)
        void roomId
        return Promise.resolve()
      },
    }),
    members: () => [{ id: AGENT, name: '小艾' }],
    roomLabel: () => '产品组',
    speakerLabel: id => (id === AGENT ? '小艾' : id),
    now: () => clock.now,
  }

  const actor = new CollabAgentActor({
    agentId: AGENT,
    host,
    mindPort: mind,
    notebook: createCollabNotebookMemoryStore(),
    mailbox,
    store: createCollabAgentAccountMemoryStore(),
    worker: {
      port: work,
      board,
      postResult: verb => deliver(verb, 'self'),
    },
  })

  const quiesce = async (): Promise<void> => {
    for (let round = 0; round < 40; round += 1) {
      await actor.drain()
      await actor.settleWorkers()
      await tick()
      if (mailbox.pendingCount() === 0 && actor.runningWorkerIds.length === 0) {
        await actor.drain()
        if (mailbox.pendingCount() === 0) return
      }
    }
    throw new Error('[worker-golden] 环没闭合')
  }

  actor.start()

  // ① 群里派活:人类点名。
  await deliver(collabRoomPosted({
    roomId: ROOM,
    author: collabActorRef('user', 'user'),
    message: {
      id: 'm-1',
      role: 'user',
      content: '@小艾 把今天的会议纪要写一下',
      timestamp: clock.now,
      mentions: [{ agentId: AGENT, label: '小艾' }],
    },
  }), 'room')
  await quiesce()

  // ② 房间发牌 → 第一轮对话回合(它在这一轮里答应下来)。
  clock.now = 2_000
  await deliver(collabRoomFloorGranted({
    roomId: ROOM,
    agentId: AGENT,
    lease: { leaseId: 'L1', epoch: 1, roomId: ROOM, agentId: AGENT, issuedAt: clock.now },
  }), 'room')
  await quiesce()

  // ③ 开工 —— 真机上是同一轮里的 `board start`(D6 接线),这里由剧本代发。
  clock.now = 3_000
  await deliver(collabAgentSpawnWorker({
    agentId: AGENT,
    workerId: 'w-42',
    cardId: CARD,
    roomId: ROOM,
    title: '写今天的会议纪要',
    description: '两页以内,发群里',
  }), 'self')
  await quiesce()

  // ④ 干完之后房间再发一次牌 → 第二轮对话回合。
  clock.now = 4_000
  await deliver(collabRoomFloorGranted({
    roomId: ROOM,
    agentId: AGENT,
    lease: { leaseId: 'L2', epoch: 1, roomId: ROOM, agentId: AGENT, issuedAt: clock.now },
  }), 'room')
  await quiesce()

  await actor.stop()

  const drives = mind.calls.map(call => call.driveContent)
  const snapshot = [
    '## verbs',
    ...trace,
    '## board',
    ...board.calls.map(call => [
      call.kind,
      `card=${call.cardId}`,
      `agent=${call.agentId}`,
      call.outcome ? `outcome=${call.outcome}` : '',
      call.workSessionId ? `session=${call.workSessionId}` : '',
      `at=${call.at}`,
    ].filter(Boolean).join(' ')),
    ...drives.flatMap((drive, index) => [`## drive ${index + 1}`, scrubTimes(drive)]),
    '',
  ].join('\n')

  return {
    lines: trace,
    drives,
    snapshot,
    workerResults: actor.account.workerResults,
    workers: actor.account.workers.map(entry => ({
      cardId: entry.cardId,
      status: entry.status,
      ...(entry.outcome ? { outcome: entry.outcome } : {}),
      ...(entry.workSessionId ? { workSessionId: entry.workSessionId } : {}),
    })),
  }
}

describe('金重放:群里派活 → 派手 → 干完 → 下一轮信封可见', () => {
  it('闭环与快照逐字节相同', async () => {
    const result = await replay()
    if (process.env.COLLAB_WORKER_WRITE_GOLDEN === '1') writeFileSync(GOLDEN, result.snapshot, 'utf-8')
    expect(result.snapshot).toBe(readFileSync(GOLDEN, 'utf-8'))
  })

  it('两次重放完全一致(确定性)', async () => {
    const first = await replay()
    const second = await replay()
    expect(second.snapshot).toBe(first.snapshot)
  })

  it('第一轮读不到任何工作信封(那时候活还没派出去)', async () => {
    const result = await replay()
    expect(result.drives[0]).not.toContain('<worker')
  })

  it('第二轮读得到信封:一行、有卡号、没有正文', async () => {
    const result = await replay()
    const drive = result.drives[1]
    expect(drive).toContain(`<worker`)
    expect(drive).toContain(`card="${CARD}" ok="yes"`)
    // 摘要与产出路径都是正文,一个字都不该进 drive。
    expect(drive).not.toContain(WORK_SUMMARY)
    expect(drive).not.toContain('notes/0803.md')
    // 卡的标题同理(envelope-fold 的既定纪律)。
    expect(drive).not.toContain('会议纪要')
  })

  it('账收得住:一份结果、一条 done 记录、会话 id 记下了', async () => {
    const result = await replay()
    expect(result.workerResults).toBe(1)
    expect(result.workers).toEqual([
      { cardId: CARD, status: 'done', outcome: 'complete', workSessionId: 'work-42' },
    ])
  })
})
