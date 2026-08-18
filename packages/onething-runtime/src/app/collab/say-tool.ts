/**
 * App wiring of the `say` tool (W14b 说话即行动,
 * docs/design/multi-agent-collab-im.md §4.5).
 *
 * This is where an utterance becomes a room message. Everything that decides
 * whether the words land is collected HERE, on purpose:
 *
 *  - **which room** — a room session speaks into itself; a work session speaks
 *    into the room that spawned it (the worker's real "说一句" channel, §4.5).
 *  - **the gates** — frozen / over-budget / no longer a member. Before W14b the
 *    gates killed an activation before the agent ever ran, so nobody was there
 *    to be told; now the agent is holding the phone when the call fails and it
 *    gets told in words. That is the first genuine 送达失败 the room has.
 *  - **identity** — mentions are whitelisted against the roster and re-labelled
 *    from it (W14a 防冒名), replyTo is resolved to a snapshot of a message that
 *    actually exists (a fabricated id is ignored, never fabricated back).
 *  - **idempotence** — the same utterance twice inside one turn is ONE room
 *    message (todo2 P0-2, see below).
 *
 * The message is persisted with `source: COLLAB_SAY_SOURCE` and broadcast on
 * the same `message:user-created` channel the coordinator's own posts use, so
 * the room UI and the SSE mirror need no new event.
 */
import { randomUUID } from 'node:crypto'
import {
  COLLAB_DM_LEGACY_TOOL_NAME,
  COLLAB_SAY_REFUSED_BUDGET,
  COLLAB_SAY_REFUSED_EMPTY,
  COLLAB_SAY_REFUSED_FROZEN,
  COLLAB_SAY_REFUSED_NOT_MEMBER,
  COLLAB_SAY_REFUSED_NO_ROOM,
  COLLAB_SAY_REFUSED_UNKNOWN_ROOM,
  COLLAB_SAY_SOURCE,
  COLLAB_SEND_MESSAGE_LEGACY_TOOL_NAME,
  COLLAB_SEND_MESSAGE_TOOL_NAME,
  buildCollabReplyToSnapshot,
  normalizeCollabSayContent,
  resolveCollabSayMentions,
  resolveCollabSayRoomSessionId,
  stripCollabAgentHandles,
  type CollabAgentLike,
} from '@onething/runtime/collab'
import { createSayTool, type SayToolResult } from '@onething/runtime/tools'
import { registerRetiredAgentToolName } from '@onething/core'
import { type ChatMessage } from '@shared/ipc.js'
import * as store from '../store.js'
import { getEventBus } from '../events/index.js'
import { findAgent } from '../agents/index.js'
import { collabRoomMembers } from './members.js'
import { isRoomOverBudget } from './budget.js'
import { buildCollabIdentityDirectory } from './identity-directory.js'
import { resolveUserIdentity } from './user-identity.js'
import { collabLinkedRoomSessionId } from './venue.js'
import {
  collabV3RoomPostPort,
  resolveCollabV3SpeakRoute,
  type CollabV3SpeakPort,
} from './actors/turn-context.js'

import { SESSION_EVENT_TYPES } from '@shared/events/index.js'

interface SayContext {
  roomSessionId: string
  agentId: string
}

/**
 * Where does this utterance go? (W18 §4.6「say(room)」)
 *
 * Three sources in a fixed order, spelled out in the pure rule
 * (`resolveCollabSayRoomSessionId`):
 *  1. the `room` argument — an explicit aim is never second-guessed;
 *  2. the room the session is bound to — the drive's target room on an AGENT
 *     EXECUTION session (the everyday W18 path), or the parent room on a WORK
 *     session (the worker's channel into the group);
 *  3. the session itself when it IS a room (pre-W18 in-room turns).
 *
 * Only the room lookup happens here; membership and the gates are enforced
 * below against whichever room this returns, so an explicit `room` buys no
 * privilege — an agent that is not a member of it is refused exactly like one
 * that was just shown the door.
 *
 * 第 2 条那句「哪些 kind 挂着一间房」走统一的场子判定(C3-6,`venue.ts`),不再
 * 在这里手写 —— 同一句 if 此前在四个工具里各有一份,而漏掉一份不会报错,只会
 * 多放一个人进来。第 1、3 条不经过门,与改造前逐字一致:显式 `room` 仍然优先
 * (下面那几道成员/冻结/预算门才是真正的授权面),`room` 场子的房仍然是它自己。
 */
