/**
 * 双 actor 金重放:RoomActor + N 个 AgentActor 组成闭环
 * (docs/design/collab-actor-v3.md §7 风险 1 的对策,D2 集成面)。
 *
 * D1 的重放架只有房间,而且只调同步的 `decide()` —— 它问的是「一条消息导致了什么
 * 决策」。这一份把心智循环也接进来,问的是**下一个问题**:
 *
 *     posted → 举手 → 发牌 → 说话 → 广播 → 游标推进,这条环闭得上吗?
 *
 * 环里唯一的假件是 `CollabMindPort`(剧本化的假端口):谁在什么时候被点到、拿到
 * 什么 drive、说了什么,全是真的;只有「模型怎么想」被换成了一份剧本。这条缝是
 * 有意的 —— 真调模型的快照只会变成「今天这个模型想说什么」。
 *
 * ## 输入:一份或多份房间转录
 *
 * 转录在这里有两个身份:
 *
 *  1. **非 agent 的消息**(人类、系统)= 注入。按全局时间序一条一条投进房间。
 *  2. **agent 的消息** = 那位同事在那间房的**剧本**。它拿到牌的时候说的就是这句。
 *
 * 这与 D1 的读法是同一个道理:转录里「它说了这句」在 v3 的语义是「它当时想说话」,
 * 而想说话与说得成之间隔着三道闸。区别只是 D1 用一条捷径替它举手,这里由**真的**
 * 心智循环去举、去等牌、去说。
 *
 * ## 确定性的两个前提
 *
 *  - **时钟从转录派生**。不碰 `Date.now()`、不碰 `randomUUID` —— 消息 id 用确定性
 *    种子,事件 id 用「谁 + 第几个」。
 *  - **一次注入只叫得动一位同事**。两个 agent 的循环被同一次广播唤醒时,谁的
 *    举手先到房间取决于微任务调度;fixture 因此让每条注入只 `@` 一个人。这不是
 *    对运行时的限制(真机当然可以一次点名三个人),是对**快照**的限制:一个
 *    会飘的快照比没有快照更糟。并发争抢那一面由 D1 的 `floor-contest` 剧本守着,
 *    那条路是同步的,不受调度影响。
 */
import { InMemoryMailbox, createActorEvent, type ActorEvent } from '@onething/core/actors'
import {
  buildCollabDriveRoomContext,
  collabAgentSessionId,
  planCollabHistoryWindow,
  type CollabAgentLike,
  type CollabMessageLike,
} from '@onething/runtime/collab'
import {
  formatCollabActorVerb,
  type CollabActorReplayTranscript,
  type CollabActorVerb,
  type CollabAgentAccount,
  type CollabRoomEffects,
  type CollabRoomTranscriptMessage,
} from '@onething/runtime/collab/actors'

import {
  createCollabAgentAccountMemoryStore,
  type CollabAgentAccountStore,
} from './agent-mailbox.js'
import {
  CollabAgentActor,
  type CollabAgentActorHost,
  type CollabAgentTurnFailure,
} from './agent-actor.js'
import {
  createCollabScriptedMindPort,
  type CollabScriptedCall,
  type CollabScriptedMindPort,
  type CollabScriptedTurn,
} from './mind-port.js'
import { createCollabNotebookMemoryStore, type CollabNotebookStore } from './notebook-store.js'
import { createCollabRoomAccountMemoryStore } from './room-account.js'
import { CollabRoomActor, type CollabRoomActorHost } from './room-actor.js'

export interface CollabDuetRoomSpec {
  roomId: string
  transcript: CollabActorReplayTranscript
  /** 在职成员。缺省从转录里现取(首次出现序)。 */
  members?: readonly CollabAgentLike[]
  /** 房间名 —— 进信封的 `room` 属性与投影的 `<ChatRoom name>`。缺省用 id。 */
  roomLabel?: string
  /** 这间房是私聊吗(启发式举手的第二条)。 */
  dm?: boolean
  maxConcurrent?: number
  maxChain?: number
}

