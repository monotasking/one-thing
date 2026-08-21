/**
 * 金重放:四条发言策略各一份快照(D3)。
 *
 * D1 的快照回答「同一段真实对话,新运行时会怎么处理?」。这一份把问题换成:
 * **同一段对话,换一档发言策略会怎么处理?** —— 四份快照并排放着,策略之间的
 * 差别第一次成了可以逐字节对比的东西,而不是四段各自为政的控制流。
 *
 * 环里唯一的假件是**裁决**(`free` / `waves` 那两档要一次模型调用),换成一份剧本。
 * 其余每一行都是真的:房间的账、三道闸、发牌、队列结算、换代,走的都是真机那条
 * `decide()`。这条缝是有意的 —— 真调模型的快照只会变成「今天这个模型想说什么」。
 *
 * 数据纪律沿用 D0:fixture 全部合成。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { InMemoryMailbox, type ActorEvent } from '@onething/core/actors'
import {
  collabAgentRaiseHand,
  collabAgentSpeak,
  collabAgentYield,
  collabRoomActiveLeases,
  formatCollabActorReplay,
  formatCollabActorVerb,
  parseRoomTranscriptJsonl,
  replayRoomTranscript,
  type CollabActorReplayTranscript,
  type CollabActorVerb,
  type CollabRefereeVerdict,
  type CollabRoomEffects,
  type CollabRoomJudgmentRequest,
  type CollabRoomTranscriptMessage,
} from '@onething/runtime/collab/actors'
import { describe, expect, it } from 'vitest'

import {
  CollabRefereeActor,
  createCollabScriptedRefereeJudgePort,
  type CollabRefereeActorHost,
} from '../referee-actor.js'
import {
  collabRoomMembersFromTranscript,
  createCollabRoomActorReplayPipeline,
  type CollabRoomReplayOptions,
} from '../room-replay.js'
import { createCollabRoomAccountMemoryStore } from '../room-account.js'
import { CollabRoomActor, type CollabRoomActorHost } from '../room-actor.js'

const GOLDEN_DIR = join(__dirname, '../../../../onething-runtime/src/collab/actors/__tests__/golden')

function loadGolden(name: string, roomId: string): CollabActorReplayTranscript {
  return parseRoomTranscriptJsonl(readFileSync(join(GOLDEN_DIR, `${name}.jsonl`), 'utf-8'), roomId)
}

function expectedSnapshot(name: string): string {
  return readFileSync(join(GOLDEN_DIR, `${name}.expected.txt`), 'utf-8')
}

/* ── free:批量举手裁决 ──────────────────────────────────────────────────── */

/**
 * 脚本化的裁判。
 *
 * 第一扇窗**故意答空**:它把「裁后放手」这件事变成可见的 —— ana 被判过、没被点名,
 * 手当场放下,于是下一扇窗只有 bo 一个候选,ana 那句 rf-2 就此说不出口。它要到
 * rf-6 才重新举手、重新被判(手随消息走,这一轮的沉默是终审)。
 *
 * 旧快照在这里是反的:ana 的手留着,跟着 bo 那扇窗一起被判、一起拿牌 —— 一只
 * 属于上一条消息的手混进了下一条消息的裁决窗。真机上这个形状的另一半是永不清零
 * 的「N 人排队中」(走查发现 1)。
 *
 * 其余每一扇窗都按队列原序把候选放出去。
 */
function freeJudgeScript(): (
  request: CollabRoomJudgmentRequest,
  account: { hands: readonly { agentId: string }[] },
) => CollabRefereeVerdict {
  let seen = 0
  return (request, account) => {
    seen += 1
    return {
      token: request.token,
      grants: seen === 1 ? [] : account.hands.map(hand => hand.agentId),
      why: `第 ${seen} 次裁决`,
    }
  }
}

function replayFree(overrides: Partial<CollabRoomReplayOptions> = {}) {
  const roomId = 'referee-free'
  const transcript = loadGolden('referee-free', roomId)
  const pipeline = createCollabRoomActorReplayPipeline({
    roomId,
    members: collabRoomMembersFromTranscript(transcript),
    referee: true,
    judge: freeJudgeScript(),
    // 两个座位:一份「ana 然后 bo」的裁决因此能一次兑现两张牌(批内并行)。
    maxConcurrent: 2,
    ...overrides,
  })
  return { transcript, pipeline, result: replayRoomTranscript({ transcript, pipeline }) }
}