function resolveSayContext(sessionId: string, requestedRoom?: string): SayContext | null {
  const session = store.getSession(sessionId)
  if (!session || !session.agentId) return null
  const linkedRoomSessionId = collabLinkedRoomSessionId(session)
  const roomSessionId = resolveCollabSayRoomSessionId({
    kind: session.kind,
    sessionId: session.id,
    ...(requestedRoom ? { requestedRoomSessionId: requestedRoom } : {}),
    ...(linkedRoomSessionId ? { linkedRoomSessionId } : {}),
  })
  if (!roomSessionId) return null
  return { roomSessionId, agentId: session.agentId }
}

/**
 * Typing is NOT this executor's business (W19).
 *
 * W13.1 used to bracket a work-session utterance with typing(true/false) here,
 * because a worker had no activation queue holding the indicator for it. Both
 * halves of that arrangement are gone: the queue no longer simulates typing at
 * all, and the real signal is the `say` call's arguments streaming — which is
 * over by the time this function runs. Both room turns and work turns now get
 * their indicator from `observeCollabSayTyping`, so a bracket here would only
 * add a zero-width flicker after the light already went out.
 */

/**
 * say 里的 @ 能落在谁身上:退休的成员不算(域模型 §3.2)。
 *
 * 不带 `description`:这一面只做**匹配**(把 `@名字#句柄` 解析成 mentions),
 * 职责说明进不了任何判据。
 */
function roomMembers(roomSessionId: string): CollabAgentLike[] {
  return collabRoomMembers(store.getSession(roomSessionId)?.room?.memberAgentIds)
}

function authorLabelOf(message: ChatMessage): string {
  // 快照语义(agent-dm-user.md §2.3):落库的是**此刻**的称呼,改名不追改旧引用。
  if (message.role === 'user') return resolveUserIdentity().label
  if (!message.agentId) return ''
  const agent = findAgent(message.agentId)
  return agent ? agent.name : message.agentId
}

/**
 * Resolve an explicit `replyTo` id into the snapshot shape the room stores.
 * A quote is a COPY (W7), so the words survive edits and pagination. An id
 * that names nothing is silently dropped: the utterance itself is still worth
 * delivering, and refusing it over a bad quote id would cost the room a message.
 */
function buildReplyToSnapshot(
  roomSessionId: string,
  replyToMessageId: string | undefined,
): ChatMessage['replyTo'] | undefined {
  if (!replyToMessageId) return undefined
  const messages = (store.getSession(roomSessionId)?.messages ?? []) as ChatMessage[]
  const target = messages.find(message => message.id === replyToMessageId)
  if (!target) return undefined
  return buildCollabReplyToSnapshot({
    messageId: target.id,
    authorLabel: authorLabelOf(target),
    content: target.content,
  }) ?? undefined
}

/**
 * 同一句话只进群一次 (todo2 P0-2, 2026-07-30).
 *
 * 真机形状:一个回合里群里出现两条一字不差的消息。此前 say 是无条件写入——每次
 * 调用 randomUUID() 新建一条,唯一的护栏是 doom-loop 检测(阈值 4),重复两次
 * 完全落在护栏之下。诱因不止一个(被强制首调 say 之后又"正式作答"一遍、provider
 * 重放、当年的 W14d nudge 误触发再驱一轮——前者与后者均已拆除),所以这里不猜
 * 诱因,而是把"同一句话只落一条"变成结构保证。
 *
 * 指纹 = (目标房间, 发言 agent, 归一化正文, 已解析的 mentions, replyTo)。
 * mentions/replyTo 不同就是不同的消息:同样一句「好」回给两个人是两次真实发言。
 * 命中时不落库、不发事件,直接返回上一次的 messageId ——**成功语义**,因为那句话
 * 确实在群里;返回同一个 id 还让后续 replyTo 能正确引用它。
 *
 * 5 秒时间窗而不是永久缓存:群聊里"过一会儿再说一遍同样的话"是合法的(催一下、
 * 重复结论),而同一回合内的重复几乎都发生在毫秒到秒级。每次查询顺手清掉过期
 * 条目,Map 因此不随进程寿命增长。
 */
const SAY_IDEMPOTENCE_WINDOW_MS = 5_000

const recentSays = new Map<string, { messageId: string; at: number }>()

function sayFingerprint(input: {
  roomSessionId: string
  agentId: string
  content: string
  mentionAgentIds: readonly string[]
  replyToMessageId?: string
}): string {
  // JSON rather than a delimiter join: one of the parts is free-form prose, and
  // any separator prose could also contain would let two different tuples
  // collide into one fingerprint — i.e. silently eat a real second message.
  return JSON.stringify([
    input.roomSessionId,
    input.agentId,
    input.content,
    input.mentionAgentIds,
    input.replyToMessageId ?? '',
  ])
}