export interface CollabDuetReplayOptions {
  rooms: readonly CollabDuetRoomSpec[]
  /** 时钟起点。重放不碰 `Date.now()`。 */
  startedAt?: number
  /** 折叠信封的渲染上限(收紧它就能造出 `<more>`)。 */
  foldLimits?: { maxEvents?: number; maxPerRoom?: number }
  /** 笔记注入预算。 */
  notebookBudget?: number
  /** 预置的笔记(测试「跨房可见」时,直接种一本)。 */
  notebooks?: Readonly<Record<string, string>>
  /** 静默轮数上限 —— 环没闭合时不让测试挂死。 */
  maxSettleRounds?: number
}

export interface CollabDuetReplayResult {
  /** 房间视角的全部动词,按序。金快照比的就是它。 */
  verbs: CollabActorVerb[]
  lines: string[]
  /** 每一次心智调用 —— 保密不变量的测试读 `driveContent`。 */
  calls: CollabScriptedCall[]
  /** 各房最终转录。 */
  messages: Record<string, CollabRoomTranscriptMessage[]>
  /** 各 agent 的账(水位、折叠缓冲、租约)。 */
  accounts: Record<string, CollabAgentAccount>
  /** 各 agent 的笔记。 */
  notebooks: Record<string, string>
  /** 回合里炸掉的那些。环跑通时它必须是空的。 */
  failures: CollabAgentTurnFailure[]
}

/** 转录里出现过的 agent,按首次出现序 —— 与 D1 的名册取法一致。 */
export function collabDuetMembersOf(transcript: CollabActorReplayTranscript): CollabAgentLike[] {
  const seen = new Set<string>()
  const members: CollabAgentLike[] = []
  for (const message of transcript.messages) {
    const agentId = message.agentId
    if (!agentId || seen.has(agentId)) continue
    seen.add(agentId)
    members.push({ id: agentId, name: agentId })
  }
  return members
}

/** 房间账/消息 id 的确定性种子 —— 与 D1 的重放同一套(`newMessageId: seed => seed`)。 */
function orderMessages(messages: readonly CollabMessageLike[]): CollabMessageLike[] {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((a, b) => (a.message.timestamp ?? 0) - (b.message.timestamp ?? 0) || a.index - b.index)
    .map(entry => entry.message)
}

/**
 * 跑一遍闭环。
 *
 * 「跑完了」的判据是**静默**:所有信箱空、所有心智回合收尾。一次注入之后要循环
 * 好几轮才静下来(posted → 举手 → 发牌 → 回合 → speak → 广播 → …),所以这里
 * 反复 drain 直到两件事同时为真。
 */
