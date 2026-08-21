/**
 * Proactive quote attachment (W13.2,
 * docs/design/multi-agent-collab-im.md §4 W13.2 / §3.5 A).
 *
 * A human quotes BEFORE writing; an agent cannot — it is handed a drive and it
 * answers. So the coordinator hangs the quote AFTERWARDS: when a room reply has
 * drifted at least one visible message away from what triggered it, the
 * snapshot is patched onto the already-persisted message and broadcast as
 * `message:updated` — the exact same update chain W8's reactions ride.
 *
 * Nothing about the stream changes: the engine never sees this, the model never
 * sees it in its own output, and the drive is untouched. The quote is metadata
 * the room grew after the fact, which is also why a `message:updated` cannot
 * open a new willingness round (the coordinator does not listen to it).
 */
import {
  buildCollabReplyToSnapshot,
  shouldAttachCollabReplyTo,
  type CollabMessageLike,
} from '@onething/runtime/collab'
import type { ChatMessage, ChatMessageReplyTo } from '@shared/ipc.js'
import * as store from '../store.js'
import { getEventBus } from '../events/index.js'
import { sessionCommands } from '../session/commands.js'
import { sessionReads } from '../session/reads.js'
import { findAgent } from '../wiring/agents/index.js'
import { resolveUserIdentity } from './user-identity.js'

import { SESSION_EVENT_TYPES } from '@shared/events/index.js'

function authorLabelOf(message: ChatMessage): string {
  // 快照语义(agent-dm-user.md §2.3):这里取的是**引用发生那一刻**的称呼,
  // 之后改名不追改旧引用 —— 引用本来就是一段话的副本,不是一个身份指针。
  if (message.role === 'user') return resolveUserIdentity().label
  if (!message.agentId) return ''
  const agent = findAgent(message.agentId)
  return agent ? agent.name : message.agentId
}

/**
 * Hang a quote on `replyMessageId` pointing at `triggerMessageId`, if the gap
 * earns one. Returns the snapshot that was written, or null when nothing was
 * (no trigger, no gap, pass turn, already quoted, message gone).
 */
export function attachCollabReplyTo(
  roomSessionId: string,
  replyMessageId: string,
  triggerMessageId: string | undefined,
): ChatMessageReplyTo | null {
  if (!triggerMessageId) return null
  const session = store.getSession(roomSessionId)
  if (!session || session.kind !== 'room') return null

  const messages = sessionReads.listMessages(roomSessionId).messages as ChatMessage[]
  const reply = messages.find(message => message.id === replyMessageId)
  const trigger = messages.find(message => message.id === triggerMessageId)
  if (!reply || !trigger) return null

  if (!shouldAttachCollabReplyTo({
    messages: messages as unknown as Array<CollabMessageLike & { id?: string }>,
    triggerMessageId,
    replyMessageId,
    reply: reply as unknown as CollabMessageLike,
  })) {
    return null
  }

  const snapshot = buildCollabReplyToSnapshot({
    messageId: trigger.id,
    authorLabel: authorLabelOf(trigger),
    content: trigger.content,
  })
  if (!snapshot) return null

  if (!sessionCommands.patchMessage(roomSessionId, { messageId: replyMessageId, patch: { replyTo: snapshot } })) return null

  void getEventBus().emit(roomSessionId, {
    type: SESSION_EVENT_TYPES.MESSAGE_UPDATED,
    messageId: replyMessageId,
    updates: { replyTo: snapshot },
  } as Parameters<ReturnType<typeof getEventBus>['emit']>[1])

  return snapshot
}