/** Drop expired entries, then answer "was this exact utterance just delivered?" */
function lookupRecentSay(fingerprint: string, now: number): string | undefined {
  for (const [key, entry] of recentSays) {
    if (now - entry.at >= SAY_IDEMPOTENCE_WINDOW_MS) recentSays.delete(key)
  }
  return recentSays.get(fingerprint)?.messageId
}

/** Forget the window (test setup / teardown). It is otherwise invisible, which
 *  is exactly how a cache like this grows a second personality. */
export function clearCollabSayIdempotence(): void {
  recentSays.clear()
}

/**
 * The executor. Ordering is the contract: content first (an empty call is a
 * mistake, not a delivery failure), then the gates that mean "your words did
 * not reach anyone", then the duplicate check, then the write.
 */
export async function speakIntoCollabRoom(input: {
  sessionId: string
  content: string
  mentions?: string[]
  replyTo?: string
  room?: string
  /**
   * 这条消息是**外部注入**,落库即把目标房的链长清零(架构审查 A2)。
   *
   * 只有跨房的两条路会传 true(`send_message` 带 `to` 的私聊注入、wake poke):
   * 它们的由头来自另一间房的一个回合,对目标房而言是新的外部输入。标记落在
   * 消息上而不是只改内存计数,是为了让 boot 重算认得出同一个清零边界 ——
   * 没有它,无人类在场的 pair 房重启一次就顶格冻死。房内的普通发言不传。
   */
  chainReset?: boolean
}): Promise<SayToolResult> {
  const context = resolveSayContext(input.sessionId, input.room)
  if (!context) return { ok: false, error: COLLAB_SAY_REFUSED_NO_ROOM }

  const content = normalizeCollabSayContent(input.content)
  if (!content) return { ok: false, error: COLLAB_SAY_REFUSED_EMPTY }

  /**
   * v3 的租约面(D6-a §3「speak 的工具面形态就是 send_message」)。
   *
   * 只在**这一轮在答的那间房**里生效(路由判据见 `resolveCollabV3SpeakRoute`)。
   * 走这条路时,下面那四道门(冻结 / 成员 / 预算 / 空正文)、防冒名的 mention
   * 白名单、句柄出栈全部由 RoomActor 的 `applyCollabRoomSpeak` 执行 —— 一字不改
   * 地搬过去的正是**同一份**纯规则(C1/C2 的措辞资产因此没有第二份)。
   *
   * 留在这一层的只有两件房间管不着的事:**幂等窗**(它是"同一次调用重复到达"
   * 的窗口,不是房间的账)与**引用快照**(要查被引的那条消息还在不在,而房间
   * 那侧的纯规则不认识 store —— 快照由 v3 发言口补写)。
   */
  const v3 = resolveCollabV3SpeakRoute({
    sessionId: input.sessionId,
    roomSessionId: context.roomSessionId,
    agentId: context.agentId,
  })
  if (v3) return speakThroughCollabLease(v3, context, input, content)

  const room = store.getSession(context.roomSessionId)
  if (room?.kind !== 'room' || !room.room) {
    // An explicit `room` that names nothing is a different mistake from having
    // no room at all, and the agent can act on the difference.
    return { ok: false, error: input.room ? COLLAB_SAY_REFUSED_UNKNOWN_ROOM : COLLAB_SAY_REFUSED_NO_ROOM }
  }
  if (room.room.frozen) return { ok: false, error: COLLAB_SAY_REFUSED_FROZEN }
  // Removed mid-turn (W6 / §3.5 C): the roster is read fresh here, exactly
  // like the drive-time guard, so a member that was just shown the door cannot
  // finish its sentence into the room.
  if (!(room.room.memberAgentIds ?? []).includes(context.agentId)) {
    return { ok: false, error: COLLAB_SAY_REFUSED_NOT_MEMBER }
  }
  if (await isRoomOverBudget(context.roomSessionId)) {
    return { ok: false, error: COLLAB_SAY_REFUSED_BUDGET }
  }

  // 授权面(谁能被点名激活)与识别面(哪串字符是真身份)从这里开始**分家** ——
  // 两者此前共用 `members` 一个数组,于是收紧前者顺手收窄了后者,用户/退休成员
  // 的句柄因此"发了不认"(collab-handle-codec.md §2.1)。
  const members = roomMembers(context.roomSessionId)
  const directory = buildCollabIdentityDirectory()
  const mentions = resolveCollabSayMentions({
    content,
    mentionAgentIds: input.mentions,
    members,
    directory,
  })
  /**
   * 句柄出栈(collab-agent-handle.md §2.4):模型写的 `@小李#3f9c1e2a` 在这里
   * 还原成 `@小李`。身份已经进了 mentions[],正文不必再背着它 —— 群里、UI 里、
   * 别人的投影里看到的是一句干净的话,而句柄会在下一次投影时按 id 重新拼出来。
   *
   * **必须在指纹之前**:指纹拿 content 当组成部分,同一句话用两种写法
   * (`@小李` 与 `@小李#3f9c1e2a`)必须算作同一条,否则幂等窗形同虚设。
   */
  const spoken = stripCollabAgentHandles(content, directory)
  const replyTo = buildReplyToSnapshot(context.roomSessionId, input.replyTo)

  // After the gates, before the write: the fingerprint is built from the SETTLED
  // shape (stripped content, resolved mentions, resolved quote), so two calls
  // that differ only in a mention id that resolved to nothing — or only in
  // whether the handle was spelled out — are correctly one utterance.
  const fingerprint = sayFingerprint({
    roomSessionId: context.roomSessionId,
    agentId: context.agentId,
    content: spoken,
    mentionAgentIds: mentions.map(mention => mention.agentId),
    ...(replyTo?.messageId ? { replyToMessageId: replyTo.messageId } : {}),
  })
  const now = Date.now()
  const alreadySaid = lookupRecentSay(fingerprint, now)
  if (alreadySaid) {
    // Nothing persisted, nothing broadcast — and the caller is told it worked,
    // because it did: those words are in the room, under this id.
    return { ok: true, messageId: alreadySaid }
  }

  const message: ChatMessage = {
    id: randomUUID(),
    role: 'assistant',
    agentId: context.agentId,
    content: spoken,
    timestamp: now,
    source: COLLAB_SAY_SOURCE,
    // An EMPTY mentions array is a real answer ("mentions nobody"), so the key
    // is omitted rather than stored empty — that is what keeps the name-scan
    // fallback available for old transcripts (W14a).
    ...(mentions.length > 0 ? { mentions } : {}),
    ...(replyTo ? { replyTo } : {}),
    // 只写 true,不写 false:缺席就是"普通消息",与旧转录同形(marker 是规则,
    // 不是迁移)。
    ...(input.chainReset ? { collabChainReset: true } : {}),
  }
  recentSays.set(fingerprint, { messageId: message.id, at: now })
  store.addMessage(context.roomSessionId, message)
  void getEventBus().emit(context.roomSessionId, {
    type: SESSION_EVENT_TYPES.MESSAGE_USER_CREATED,
    message,
  } as Parameters<ReturnType<typeof getEventBus>['emit']>[1])
  /**
   * 跨房落库之后**告诉那间房一声**(D6-a)。
   *
   * 走到这里的都是牌管不着的发言:私聊注入、工作台往母房汇报、旧形状的房内回合。
   * 它们此前靠各自的调用方去 `enqueue` 一次激活;v3 里"送达即激活"是房间自己的
   * 事 —— 一条 posted 进去,推水位、清链(消息自带 `collabChainReset`)、按 @
   * 发牌全部照常。端口没装上(v3 未起)时这一行是空操作。
   */
  const post = collabV3RoomPostPort()
  if (post) await post(context.roomSessionId, message)

  return { ok: true, messageId: message.id }
}