export async function replayCollabDuet(
  options: CollabDuetReplayOptions,
): Promise<CollabDuetReplayResult> {
  const clock = { now: options.startedAt ?? 0 }
  const verbs: CollabActorVerb[] = []

  /* ── 名册与剧本 ─────────────────────────────────────────────────────── */

  const specs = options.rooms.map(spec => ({
    ...spec,
    members: spec.members ? [...spec.members] : collabDuetMembersOf(spec.transcript),
    roomLabel: spec.roomLabel ?? spec.roomId,
  }))

  const script: CollabScriptedTurn[] = []
  const injections: Array<{ roomId: string; message: CollabMessageLike }> = []
  for (const spec of specs) {
    for (const message of orderMessages(spec.transcript.messages)) {
      if (message.agentId) {
        script.push({ agentId: message.agentId, roomId: spec.roomId, says: [message.content] })
        continue
      }
      injections.push({ roomId: spec.roomId, message })
    }
  }
  injections.sort((a, b) => (a.message.timestamp ?? 0) - (b.message.timestamp ?? 0))

  const agentIds = [...new Set(specs.flatMap(spec => spec.members.map(member => member.id)))]
  const memberName = new Map<string, string>()
  for (const spec of specs) {
    for (const member of spec.members) memberName.set(member.id, member.name)
  }

  /* ── 信箱、账、笔记 ─────────────────────────────────────────────────── */

  const roomMailboxes = new Map<string, InMemoryMailbox<ActorEvent<CollabActorVerb>>>()
  const agentMailboxes = new Map<string, InMemoryMailbox<ActorEvent<CollabActorVerb>>>()
  for (const spec of specs) roomMailboxes.set(spec.roomId, new InMemoryMailbox())
  for (const agentId of agentIds) agentMailboxes.set(agentId, new InMemoryMailbox())

  const roomMessages = new Map<string, CollabRoomTranscriptMessage[]>()
  for (const spec of specs) roomMessages.set(spec.roomId, [])

  const notebook: CollabNotebookStore = createCollabNotebookMemoryStore(options.notebooks ?? {})
  const accountStore: CollabAgentAccountStore = createCollabAgentAccountMemoryStore()
  const mindPort: CollabScriptedMindPort = createCollabScriptedMindPort(script)
  const failures: CollabAgentTurnFailure[] = []

  let eventOrdinal = 0
  const nextEventId = (from: string, verb: CollabActorVerb): string => {
    eventOrdinal += 1
    return `duet:${from}:${verb.type}:${eventOrdinal}`
  }

  /* ── 房间 ───────────────────────────────────────────────────────────── */

  /**
   * 把房间的每一次决策记进 trace。
   *
   * 记在房间而不是记在各 agent 的投递口:房间是**唯一的串行点**,两个 agent
   * 谁先把信投进来由调度决定,而它们被房间处理的次序是它自己的信箱决定的 ——
   * 后者才是可重放的那个次序。
   */
  class TracingRoomActor extends CollabRoomActor {
    override decide(verb: CollabActorVerb): CollabRoomEffects {
      verbs.push(verb)
      const effects = super.decide(verb)
      // 与输入同一个对象的那条广播要滤掉:一条消息进来、房间原样播出去,是同一封
      // 信的两次出现(D1 重放的同一条论证)。
      verbs.push(...effects.broadcast.filter(entry => entry !== verb))
      return effects
    }
  }

  const rooms = new Map<string, CollabRoomActor>()
  for (const spec of specs) {
    const host: CollabRoomActorHost = {
      members: () => spec.members,
      frozen: () => false,
      overBudget: () => false,
      maxChain: () => spec.maxChain ?? Number.POSITIVE_INFINITY,
      maxConcurrent: () => spec.maxConcurrent ?? 1,
      ...(spec.dm ? { pairDm: () => true } : {}),
      appendMessage: (_roomId, message) => {
        roomMessages.get(spec.roomId)?.push(message)
      },
      memberMailbox: agentId => {
        const mailbox = agentMailboxes.get(agentId)
        if (!mailbox) return undefined
        return { append: event => mailbox.append(event) }
      },
      newMessageId: seed => seed,
      now: () => clock.now,
    }
    rooms.set(spec.roomId, new TracingRoomActor({
      roomId: spec.roomId,
      host,
      store: createCollabRoomAccountMemoryStore(),
      mailbox: roomMailboxes.get(spec.roomId)!,
    }))
  }

  /* ── agent ──────────────────────────────────────────────────────────── */

  const specOf = (roomId: string): (typeof specs)[number] | undefined =>
    specs.find(spec => spec.roomId === roomId)

  const agents = agentIds.map(agentId => {
    const host: CollabAgentActorHost = {
      execSessionId: (id, roomId) => collabAgentSessionId(id, roomId),
      buildRoomContext: input => {
        const spec = specOf(input.roomId)
        if (!spec) return ''
        const messages = roomMessages.get(input.roomId) ?? []
        const window = planCollabHistoryWindow({
          messages,
          ...(input.seenMessageId ? { seenMessageId: input.seenMessageId } : {}),
          selfAgentId: input.agentId,
          now: input.now,
        })
        return buildCollabDriveRoomContext({
          messages,
          selfAgentId: input.agentId,
          agents: spec.members,
          roomId: input.roomId,
          roomName: spec.roomLabel,
          window,
          bootstrap: input.bootstrap,
        })
      },
      roomOutbox: roomId => {
        const mailbox = roomMailboxes.get(roomId)
        if (!mailbox) return undefined
        return {
          post: verb => mailbox.append(createActorEvent<CollabActorVerb>({
            id: nextEventId(agentId, verb),
            at: clock.now,
            type: verb.type,
            from: { kind: 'agent', id: agentId },
            to: { kind: 'room', id: roomId },
            payload: verb,
          })),
        }
      },
      members: roomId => specOf(roomId)?.members ?? [],
      dm: roomId => specOf(roomId)?.dm === true,
      roomLabel: roomId => specOf(roomId)?.roomLabel,
      speakerLabel: id => memberName.get(id),
      now: () => clock.now,
    }

    return new CollabAgentActor({
      agentId,
      host,
      mindPort,
      notebook,
      store: accountStore,
      mailbox: agentMailboxes.get(agentId)!,
      ...(options.foldLimits ? { foldLimits: options.foldLimits } : {}),
      ...(options.notebookBudget === undefined ? {} : { notebookBudget: options.notebookBudget }),
      onTurnFailure: failure => failures.push(failure),
    })
  })

  /* ── 跑 ─────────────────────────────────────────────────────────────── */

  for (const room of rooms.values()) room.start()
  for (const agent of agents) agent.start()

  const maxRounds = options.maxSettleRounds ?? 200
  const busy = (): boolean =>
    agents.some(agent => agent.inFlightRoomId !== null)
    || [...agentMailboxes.values(), ...roomMailboxes.values()].some(box => box.pendingCount() > 0)

  const quiesce = async (): Promise<void> => {
    for (let round = 0; round < maxRounds; round += 1) {
      for (const agent of agents) await agent.drain()
      for (const room of rooms.values()) await room.drain()
      if (!busy()) return
    }
    throw new Error('[collab-duet] 环没闭合:超过静默轮数上限,多半是有人在互相唤醒')
  }

  for (const injection of injections) {
    clock.now = injection.message.timestamp ?? clock.now
    // 入口写转录:真机那侧由 ingress 落库之后再投房间,房间自己不写用户消息
    // (`applyCollabRoomPosted` 只写 `extraMessages`)。少这一步,drive 的房间
    // 投影里会缺掉人类说的那句话。
    roomMessages.get(injection.roomId)?.push(injection.message as CollabRoomTranscriptMessage)
    const verb: CollabActorVerb = {
      type: 'room:posted',
      roomId: injection.roomId,
      author: injection.message.role === 'user'
        ? { kind: 'user', id: 'user' }
        : { kind: 'room', id: injection.roomId },
      message: injection.message,
    }
    await roomMailboxes.get(injection.roomId)?.append(createActorEvent<CollabActorVerb>({
      id: nextEventId('ingress', verb),
      at: clock.now,
      type: verb.type,
      from: verb.author,
      to: { kind: 'room', id: injection.roomId },
      payload: verb,
    }))
    await quiesce()
  }

  for (const agent of agents) await agent.stop()
  for (const room of rooms.values()) await room.stop()

  return {
    verbs,
    lines: verbs.map(formatCollabActorVerb),
    calls: mindPort.calls,
    messages: Object.fromEntries([...roomMessages].map(([roomId, list]) => [roomId, [...list]])),
    accounts: Object.fromEntries(agents.map(agent => [agent.agentId, agent.account])),
    notebooks: Object.fromEntries(agentIds.map(id => [id, notebook.read(id)])),
    failures,
  }
}