describe('金重放:free 批量举手裁决', () => {
  it('动词序列与快照逐字节相同', () => {
    const { result } = replayFree()
    expect(formatCollabActorReplay(result)).toBe(expectedSnapshot('referee-free.room-actor'))
  })

  it('两次重放完全一致(确定性)', () => {
    const first = replayFree()
    const second = replayFree()
    expect(formatCollabActorReplay(second.result)).toBe(formatCollabActorReplay(first.result))
  })

  it('一扇窗一次裁决 —— 判了几次 = 开了几扇窗,没有窗判两遍', () => {
    const { pipeline, result } = replayFree()
    const windows = result.verbs.filter(
      verb => verb.type === 'referee:set-floor-policy'
        && (verb as { params?: { verdictToken?: string } }).params?.verdictToken !== undefined,
    )
    // 判了几次 = 开了几扇窗 = 下发了几份裁决。三个数必须相等,不然就有窗没关。
    expect(pipeline.judgeCalls()).toBe(windows.length)
    // 一只手至多进一扇窗:剧本里每次举手各开一扇,调用数因此不超过举手数。
    // 「N 个候选一次调用」那一面在 referee-actor.test.ts 里钉(三只手、一扇窗)——
    // 这份剧本一次只来一只手,量不出 O(1),但量得出「没有哪只手被判两遍」。
    expect(pipeline.judgeCalls()).toBeLessThanOrEqual(
      result.verbs.filter(verb => verb.type === 'agent:raise-hand').length,
    )
  })

  it('裁决答空 = 这轮没人说:ana 的手当场放下,rf-2 那句话说不出口', () => {
    const { pipeline, result } = replayFree()
    const spoke = result.verbs
      .filter(verb => verb.type === 'agent:speak')
      .map(verb => (verb as { agentId: string }).agentId)
    // rf-2 的 ana 被裁决按下,手随着这份终审放掉;它到 rf-6 重新举手才说上话。
    expect(spoke).toEqual(['bo', 'cy', 'ana'])
    const raised = result.verbs
      .filter(verb => verb.type === 'agent:raise-hand')
      .map(verb => (verb as { agentId: string }).agentId)
    expect(raised).toEqual(['ana', 'bo', 'cy', 'ana'])
    // 跑完之后队列是干净的 —— 幽灵排队的反面。
    expect(pipeline.account().hands).toEqual([])
  })

  it('降级链:裁判答不上来 → 行为退回 D1 的举手 FIFO', () => {
    // 每一扇窗都答不上来(judge 返回 null)。
    const degraded = replayFree({ judge: () => null })
    const spokeDegraded = degraded.result.verbs
      .filter(verb => verb.type === 'agent:speak')
      .map(verb => (verb as { agentId: string }).agentId)

    // 同一份剧本、不挂裁判 —— 这就是 D1 的 `free`。
    const roomId = 'referee-free'
    const transcript = loadGolden('referee-free', roomId)
    const d1 = createCollabRoomActorReplayPipeline({
      roomId,
      members: collabRoomMembersFromTranscript(transcript),
    })
    const spokeD1 = replayRoomTranscript({ transcript, pipeline: d1 }).verbs
      .filter(verb => verb.type === 'agent:speak')
      .map(verb => (verb as { agentId: string }).agentId)

    expect(spokeDegraded).toEqual(spokeD1)
    // 而且账是干净的:没有一扇窗留在开着的状态。
    expect(degraded.pipeline.account().judgment).toBeUndefined()
  })
})

/* ── ring:接力 ──────────────────────────────────────────────────────────── */

function replayRing() {
  const roomId = 'relay-count'
  const transcript = loadGolden('relay-count', roomId)
  const pipeline = createCollabRoomActorReplayPipeline({
    roomId,
    // 环序显式给:@ 的目标要提前在名册里(fixture 第一条就点了 bo 的名)。
    members: [
      { id: 'ana', name: '阿般' },
      { id: 'bo', name: '小博' },
      { id: 'cy', name: 'Iris' },
    ],
    policy: 'ring',
    // 两圈收棒 —— 「收棒权在配置,不在模型」(§8)。
    policyParams: { order: ['ana', 'bo', 'cy'], relayLoops: 2 },
  })
  return { transcript, pipeline, result: replayRoomTranscript({ transcript, pipeline }) }
}