/**
 * v3 回合里的一句话:经**租约**发进房间。
 *
 * 拒绝文案原样透传 —— 它来自与 v2 逐字相同的那几个常量(纯层
 * `applyCollabRoomSpeak` 复用的就是 `COLLAB_SAY_REFUSED_*`),外加两条 v3 才有的
 * 验票拒绝("这张牌不是你的" / "牌已作废")。模型读到的仍是一句能照做的话。
 */
async function speakThroughCollabLease(
  route: { speak: CollabV3SpeakPort; leaseId: string },
  context: SayContext,
  input: { mentions?: string[]; replyTo?: string; chainReset?: boolean },
  content: string,
): Promise<SayToolResult> {
  // 幂等窗的指纹建在**归一化后的正文**上:同一句话用 `@小李` 与 `@小李#3f9c1e2a`
  // 两种写法写出来必须算作同一条,否则窗形同虚设(与 v2 同一条论证)。
  const spoken = stripCollabAgentHandles(content, buildCollabIdentityDirectory())
  const fingerprint = sayFingerprint({
    roomSessionId: context.roomSessionId,
    agentId: context.agentId,
    content: spoken,
    mentionAgentIds: input.mentions ?? [],
    ...(input.replyTo ? { replyToMessageId: input.replyTo } : {}),
  })
  const now = Date.now()
  const alreadySaid = lookupRecentSay(fingerprint, now)
  // 什么都不落、什么都不播,而调用方被告知成功 —— 因为它确实成功了:那句话在
  // 群里,就在这个 id 下面。
  if (alreadySaid) return { ok: true, messageId: alreadySaid }

  const delivered = await route.speak({
    agentId: context.agentId,
    roomSessionId: context.roomSessionId,
    leaseId: route.leaseId,
    // **原文**过去(不是 stripped):句柄要留给房间去解析 mentions,出栈在那之后。
    content,
    ...(input.mentions?.length ? { mentions: input.mentions } : {}),
    ...(input.replyTo ? { replyToMessageId: input.replyTo } : {}),
    ...(input.chainReset ? { chainReset: true } : {}),
  })
  if (!delivered.ok || !delivered.messageId) {
    return { ok: false, error: delivered.error ?? COLLAB_SAY_REFUSED_NO_ROOM }
  }
  recentSays.set(fingerprint, { messageId: delivered.messageId, at: now })
  return { ok: true, messageId: delivered.messageId }
}

