/**
 * App wiring of the agent execution session (W18,
 * docs/design/multi-agent-collab-im.md §4.6 v5).
 *
 * One durable session per agent — `agent-exec-<agentId>` — where all of its
 * room turns run. The room keeps only messages; drives, thinking and tool calls
 * live here.
 *
 * Hidden the way the scheduler hides its run sessions: `isArchived`. That flag
 * already keeps a session out of every list the sidebar builds, and the
 * renderer additionally drops `kind === 'agent'` from both the active list and
 * the archive (an execution session is not something a user archives — it is
 * infrastructure with a lifetime of its own).
 *
 * The room this session currently answers rides on `collab.roomSessionId`, the
 * same field a work session uses to name its parent room. Two consumers read
 * it, and both need it to be persisted rather than held in memory:
 *  - the prompt builder, to take its persona/roster/projection material from
 *    the TARGET room instead of the session being driven;
 *  - the `say` executor, to know where an utterance lands when the tool call
 *    carries no explicit `room`.
 */
import {
  collabAgentSessionId,
  collabAgentSessionName,
} from '@onething/runtime/collab'
import * as store from '../store.js'
import { sessionReads } from '../session/reads.js'
import { findAgent } from '../agents/index.js'
import { ensureCollabRoomFolder } from './room-folder.js'

/**
 * Get (or lazily create) an agent's execution session and point it at the room
 * whose drive it is about to answer.
 *
 * Idempotent by construction: the id is derived from the agent id, so "ensure"
 * is a read plus at most one create. Called on every drive — the room pointer
 * is what changes, and it is written only when it actually moved (a session
 * write per turn would churn the index for nothing).
 *
 * Returns the session id, or null when the agent does not exist.
 */
export function ensureCollabAgentSession(
  agentId: string,
  roomSessionId?: string,
): string | null {
  const sessionId = collabAgentSessionId(agentId, roomSessionId)
  if (!sessionId) return null
  const agent = findAgent(agentId)
  if (!agent) return null

  const existing = store.getSession(sessionId)
  if (!existing) {
    // 幕后建的会话不该抢走用户正在看的标签页 —— 指针纪律收在 store 那一侧
    // (`createSessionWithoutFocus`),这里只是"我不要焦点"这一句声明。
    store.createSessionWithoutFocus(sessionId, collabAgentSessionName(agent.name))
    store.updateSessionArchived(sessionId, true, Date.now())
  }

  const session = store.getSession(sessionId)
  if (!session) return null

  // collab-team-v2 §1.1:指针在创建时写一次,之后永不改写。
  //
  // 会话 id 里已经带了房间,所以归属是 id 本身的属性,`collab.roomSessionId`
  // 退化成一个恒定的归属标记 —— 它的所有读者(say 落点、board 归属、系统提示词、
  // 权限策略、投影)一行都不用改,而"后到的 drive 把指针改到别的房间"这一类
  // 事故在结构上消失了。写入条件因此只剩"还没写过"。
  if (session.kind !== 'agent' || (roomSessionId && !session.collab?.roomSessionId)) {
    store.updateSessionCollab(sessionId, {
      kind: 'agent',
      ...(roomSessionId ? { collab: { roomSessionId } } : {}),
    })
  }
  if (session.agentId !== agentId) store.updateSessionAgent(sessionId, agentId)

  // collab-team-v2 §7:常驻会话的 cwd 是群 folder。union 之后这条会话真的有
  // write/edit 了,「随手放个文档」需要的只是一个落点。
  //
  // 刻意 NOT 继承房间的 permissionMode(§2.3):work 会话继承是因为那是"正经
  // 开工的活"被授权过;一个只是来聊天的回合绝不该悄悄带上全自动放行的写权限。
  // 常驻会话只走 agent 自己声明的模式与严格者胜复合。
  if (roomSessionId && !session.workingDirectory) {
    const folder = ensureCollabRoomFolder(roomSessionId)
    if (folder) store.updateSessionWorkingDirectory(sessionId, folder)
  }
  // A session created before this agent was hidden (or un-archived by hand)
  // must not surface in the list — re-assert rather than trust the create path.
  if (!session.isArchived) store.updateSessionArchived(sessionId, true, Date.now())

  return sessionId
}

/**
 * The room an execution session is currently bound to. Undefined for anything
 * that is not one — callers use it as "the linked room" in the say routing and
 * fall through to their own rules.
 */
export function getCollabAgentSessionRoom(sessionId: string): string | undefined {
  const session = store.getSession(sessionId)
  if (session?.kind !== 'agent') return undefined
  return session.collab?.roomSessionId
}

