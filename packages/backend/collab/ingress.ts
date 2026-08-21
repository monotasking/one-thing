/**
 * Room ingress gate — docs/design/multi-agent-collab.md D2.
 *
 * The engine auto-drives a stream for every command:send-message. In a room
 * that would reply with the LAST activated persona (wrong speaker, no mention
 * resolution, no chain gate) and supersede-abort the coordinator's own drives.
 * So user messages into kind='room' sessions are persisted WITHOUT streaming;
 * the coordinator observes message:user-created on the bus and decides
 * activations. Coordinator drives (source 'collab') bypass this gate via the
 * system-internal branch in StreamEngine.handleSendMessage.
 */
import { randomUUID } from 'node:crypto'
import {
  type ChatMessage,
  type ChatMessageMention,
  type ChatMessageReplyTo,
  type MessageAttachment,
  type MessageOrigin,
  type VoiceTranscriptMetadata,
} from '@shared/ipc.js'
import * as store from '../store.js'
import { sessionCommands } from '../session/commands.js'
import { getEventBus } from '../events/index.js'
import { collabSessionRoomMembers } from './members.js'
import {
  COLLAB_MESSAGE_SOURCE,
  buildCollabMentions,
  expandCollabAllMentions,
  mergeCollabMentions,
  normalizeCollabMentions,
  type CollabAgentLike,
} from '@onething/runtime/collab'
import { isTrustedCollabDrive } from './drive-guard.js'
import { collabV3RoomPostPort } from './actors/turn-context.js'

import { SESSION_EVENT_TYPES } from '@shared/events/index.js'

export interface CollabRoomInboundCommand {
  content: string
  attachments?: MessageAttachment[]
  voice?: VoiceTranscriptMetadata
  origin?: MessageOrigin
  source?: string
  channel?: string
  /** Proof the coordinator sent this (P2-8); see drive-guard.ts. */
  collabDriveToken?: string
  /** IM quote reply — a snapshot the sender built; persisted verbatim. */
  replyTo?: ChatMessageReplyTo
  /**
   * Members the composer's `@` popover picked (W14a). Re-validated here, never
   * trusted verbatim: unknown ids are dropped and labels are re-stamped from
   * the roster.
   */
  mentions?: ChatMessageMention[]
}

/**
 * @ 能落在谁身上:退休的成员不算(域模型 §3.2)—— 点不到,也就不会被激活。
 *
 * 不带 `description`:这一面只做**匹配**,一句职责说明进不了任何判据。
 */
function roomMembers(session: { room?: { memberAgentIds?: string[] } }): CollabAgentLike[] {
  return collabSessionRoomMembers(session)
}

/**
 * The user half of 身份 id 化 (W14a §4.5): what the picker chose, plus the
 * bare-typed names it knows nothing about.
 *
 * The picker's ids are authoritative for the labels they claim — that is what
 * makes picking one of two 小李 activate exactly that one. Every OTHER `@名字`
 * in the text still resolves by name (and, being ambiguous, resolves to
 * everyone who goes by it): a user who types a mention by hand gets the same
 * behavior as before, now with ids attached.
 */
function resolveInboundMentions(
  command: CollabRoomInboundCommand,
  members: readonly CollabAgentLike[],
): ChatMessageMention[] {
  const picked = normalizeCollabMentions(command.mentions, { members })
  const parsed = buildCollabMentions(command.content, members)
  // `@所有人`(2026-08-02):展开成全体在职成员的 mention,走的就是既有点名链路
  // (并行短路激活、编排强制进第一批)—— 全房必答从此是代码保证,不依赖仲裁
  // 模型读懂"所有人"三个字。只在用户入口展开;agent 的 say 不认这个 token。
  const all = expandCollabAllMentions(command.content, members)
  return mergeCollabMentions(mergeCollabMentions(picked, all), parsed)
}

export function isCollabRoomSession(sessionId: string): boolean {
  return store.getSession(sessionId)?.kind === 'room'
}

/**
 * The sessions only the coordinator may stream: the room itself (pre-W18 shape,
 * and still where a legacy drive would land) and an agent's execution session,
 * which is where every room turn has run since W18. Both are surfaces the
 * coordinator owns end to end — anyone else driving one produces a turn with
 * the wrong persona, no mention resolution, and none of the three gates.
 */
export function isCollabCoordinatorDrivenSession(sessionId: string): boolean {
  const kind = store.getSession(sessionId)?.kind
  return kind === 'room' || kind === 'agent'
}

/**
 * Consume a send-message command aimed at a room session. Returns false when
 * the session is not a room (caller proceeds with the normal engine path).
 */
export async function handleCollabRoomSendMessage(
  sessionId: string,
  command: CollabRoomInboundCommand,
): Promise<boolean> {
  const session = store.getSession(sessionId)
  if (session?.kind !== 'room') return false
  // P2-8: a drive skips this gate on PROOF, not on a spelling. Anything that
  // merely claims source 'collab' is treated as what it is — an ordinary
  // inbound message, persisted for the coordinator to decide on.
  if (command.source === COLLAB_MESSAGE_SOURCE && isTrustedCollabDrive(command)) return false

  const mentions = resolveInboundMentions(command, roomMembers(session))

  const message: ChatMessage = {
    id: randomUUID(),
    role: 'user',
    content: command.content,
    timestamp: Date.now(),
    attachments: command.attachments,
    source: command.source || 'text',
    ...(command.voice !== undefined ? { voice: command.voice } : {}),
    ...(command.origin !== undefined ? { origin: command.origin } : {}),
    // Room messages never reach the core engine's own构造 (this gate persists
    // them itself), so the quote snapshot has to be carried across HERE too —
    // dropping it here would make 引用回复 work everywhere except the one
    // session kind that has the entry point.
    ...(command.replyTo !== undefined ? { replyTo: command.replyTo } : {}),
    // W14a: the key is written only when something was actually mentioned —
    // an empty array is a statement ("mentions nobody") that would switch
    // consumers off the name fallback for no benefit.
    ...(mentions.length > 0 ? { mentions } : {}),
  }

  sessionCommands.appendMessage(sessionId, { message, stampCollab: true })
  await getEventBus().emit(sessionId, {
    type: SESSION_EVENT_TYPES.MESSAGE_USER_CREATED,
    message,
  } as Parameters<ReturnType<typeof getEventBus>['emit']>[1])
  /**
   * v3:落库之后**把这条消息投进 RoomActor**(D6-a 接线)。
   *
   * 次序是「先落库再投信」而不是反过来:房间的 `applyCollabRoomPosted` 对入口
   * 的 posted 不写转录(转录归这里),而它随后要做的每一件事 —— 推水位、清链、
   * 按 @ 发牌 —— 都以「这条消息已经在转录里」为前提。投信在前的话,拿到牌的
   * 那位组装 drive 时读到的房间里还没有这句话。
   *
   * v2 的路径**一个字都没改**:协调器仍然订阅 `message:user-created`,只是
   * D6-a 之后没有人再初始化它。端口没装上(v3 未起)时这一行是空操作。
   */
  const post = collabV3RoomPostPort()
  if (post) await post(sessionId, message)
  return true
}
