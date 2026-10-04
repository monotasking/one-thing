// 协作运行时的四个宿主适配器(2026-10-04 从 `collab-actors-runtime.ts` 搬来,拆分批 3,D247):房间、agent、裁判
// 三个 actor 的宿主面,看板的写口与板事件的处理,以及它们共用的房间语境拼装。函数正文原样;从前直接调运行时文件里
// 读模块单例的那几只函数(投信、开 agent、开裁决窗、预算闸、收不收活),改成经 `CollabRuntimeHostOps` 调 ——
// 递进来的就是运行时文件里那几只函数本身,`runtime = state` 的缺省原样,所以每一次调用读到的实例与搬家前相同。
// 单例只住在运行时文件里;这只文件只从那里引类型,值图上是运行时 → 本文件单向。
import { randomUUID } from 'node:crypto'
import { type CollabAgentLike, type CollabMessageLike } from '../collab-types.js'
import { buildCollabDriveRoomContext, formatCollabAdoptedEcho, formatCollabUserLabel, wrapCollabMessageEnvelope } from '../collab-projection.js'
import { collectCollabFoldedFacts, planCollabHistoryWindow } from '../collab-history-window.js'
import { isCollabRoomFact } from '../collab-classify.js'
import { renderCollabBoardDigest } from '../collab-board.js'
import { isAgentPairDmRoom, isUserDmRoom } from '@onething/backend/session'
import { collabActorRef, collabAgentSpawnWorker, collabRoomCardEvent, collabRoomActiveLeases, createCollabHeuristicHandEvaluator, resolveCollabRoomFloorPolicy, type CollabActorVerb, type CollabCardEventKind, type CollabHandEvaluator, type CollabRaisedHand } from '@onething/backend/collab/actors'
import { type ChatMessage } from '@shared/ipc.js'
import { findAgent } from '@onething/backend/agent'
import { getEventBus } from '@onething/backend/event'
import * as store from '@onething/backend/session'
import { sessionCommands, sessionReads } from '@onething/backend/session'
import { advanceSeenCursor, ensureCollabAgentSession } from '../collab-agent-exec-session.js'
import { loadCollabBoard, patchCollabTask } from '../collab-board-store.js'
import { getCollabDigestsForDays } from '@onething/backend/collab/collab-digest-store'
import { buildCollabIdentityDirectory } from '../collab-identity-directory.js'
import { collabRoomMembers } from '../collab-members.js'
import { maxChainFor, maxConcurrentTurnsFor, postTaskSystemLine } from '../collab-room-runtime.js'
import { collabUserPromptFields, resolveUserIdentity } from '../collab-user-identity.js'
import { type CollabAgentActorHost, type CollabAgentRoomContextInput } from '@onething/backend/collab/actors/collab-agent-actor'
import { type CollabRefereeActorHost } from '@onething/backend/collab/actors/collab-referee-actor'
import { type CollabRoomActorHost } from '@onething/backend/collab/actors/collab-room-actor'
import { type CollabWorkerBoardPort } from '@onething/backend/collab/actors/collab-actors-worker-child'
import { SESSION_EVENT_TYPES } from '@shared/events/index.js'
import type { CollabRoomJudgmentRequest } from '@onething/backend/collab/actors'
import type { AgentEntry, BudgetCell, RuntimeState } from './collab-actors-runtime.js'

/**
 * 适配器向运行时要的八只函数。运行时把它们原样递进来(`collab-actors-runtime.ts` 的 `hostOps`):
 * 带 `runtime` 参数的几只,缺省仍是**调用那一刻**的模块单例。
 */
export interface CollabRuntimeHostOps {
  postToRoom(roomId: string, verb: CollabActorVerb, from: ReturnType<typeof collabActorRef>, runtime?: RuntimeState | null): Promise<void>
  postToAgent(agentId: string, verb: CollabActorVerb, from: ReturnType<typeof collabActorRef>, runtime?: RuntimeState | null): Promise<void>
  ensureAgent(agentId: string, runtime?: RuntimeState | null): Promise<AgentEntry | undefined>
  scheduleJudgment(request: CollabRoomJudgmentRequest): void
  roomOverBudget(roomId: string): boolean
  budgetCell(roomId: string): BudgetCell
  budgetLimitOf(roomId: string): number
  runtimeAccepting(runtime: RuntimeState): boolean
}

/** 裁判的房间尾巴取多少条(压缩窗在纯层再裁一次)。 */
const REFEREE_RECENT_LIMIT = 40