/**
 * 推进这条常驻会话的已读游标(collab/history-window.ts)。
 *
 * 游标住在执行会话上,而不是另开一张 (agent × 房) 的表 —— collab-team-v2 §1.1
 * 已经保证"每群每 agent 一条常驻会话",所以这条会话本身就是那个键。它跟着
 * transcript 一起活过重启,这一点是必需的:2026-08-01 那次事故里,一批陈旧激活
 * 正是靠重启复活的,而能拦住它们的判据必须同样跨得过重启。
 *
 * **只前进,不后退**:并行回合(两间房各驱一次同一个 agent 是两条会话,但同一
 * 间房里的重驱、replay 都可能带着更旧的锚点回来)。用房间列表的下标比大小 ——
 * 时间戳会撞、会因为时钟回拨而乱序,而下标是这份转录自己的顺序。
 */
export function advanceSeenCursor(agentSessionId: string, seenMessageId: string): boolean {
  const session = store.getSession(agentSessionId)
  if (session?.kind !== 'agent') return false
  const collab = session.collab
  const roomSessionId = collab?.roomSessionId
  if (!roomSessionId) return false

  const current = collab?.seenMessageId
  if (current === seenMessageId) return false
  if (current) {
    const messages = sessionReads.listMessages(roomSessionId).messages
    const currentIndex = messages.findIndex(message => message.id === current)
    const nextIndex = messages.findIndex(message => message.id === seenMessageId)
    // 新锚点查无此条(消息被删)→ 不动:一个定位不到的游标会让整段历史变成
    // "未读",而那是最贵的一种错法。旧锚点查无此条则照旧前进(它已经不在了)。
    if (nextIndex < 0) return false
    if (currentIndex >= 0 && nextIndex <= currentIndex) return false
  }

  return store.updateSessionCollab(agentSessionId, {
    collab: { ...collab, roomSessionId, seenMessageId, seenAt: Date.now() },
  })
}

/**
 * 记下"这一轮的收尾正文已由框架代发进群",等下一次 drive 回声(架构审查 A6)。
 *
 * 为什么需要这条记录:被收养的消息署**作者本人**的名,而"自己的消息永不进未读"
 * (collab/history-window.ts)+「增量 drive 只带未读」= 作者读不到它 —— 它那边
 * 的事实仍然是"我写了但没发出去",而那正是下一轮重发的由头。
 *
 * 住在执行会话的 collab 上,与已读游标同一个理由:每(agent × 房)一条常驻会话,
 * 这条会话本身就是键;它跟着 transcript 活过重启,而收养也可能发生在重启前一轮。
 * 写法沿用 `advanceSeenCursor` —— 整份 collab 展开重写,别的字段一个不动。
 */
export function noteCollabAdoptedEcho(agentSessionId: string, messageId: string): boolean {
  const session = store.getSession(agentSessionId)
  if (session?.kind !== 'agent') return false
  const collab = session.collab
  const roomSessionId = collab?.roomSessionId
  if (!roomSessionId) return false
  return store.updateSessionCollab(agentSessionId, {
    collab: { ...collab, roomSessionId, adoptedEchoMessageId: messageId, adoptedEchoAt: Date.now() },
  })
}

/**
 * 取走待回声的那条(读 + 清,一次性)。
 *
 * 读完就清,而不是等回声真的进了 drive 才清:回声本身会落进 drive 消息成为历史,
 * 说一次就够;而一次没送出去的 drive(引擎没绑、被喊停)重发时房间内容整块都会
 * 重算,少一行"上一轮代发过"不会让模型多说什么 —— 反过来(清晚了,连着两轮都
 * 回声)才是噪声。
 */
export function takeCollabAdoptedEcho(
  agentSessionId: string,
): { messageId: string; at?: number } | undefined {
  const session = store.getSession(agentSessionId)
  const collab = session?.collab
  const messageId = collab?.adoptedEchoMessageId
  if (!collab || !messageId) return undefined
  const at = collab.adoptedEchoAt
  const next = { ...collab }
  delete next.adoptedEchoMessageId
  delete next.adoptedEchoAt
  store.updateSessionCollab(agentSessionId, { collab: next })
  return { messageId, ...(typeof at === 'number' ? { at } : {}) }
}

/**
 * 把已读游标退回"从未读过"(清空聊天记录)。
 *
 * 游标指向的那条消息已经不存在了,而 `advanceSeenCursor` 的"查无此条就不动"
 * 保护会让一个悬空游标永远留在那里 —— 于是这位同事眼里,一间空房仍然"读到过
 * 某处"。清成 undefined = 下一次回合走 bootstrap,把房间当新的读。
 *
 * `collab` 的其余字段(roomSessionId / taskId)原样保留:清的是记忆,不是归属。
 */
export function resetCollabSeenCursor(agentSessionId: string): boolean {
  const session = store.getSession(agentSessionId)
  const collab = session?.collab
  if (!collab) return false
  if (collab.seenMessageId === undefined && collab.seenAt === undefined) return false
  const next = { ...collab }
  delete next.seenMessageId
  delete next.seenAt
  return store.updateSessionCollab(agentSessionId, { collab: next })
}
