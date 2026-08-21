/**
 * Room message reactions — the app-layer write (W8,
 * docs/design/multi-agent-collab-im.md §3.5 B).
 *
 * One choke point for BOTH sources of a reaction (the human tapping a chip over
 * IPC, and an agent's judgement react), so palette validation, persistence and
 * the broadcast happen exactly once and cannot drift apart.
 *
 * The broadcast reuses `message:updated` — the renderer already merges those
 * into the message it is showing. That reuse is also what keeps the promise in
 * the design: reactions are METADATA, and the coordinator listens only to
 * `message:user-created`, so a reaction can never open a willingness round.
 */
import { applyCollabReaction, normalizeCollabReactionEmoji } from '@onething/runtime/collab'
import type { ChatMessageReaction, ChatMessageReactionActor } from '@shared/ipc.js'
import * as store from '../../store.js'
import { getEventBus } from '../../events/index.js'
import { sessionCommands } from '../../session/commands.js'
import { sessionReads } from '../../session/reads.js'

import { SESSION_EVENT_TYPES } from '@shared/events/index.js'

export interface CollabMessageReactionResult {
  success: boolean
  error?: string
  reactions?: ChatMessageReaction[]
}

export interface CollabMessageReactionOptions {
  /**
   * Default true (human tap: tapping the same chip again takes it back).
   * The agent path passes false — being asked twice must never RETRACT a
   * member's own reaction.
   */
  toggle?: boolean
}

/**
 * Apply one reaction to one room message.
 *
 * Room-scoped on purpose: ordinary sessions have no reaction affordance at all,
 * so a write aimed at one is a bug somewhere upstream, not a feature to support.
 */
export function reactToCollabMessage(
  roomSessionId: string,
  messageId: string,
  emoji: string,
  actor: ChatMessageReactionActor,
  options: CollabMessageReactionOptions = {},
): CollabMessageReactionResult {
  const session = store.getSession(roomSessionId)
  if (!session || session.kind !== 'room') return { success: false, error: 'Not a room session' }
  if (!normalizeCollabReactionEmoji(emoji)) return { success: false, error: 'Unsupported reaction emoji' }
  if (actor?.type !== 'user' && actor?.type !== 'agent') return { success: false, error: 'Unknown actor' }
  if (actor.type === 'agent' && !actor.agentId) return { success: false, error: 'Agent reaction needs an agentId' }

  const message = sessionReads.getMessage(roomSessionId, messageId)
  if (!message) return { success: false, error: 'Message not found' }

  const next = applyCollabReaction(message.reactions, emoji, actor, {
    toggle: options.toggle !== false,
  }) as ChatMessageReaction[] | null
  // null = nothing changed (add-only re-react). Skipping the write also skips
  // the broadcast, so a no-op never reads as an edit in the UI.
  if (!next) return { success: true, reactions: message.reactions ?? [] }

  if (!sessionCommands.patchMessage(roomSessionId, { messageId, patch: { reactions: next } })) {
    return { success: false, error: 'Message not found' }
  }

  void getEventBus().emit(roomSessionId, {
    type: SESSION_EVENT_TYPES.MESSAGE_UPDATED,
    messageId,
    updates: { reactions: next },
  } as Parameters<ReturnType<typeof getEventBus>['emit']>[1])

  return { success: true, reactions: next }
}