/** 用户时区的日历日(与 v2 `budgetDayKey` 同一套算法 —— 两处"今天"必须同一天)。 */
export function budgetDay(now: number): string {
  const date = new Date(now)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function roomMembersOf(roomId: string): CollabAgentLike[] {
  return collabRoomMembers(store.getSession(roomId)?.room?.memberAgentIds)
}

/** 这间房挂裁判吗:群房挂,私聊房不挂(与 v2 的「私聊免判」逐条对齐)。 */
function roomHasReferee(roomId: string): boolean {
  const room = store.getSession(roomId)?.room
  if (!room) return false
  if (isUserDmRoom(room) || isAgentPairDmRoom(room)) return false
  return (room.memberAgentIds ?? []).length >= 2
}

export function roomHost(runtime: RuntimeState, activatedRoomId: string, ops: CollabRuntimeHostOps): CollabRoomActorHost {
  const authorize = (roomId = activatedRoomId) => {
    const context = runtime.authorization.contextForRoom(activatedRoomId)
    runtime.authorization.assertSessions(context, [roomId])
  }
  return {
    members: roomId => { authorize(roomId); return roomMembersOf(roomId) },
    // 授权面(谁能被发牌)与识别面(哪串字符是一个真身份)分家 —— 用户与退休
    // 成员的句柄要认得出来,但他们不在名册里(collab-handle-codec.md §2.1)。
    directory: () => buildCollabIdentityDirectory(),
    frozen: roomId => { authorize(roomId); return store.getSession(roomId)?.room?.frozen === true },
    overBudget: ops.roomOverBudget,
    maxChain: roomId => {
      const session = store.getSession(roomId)
      return session ? maxChainFor(session) : 0
    },
    maxConcurrent: roomId => maxConcurrentTurnsFor(store.getSession(roomId)),
    pairDm: roomId => isAgentPairDmRoom(store.getSession(roomId)?.room),
    budget: roomId => ({ spentUSD: ops.budgetCell(roomId).spentUSD, limitUSD: ops.budgetLimitOf(roomId) }),
    referee: roomHasReferee,
    // 设置里的「响应模式三件套」→ 发言策略档。这一口只在装配与改设置时被问
    // (`syncFloorPolicy()`),不是每次决策现读 —— 理由见端口自己的注释。
    floorPolicy: roomId => resolveCollabRoomFloorPolicy(store.getSession(roomId)?.room),
    openJudgment: request => { authorize(request.roomId); ops.scheduleJudgment(request) },
    appendMessage: (roomId, message) => {
      authorize(roomId)
      const chat = message as ChatMessage
      sessionCommands.appendMessage(roomId, { message: chat, stampCollab: true })
      // 与 v2 say / ingress 共用同一条广播:房间 UI 与 SSE 镜像不必认新事件。
      void getEventBus().emit(roomId, {
        type: SESSION_EVENT_TYPES.MESSAGE_USER_CREATED,
        message: chat,
      } as Parameters<ReturnType<typeof getEventBus>['emit']>[1])
    },
    memberMailbox: agentId => ({
      append: async event => {
        authorize()
        const entry = await ops.ensureAgent(agentId)
        // 开不出信箱(人退休了 / 被删了)不算投递失败:房间那侧会把它当"这位
        // 此刻没有信箱"跳过,而不是让整条广播炸掉。
        if (!entry) return
        authorize()
        await entry.mailbox.append(event)
      },
    }),
    newMessageId: () => randomUUID(),
    now: () => Date.now(),
  }
}

export function agentHost(runtime: RuntimeState, ops: CollabRuntimeHostOps): CollabAgentActorHost {
  return {
    execSessionId: (agentId, roomId) => ensureCollabAgentSession(agentId, roomId, {
      executionContext: runtime.authorization.contextForRoom(roomId),
    }),
    buildRoomContext: input => {
      const context = runtime.authorization.contextForRoom(input.roomId)
      runtime.authorization.assertSessions(context, [input.roomId, input.execSessionId])
      return buildV3RoomContext(input)
    },
    roomOutbox: roomId => ({
      post: verb => ops.postToRoom(roomId, verb, collabActorRef('agent', collabVerbAgentId(verb))),
    }),
    members: roomId => { runtime.authorization.contextForRoom(roomId); return roomMembersOf(roomId) },
    dm: roomId => {
      runtime.authorization.contextForRoom(roomId)
      const room = store.getSession(roomId)?.room
      return isUserDmRoom(room) || isAgentPairDmRoom(room)
    },
    roomLabel: roomId => { runtime.authorization.contextForRoom(roomId); return store.getSession(roomId)?.name },
    speakerLabel: agentId => findAgent(agentId)?.name,
    projectedThrough: roomId => {
      runtime.authorization.contextForRoom(roomId)
      const messages = sessionReads.listMessages(roomId).messages
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]
        if (!isCollabRoomFact(message as CollabMessageLike)) continue
        return {
          ...(message.id ? { messageId: message.id } : {}),
          ...(typeof message.timestamp === 'number' ? { at: message.timestamp } : {}),
        }
      }
      return undefined
    },
    persistSeen: input => {
      const roomId = store.getSession(input.execSessionId)?.collab?.roomSessionId
      if (!roomId) return
      const context = runtime.authorization.contextForRoom(roomId)
      runtime.authorization.assertSessions(context, [roomId, input.execSessionId])
      advanceSeenCursor(input.execSessionId, input.messageId)
    },
    formatSteerBody: formatV3SteerBody,
    now: () => Date.now(),
  }
}