describe('金重放:ring 接力', () => {
  it('动词序列与快照逐字节相同', () => {
    const { result } = replayRing()
    expect(formatCollabActorReplay(result)).toBe(expectedSnapshot('relay-count.room-actor'))
  })

  it('免判定:一次裁决都没买', () => {
    const { pipeline } = replayRing()
    expect(pipeline.judgeCalls()).toBe(0)
  })

  it('@ 定起棒人,其后严格按环序接力', () => {
    const { result } = replayRing()
    const spoke = result.verbs
      .filter(verb => verb.type === 'agent:speak')
      .map(verb => (verb as { agentId: string }).agentId)
    // 起棒人是被 @ 的 bo(不是环首 ana);之后 cy → ana → bo → cy 严格按环走。
    expect(spoke).toEqual(['bo', 'cy', 'ana', 'bo', 'cy'])
  })

  it('relayLoops 收棒:第 6 个数说不出口 —— 圈数到顶,棒子退休', () => {
    const { pipeline, result } = replayRing()
    const spoke = result.verbs.filter(verb => verb.type === 'agent:speak')
    // fixture 里有 6 条 agent 消息,只走出 5 棒。
    expect(spoke).toHaveLength(5)
    expect(pipeline.account().policyState?.ringLaps).toBe(2)
  })
})

/* ── 配置驱动:responseMode → 策略档(D6 接线) ─────────────────────────── */

/**
 * 同一份接力剧本,这次**不显式换档** —— 只给一间 `responseMode: 'serial'` 的房间
 * 设置,由 `resolveCollabRoomFloorPolicy` 翻成 `ring`。
 *
 * 它答的问题与上面那组不同:上面问"跑在 ring 上会怎样",这里问"用户在设置里
 * 选了接力会怎样"—— 而 D6 漏掉的恰恰是这两者之间那一步(房账新建一律 `free`,
 * `roomHost()` 里没有 `responseMode`,于是接力房在 v3 一律跑成自由发言)。
 */
function replayRingFromRoomConfig(room: Parameters<typeof createCollabRoomActorReplayPipeline>[0]['room']) {
  const roomId = 'relay-count'
  const transcript = loadGolden('relay-count', roomId)
  const pipeline = createCollabRoomActorReplayPipeline({
    roomId,
    members: [
      { id: 'ana', name: '阿般' },
      { id: 'bo', name: '小博' },
      { id: 'cy', name: 'Iris' },
    ],
    ...(room ? { room } : {}),
  })
  return { transcript, pipeline, result: replayRoomTranscript({ transcript, pipeline }) }
}

describe('配置驱动:responseMode → 发言策略', () => {
  const SERIAL_ROOM = { responseMode: 'serial' as const, speakOrder: ['ana', 'bo', 'cy'], relayLoops: 2 }

  it("serial 房 = 接力环:与显式 set-floor-policy 的快照逐字节相同", () => {
    const configured = replayRingFromRoomConfig(SERIAL_ROOM)
    // 同一份剧本、同一份快照 —— 两种给法之间没有第二套语义。
    expect(formatCollabActorReplay(configured.result)).toBe(expectedSnapshot('relay-count.room-actor'))
    expect(formatCollabActorReplay(configured.result)).toBe(formatCollabActorReplay(replayRing().result))
  })

  it('serial 房免判定:一次裁决都没买', () => {
    expect(replayRingFromRoomConfig(SERIAL_ROOM).pipeline.judgeCalls()).toBe(0)
  })

  it('serial 房的 relayLoops 照旧收棒 —— 收棒权在**设置**,不在模型', () => {
    const { pipeline, result } = replayRingFromRoomConfig(SERIAL_ROOM)
    expect(result.verbs.filter(verb => verb.type === 'agent:speak')).toHaveLength(5)
    expect(pipeline.account().policyState?.ringLaps).toBe(2)
  })

  it('auto 房 → waves 档(编排等裁判下发,房间先站到编排位上)', () => {
    const { pipeline } = replayRingFromRoomConfig({ responseMode: 'auto' })
    expect(pipeline.account().policy.name).toBe('waves')
    // 编排那一格空着 —— 站到编排位上不等于已经有编排(空编排回落 free 的批量裁决)。
    expect(pipeline.account().policy.params?.waves).toBeUndefined()
  })

  it('缺省 / parallel → free:一条也不接力,行为与不给任何配置的那条基线相同', () => {
    for (const room of [{}, { responseMode: 'parallel' as const }]) {
      const configured = replayRingFromRoomConfig(room)
      expect(configured.pipeline.account().policy.name).toBe('free')
      expect(formatCollabActorReplay(configured.result))
        .toBe(formatCollabActorReplay(replayRingFromRoomConfig(undefined).result))
    }
  })
})

/* ── waves:编排 ─────────────────────────────────────────────────────────── */