/**
 * 合并后的发送面(collab-send-channel-and-wake.md §2.2)。
 *
 * 两个执行器保持为两个函数不变(各自的门与拒绝文案是资产),合并只发生在工具
 * 层:统一入口按 channel 分发。
 *
 * `sendDm` 走**动态 import**:模块图上 `dm-tool → say-tool` 这条边早就存在
 * (私聊落库就是 say 的执行器),反向再加一条静态边就是一个环。动态 import 只
 * 在真的发私聊时解析一次(之后走模块缓存),而环带来的初始化顺序问题是那种
 * 只在打包形态下才现身的 bug。
 */
export const SayTool = createSayTool({
  speak: speakIntoCollabRoom,
  async sendDm(input) {
    const { sendCollabDm } = await import('./dm-tool.js')
    return sendCollabDm({
      sessionId: input.sessionId,
      to: input.to,
      message: input.content,
      ...(input.wake ? { wake: true } : {}),
      ...(input.wakeRoom ? { wakeRoom: input.wakeRoom } : {}),
    })
  },
})

/**
 * 旧名 `say` / `dm` 的**静默别名**(collab-turn-protocol-and-identity.md A.3 +
 * collab-send-channel-and-wake.md §5 R1)。
 *
 * 灰度用途,不是长期特性:执行会话的历史里全是旧名的调用范例,模型会照着模仿,
 * 而一次「Tool not available」丢的是一条本该送达的消息。别名只在派发时生效
 * (core runner 的 toolMap miss → 退役名表),**不进** COLLAB_ROOM_TOOLS、不进
 * 请求的 tools 参数、不进任何提示词 —— 模型看不见它。
 *
 * 两个旧名的**兑现质量不同**,这一点是刻意的:
 *  - `say` 与现名参数同形 → 无缝转发,模型察觉不到;
 *  - `dm` 参数不同形(`message` vs `content`)→ 一次**刻意接受的降级**:`to` 活
 *    着进来、`message` 被 zod strip 掉,校验层逐字回一句 `COLLAB_SAY_REFUSED_EMPTY`
 *    (`tools/builtin/say.ts` 的 formatValidationError)。代价是一轮重试,消息
 *    不丢。这比"名字级转发让 `message` 被静默吞掉"好 —— 静默失效正是 edit
 *    replaceAll 那次事故的形状。
 *
 * 拆除条件(两者相同):改名前的会话历史都被摘要压掉、或危险区清空拿到干净基线
 * 之后。
 *
 * 注册放在 `registerBuiltinTools()` 里而不是模块顶层:导入 `@onething/app` 的
 * 任何模块都不得产生配置副作用(import-side-effect-free.test.ts)。
 */
export function registerCollabSendMessageLegacyAlias(): void {
  registerRetiredAgentToolName(
    COLLAB_SEND_MESSAGE_LEGACY_TOOL_NAME,
    COLLAB_SEND_MESSAGE_TOOL_NAME,
  )
  registerRetiredAgentToolName(
    COLLAB_DM_LEGACY_TOOL_NAME,
    COLLAB_SEND_MESSAGE_TOOL_NAME,
  )
}