/**
 * 接线之后的举手判据(D6-a)。
 *
 * D2 的启发式只认两条直通(被 @ / 私聊里的人类消息),其余一律不举手 —— 那是
 * 「D2 没有意愿判定」时唯一安全的默认。**D3 之后不该再是它**:意愿判定的真身
 * 在裁判那一侧,而裁判「只在举手的人之间取舍,没有凭空点人的权力」。沿用 D2 的
 * 默认,结果是群里一条没被 @ 的消息谁都不举手 → 裁决窗里零候选 → 全员静默,
 * 而那正是 v2 用 N 次意愿判定解决的那个问题。
 *
 * 所以接线档是:**每一条房间事实都举手,取舍交给裁判**(qm P0-2 的 O(N)→O(1)
 * 就是这句话的全部内容)。举手不花钱 —— 它是一封信,不是一次调用。
 *
 * 剩下的取舍由三样按序兜住:裁判(挂了的房)、发言策略的 FIFO(没挂的房)、
 * 以及三道闸。没有一样依赖 agent 自己"懂事"。
 */
export function wiredHandEvaluator(): CollabHandEvaluator {
  const heuristic = createCollabHeuristicHandEvaluator()
  return {
    name: 'wired',
    async evaluate(input) {
      const base = await heuristic.evaluate(input)
      // 被 @ / 私聊直通:原样保留,连 `urgency: 'high'` 一起 —— 裁判排序读它。
      if (base.raise) return base
      // 自己说的话、运营行、drive、thinking 都不是举手时机(判据与 D2 逐条一致)。
      if (input.author.kind === 'agent' && input.author.id === input.agentId) return base
      if (!isCollabRoomFact(input.message)) return base
      return { raise: true, reason: 'self-elected', why: '有话要说' }
    },
  }
}

/** 一条 agent → room 的动词是谁发的。投信的 `from` 要它。 */
function collabVerbAgentId(verb: CollabActorVerb): string {
  return 'agentId' in verb && typeof verb.agentId === 'string' ? verb.agentId : ''
}

/**
 * 中途来消息的注入信封 —— 与房间投影**同源**(v2 `steer.ts` 的第一处收窄)。
 *
 * 同一条消息在注入与投影两条路上必须长得一样,否则模型会把它读成两个人说的话。
 */
function formatV3SteerBody(message: CollabMessageLike): string {
  const text = (message.content ?? '').trim()
  if (!text) return ''
  if (message.agentId) {
    const label = findAgent(message.agentId)?.name ?? message.agentId
    return wrapCollabMessageEnvelope(label, text, message.timestamp)
  }
  const identity = resolveUserIdentity()
  return wrapCollabMessageEnvelope(
    formatCollabUserLabel(identity.label, identity.handle),
    text,
    message.timestamp,
  )
}

/**
 * 这条 drive 要带的房间内容。
 *
 * 与 v2 `buildDriveRoomContext` 逐格同参(投影、窗口、摘要、用户身份),多一件事:
 * **上一轮的代发回声**。回声接在房间内容之后而不是混进去 —— 它说的不是"房里发生
 * 了什么",而是"你上一轮那段话的下落"(架构审查 A6)。
 */