function replayWaves() {
  const roomId = 'waves-review'
  const transcript = loadGolden('waves-review', roomId)
  const pipeline = createCollabRoomActorReplayPipeline({
    roomId,
    members: [
      { id: 'ana', name: '阿般' },
      { id: 'bo', name: '小博' },
      { id: 'cy', name: 'Iris' },
      { id: 'dan', name: '小丹' },
    ],
    policy: 'waves',
    // 先出方案(一个人),再两位一起评审 —— 批内并行、批间串行。
    policyParams: { waves: [['ana'], ['bo', 'cy']], why: '先出稿再评审' },
    maxConcurrent: 2,
  })
  return { transcript, pipeline, result: replayRoomTranscript({ transcript, pipeline }) }
}

describe('金重放:waves 编排', () => {
  it('动词序列与快照逐字节相同', () => {
    const { result } = replayWaves()
    expect(formatCollabActorReplay(result)).toBe(expectedSnapshot('waves-review.room-actor'))
  })

  it('批边界:第一批交牌之后第二批才整批发出去', () => {
    const { result } = replayWaves()
    const grants = result.verbs
      .filter(verb => verb.type === 'room:floor-granted')
      .map(verb => (verb as { agentId: string }).agentId)
    // ana 一个人先来;bo 与 cy **同时**拿到牌(批内并行)。
    expect(grants.slice(0, 3)).toEqual(['ana', 'bo', 'cy'])
  })

  it('不在编排里的人说不出口', () => {
    const { result } = replayWaves()
    const spoke = result.verbs
      .filter(verb => verb.type === 'agent:speak')
      .map(verb => (verb as { agentId: string }).agentId)
    // wr-5 的 dan 不在任何一批里 —— 它那句话在 v3 说不出口,直到被 @。
    expect(spoke.slice(0, 3)).toEqual(['ana', 'bo', 'cy'])
  })

  it('@ 机械插批:被点名的 dan 在编排之外直通', () => {
    const { result } = replayWaves()
    const grants = result.verbs
      .filter(verb => verb.type === 'room:floor-granted')
      .map(verb => (verb as { agentId: string }).agentId)
    // dan 一个 wave 都不在,wr-5 那句话因此说不出口;wr-6 的 @ 让他**当场**拿到牌,
    // 不必等下一批 —— 断言看的是发牌而不是发言:重放里 dan 已经没有下一句要说了。
    expect(grants).toContain('dan')
    expect(grants.indexOf('dan')).toBeGreaterThan(grants.indexOf('cy'))
  })

  it('人类插话重置编排:下一轮从第一批重新走', () => {
    const { pipeline } = replayWaves()
    // wr-6 清链,顺带把批位归零 —— 那一轮的编排已经不是在答这条新消息了。
    expect(pipeline.account().policyState?.waveIndex).toBe(0)
  })
})

/* ── phase:换相(狼人杀夜/昼) ─────────────────────────────────────────── */

/**
 * 两间房 + 一个裁判的小剧本 —— 相位是**跨房**的,单房的重放架讲不出这件事。
 *
 * 夜相:狼房活,群房死。群房里举的手挂着,一张牌都不发。
 * 昼相:反转。群房里那两只挂着的手当场兑现,狼房哑掉。
 */