function buildV3RoomContext(input: CollabAgentRoomContextInput): string {
  const room = store.getSession(input.roomId)
  if (room?.kind !== 'room') return ''
  const messages = sessionReads.listMessages(input.roomId).messages
  const window = planCollabHistoryWindow({
    messages,
    ...(input.seenMessageId ? { seenMessageId: input.seenMessageId } : {}),
    selfAgentId: input.agentId,
    now: input.now,
    ...(room.room?.context ?? {}),
  })
  const roomContext = buildCollabDriveRoomContext({
    messages,
    selfAgentId: input.agentId,
    agents: roomMembersOf(input.roomId),
    resolveAgentName: id => findAgent(id)?.name,
    ...collabUserPromptFields(),
    window,
    bootstrap: input.bootstrap,
    ...(window.cut !== undefined
      ? { digests: getCollabDigestsForDays(input.roomId, foldedDaysOfWindow(messages, window)) }
      : {}),
  })

  const echo = takeCollabV3AdoptedEcho(input.execSessionId)
  if (!echo) return roomContext
  return [roomContext, formatCollabAdoptedEcho(echo)].filter(Boolean).join('\n\n')
}

/** 折叠段覆盖到的那几天 —— 首轮铺底按它取摘要(与 v2 同一份算法)。 */
function foldedDaysOfWindow(
  messages: readonly ChatMessage[],
  window: { folded: ReadonlySet<number> },
): string[] {
  const days = new Set<string>()
  for (const message of collectCollabFoldedFacts(messages, window)) {
    days.add(budgetDay(message.timestamp ?? 0))
  }
  return [...days].sort()
}

/**
 * 代发回声读一次就清。
 *
 * 走动态 import 是为了不在模块图上加一条 `runtime → agent-session` 之外的边:
 * 那条边已经有了(`ensureCollabAgentSession`),所以这里直接静态引也可以 ——
 * 保持静态,少一层。
 */
function takeCollabV3AdoptedEcho(
  execSessionId: string,
): { messageId: string; at?: number } | undefined {
  const session = store.getSession(execSessionId)
  const collab = session?.collab
  const messageId = collab?.adoptedEchoMessageId
  if (!collab || !messageId) return undefined
  const at = collab.adoptedEchoAt
  const next = { ...collab }
  delete next.adoptedEchoMessageId
  delete next.adoptedEchoAt
  store.updateSessionCollab(execSessionId, { collab: next })
  return { messageId, ...(typeof at === 'number' ? { at } : {}) }
}

export function refereeHost(getRuntime: () => RuntimeState, ops: CollabRuntimeHostOps): CollabRefereeActorHost {
  const authorize = (roomId: string) => getRuntime().authorization.contextForRoom(roomId)
  return {
    candidates: (roomId): readonly CollabRaisedHand[] => {
      authorize(roomId)
      return getRuntime().rooms.get(roomId)?.actor.account.hands ?? []
    },
    members: roomId => { authorize(roomId); return roomMembersOf(roomId) },
    recent: roomId => {
      authorize(roomId)
      const messages = sessionReads.listMessages(roomId).messages as readonly CollabMessageLike[]
      return messages.filter(isCollabRoomFact).slice(-REFEREE_RECENT_LIMIT)
    },
    roomLabel: roomId => store.getSession(roomId)?.name,
    userLabel: () => collabUserPromptFields().userLabel,
    persona: agentId => findAgent(agentId)?.systemPrompt,
    agentName: agentId => findAgent(agentId)?.name,
    constraints: roomId => {
      authorize(roomId)
      const account = getRuntime().rooms.get(roomId)?.actor.account
      if (!account) return []
      const session = store.getSession(roomId)
      const maxChain = session ? maxChainFor(session) : 0
      const maxConcurrent = maxConcurrentTurnsFor(session)
      const lines: string[] = []
      if (Number.isFinite(maxChain) && maxChain > 0) {
        lines.push(`链闸:已连说 ${account.chainCount} 轮,上限 ${maxChain}`)
      }
      if (Number.isFinite(maxConcurrent) && maxConcurrent > 0) {
        const seats = maxConcurrent - collabRoomActiveLeases(account, Date.now()).length
        lines.push(`座位:还剩 ${Math.max(0, seats)} 个`)
      }
      return lines
    },
    mentioned: roomId => {
      authorize(roomId)
      const account = getRuntime().rooms.get(roomId)?.actor.account
      const sourceMessageId = account?.judgment?.sourceMessageId
      if (!sourceMessageId) return []
      const source = sessionReads.getMessage(roomId, sourceMessageId)
      return (source?.mentions ?? [])
        .map(mention => mention.agentId)
        .filter((agentId): agentId is string => typeof agentId === 'string')
    },
    roomOutbox: roomId => ({
      post: verb => ops.postToRoom(roomId, verb, collabActorRef('referee', 'referee')),
    }),
    now: () => Date.now(),
  }
}

/**
 * 卡的写口(D4 的 `CollabWorkerBoardPort` 生产实现)。
 *
 * 只走 `patchCollabTask` —— 那是**协调器内部**的写口,不会再触发一次语义板事件。
 * 用 `applyBoardAction` 的话,"开工写 doing"会再发一次 `task-started`,而那正是
 * 触发开工的那个事件:一只手会派出第二只手。
 */
export function boardPort(runtime: RuntimeState): CollabWorkerBoardPort {
  const authorize = (input: { roomId: string; workSessionId?: string }) => {
    const context = runtime.authorization.contextForRoom(input.roomId)
    runtime.authorization.assertSessions(context, [input.roomId, ...(input.workSessionId ? [input.workSessionId] : [])])
  }
  return {
    started: async input => {
      authorize(input)
      const task = loadCollabBoard(input.roomId).tasks.find(entry => entry.id === input.cardId)
      if (!task) return
      const resuming = input.workSessionId
        ? task.workSessionIds.includes(input.workSessionId)
        : true
      await patchCollabTask(input.roomId, input.cardId, {
        status: 'doing',
        ...(resuming || !input.workSessionId
          ? {}
          : { workSessionIds: [...task.workSessionIds, input.workSessionId] }),
      })
    },
    settled: async input => {
      authorize(input)
      // 终局 → 卡的去处。交付进评审(人/PM 验收),受阻留 blocked,其余一律推回
      // todo —— 一段没跑完的执行不该把卡留在"在做"上,那是看板与进程说的不是
      // 同一件事的开始。
      const status = input.outcome === 'complete'
        ? 'review'
        : input.outcome === 'blocked' ? 'blocked' : 'todo'
      await patchCollabTask(input.roomId, input.cardId, {
        status,
        ...(input.summary ? { report: { summary: input.summary } } : {}),
      })
    },
    interrupted: async input => {
      authorize(input)
      await patchCollabTask(input.roomId, input.cardId, { status: 'todo' })
    },
    digest: input => {
      authorize(input)
      return renderCollabBoardDigest(loadCollabBoard(input.roomId),
        agentId => findAgent(agentId)?.name ?? agentId, { agentId: input.agentId })
    },
  }
}

/** 板事件 → v3。开工派手,其余进房间当卡的动静。 */
export async function handleBoardEvent(
  runtime: RuntimeState,
  roomSessionId: string,
  event: { type: string; task: { id: string; title: string; description?: string; assigneeAgentId?: string; workSessionIds: string[] } },
  ops: CollabRuntimeHostOps,
): Promise<void> {
  if (!ops.runtimeAccepting(runtime)) return
  const task = event.task
  const assignee = task.assigneeAgentId

  if (event.type === 'task-started' && assignee) {
    // 续做接着原来那条工作会话往下做:现场就在那条会话里,重开一条等于把它扔掉。
    const previous = task.workSessionIds[task.workSessionIds.length - 1]
    await ops.postToAgent(assignee, collabAgentSpawnWorker({
      agentId: assignee,
      workerId: randomUUID(),
      cardId: task.id,
      roomId: roomSessionId,
      title: task.title,
      ...(task.description ? { description: task.description } : {}),
      ...(previous ? { workSessionId: previous } : {}),
    }), collabActorRef('room', roomSessionId), runtime)
  }

  const kind = boardEventKind(event.type)
  if (!kind || !ops.runtimeAccepting(runtime)) return
  if (event.type === 'task-assigned' && assignee) {
    postTaskSystemLine(roomSessionId, `「${task.title}」→ ${findAgent(assignee)?.name ?? assignee}`)
  }
  await ops.postToRoom(roomSessionId, collabRoomCardEvent({
    roomId: roomSessionId,
    cardId: task.id,
    event: kind,
    ...(assignee ? { assigneeId: assignee } : {}),
    title: task.title,
  }), collabActorRef('room', roomSessionId), runtime)
}

function boardEventKind(type: string): CollabCardEventKind | undefined {
  switch (type) {
    case 'task-assigned':
    case 'task-requeued':
      return 'assigned'
    case 'task-started':
      return 'started'
    case 'task-completed':
      return 'delivered'
    case 'task-blocked':
      return 'blocked'
    case 'task-done':
      return 'closed'
    default:
      // `task-rejected` / `task-halted` 没有对应的卡事件档 —— 它们是**评审动作**,
      // 会以一条 assigned / blocked 紧随其后落地,折叠信封里说一次就够。
      return undefined
  }
}