async function replayWerewolfPhases(): Promise<{ lines: string[]; rooms: Map<string, CollabRoomActor> }> {
  let clock = 1_000
  const lines: string[] = []
  const ROOMS = {
    den: 'wolf-den',
    village: 'village',
  }
  const MEMBERS: Record<string, { id: string; name: string }[]> = {
    [ROOMS.den]: [{ id: 'wolf-a', name: 'wolf-a' }, { id: 'wolf-b', name: 'wolf-b' }],
    [ROOMS.village]: [
      { id: 'wolf-a', name: 'wolf-a' },
      { id: 'wolf-b', name: 'wolf-b' },
      { id: 'seer', name: 'seer' },
      { id: 'villager', name: 'villager' },
    ],
  }
  const messages = new Map<string, CollabRoomTranscriptMessage[]>()
  for (const roomId of Object.values(ROOMS)) messages.set(roomId, [])

  /** 房间的每一次决策都记进 trace —— 房间是唯一的串行点(与 D2 duet 同一条论证)。 */
  class TracingRoomActor extends CollabRoomActor {
    override decide(verb: CollabActorVerb): CollabRoomEffects {
      lines.push(`[${this.roomId}] ${formatCollabActorVerb(verb)}`)
      const effects = super.decide(verb)
      for (const entry of effects.broadcast) {
        if (entry === verb) continue
        lines.push(`[${this.roomId}] ${formatCollabActorVerb(entry)}`)
      }
      return effects
    }
  }

  const rooms = new Map<string, CollabRoomActor>()
  for (const roomId of Object.values(ROOMS)) {
    const host: CollabRoomActorHost = {
      members: () => MEMBERS[roomId],
      frozen: () => false,
      overBudget: () => false,
      maxChain: () => Number.POSITIVE_INFINITY,
      maxConcurrent: () => 1,
      appendMessage: (_roomId, message) => {
        messages.get(roomId)?.push(message)
      },
      memberMailbox: () => undefined,
      newMessageId: seed => seed,
      now: () => clock,
    }
    rooms.set(roomId, new TracingRoomActor({
      roomId,
      host,
      store: createCollabRoomAccountMemoryStore(),
      mailbox: new InMemoryMailbox<ActorEvent<CollabActorVerb>>(),
    }))
  }

  const refereeHost: CollabRefereeActorHost = {
    candidates: roomId => rooms.get(roomId)?.account.hands ?? [],
    members: roomId => MEMBERS[roomId] ?? [],
    recent: roomId => messages.get(roomId) ?? [],
    roomOutbox: roomId => {
      const room = rooms.get(roomId)
      if (!room) return undefined
      return { post: async verb => { await room.commit(room.decide(verb)) } }
    },
    now: () => clock,
  }
  const referee = new CollabRefereeActor({
    refereeId: 'judge',
    host: refereeHost,
    // 相位是免裁决的:相位表本身就是裁判已经做过的判断。
    judge: createCollabScriptedRefereeJudgePort(),
  })

  const drive = async (roomId: string, verb: CollabActorVerb): Promise<void> => {
    const room = rooms.get(roomId)!
    await room.commit(room.decide(verb))
  }
  const speak = async (roomId: string, agentId: string, content: string): Promise<void> => {
    const room = rooms.get(roomId)!
    const lease = collabRoomActiveLeases(room.account, clock).find(entry => entry.agentId === agentId)
    if (!lease) return
    await drive(roomId, collabAgentSpeak({ roomId, agentId, leaseId: lease.leaseId, content }))
    await drive(roomId, collabAgentYield({ roomId, agentId, leaseId: lease.leaseId, reason: 'done' }))
  }

  /* 天黑请闭眼 —— 只有狼房发牌。 */
  clock += 100
  await referee.changePhase({
    phase: 'night',
    rooms: Object.values(ROOMS),
    activeRooms: [ROOMS.den],
  })

  // 群房里两个人想说话:手挂着,一张牌都不发。
  clock += 100
  await drive(ROOMS.village, collabAgentRaiseHand({ roomId: ROOMS.village, agentId: 'villager' }))
  clock += 100
  await drive(ROOMS.village, collabAgentRaiseHand({ roomId: ROOMS.village, agentId: 'seer' }))

  // 狼房照常议事。
  clock += 100
  await drive(ROOMS.den, collabAgentRaiseHand({ roomId: ROOMS.den, agentId: 'wolf-a' }))
  clock += 100
  await speak(ROOMS.den, 'wolf-a', '今晚刀 4 号。')

  /* 天亮了 —— 反转。 */
  clock += 100
  await referee.changePhase({
    phase: 'day',
    rooms: Object.values(ROOMS),
    activeRooms: [ROOMS.village],
  })

  clock += 100
  await speak(ROOMS.village, 'villager', '昨夜 4 号没了,说说各自的想法。')

  return { lines, rooms }
}

describe('金重放:phase 换相(狼人杀夜/昼)', () => {
  it('动词序列与快照逐字节相同', async () => {
    const { lines } = await replayWerewolfPhases()
    expect(`${lines.join('\n')}\n`).toBe(expectedSnapshot('werewolf-phase.room-actor'))
  })

  it('两次重放完全一致(确定性)', async () => {
    const first = await replayWerewolfPhases()
    const second = await replayWerewolfPhases()
    expect(second.lines).toEqual(first.lines)
  })

  it('夜相:群房举手挂起,一张牌都不发', async () => {
    const { lines } = await replayWerewolfPhases()
    const nightVillageGrants = lines
      .slice(0, lines.findIndex(line => line.includes('phase="day"')))
      .filter(line => line.startsWith('[village] room:floor-granted'))
    expect(nightVillageGrants).toEqual([])
  })

  it('昼相:挂着的手一只不丢,当场兑现', async () => {
    const { rooms } = await replayWerewolfPhases()
    const village = rooms.get('village')!
    // villager 说完让位之后,轮到 seer —— 夜里举的那只手活到了天亮。
    expect(village.account.floor.active.map(lease => lease.agentId)).toEqual(['seer'])
  })

  it('换相即换代:狼在天亮之后开不了口', async () => {
    const { rooms } = await replayWerewolfPhases()
    const den = rooms.get('wolf-den')!
    expect(den.account.phase).toBe('day')
    expect(den.account.floor.active).toEqual([])
  })
})
