/**
 * Identity stamping for agent speech (W14a,
 * docs/design/multi-agent-collab-im.md §4.5 身份 id 化).
 *
 * A user picks members from a completion popover, so its mentions arrive with
 * ids already attached (the ingress gate below writes them). An agent has no
 * popover: it writes `@名字` in prose. So the coordinator resolves those names
 * against the roster at the ONE moment where the reply is settled and
 * persisted — the same terminal branch that counts the chain and hangs a quote
 * (W13.2) — and patches the ids on, broadcasting `message:updated` down the
 * very chain reactions and quotes already ride.
 *
 * Why stamp at all instead of re-parsing names forever: the label is a name at
 * a POINT IN TIME. Once the id is on the message, a rename repaints the text
 * and an activation still lands on the right member; without it, renaming an
 * agent would silently orphan every mention of it in the transcript.
 *
 * W14b will let the `say` tool pass mentions explicitly; this resolution stays
 * as the fallback for whatever it writes in prose.
 */
import {
  buildCollabMentions,
  type CollabAgentLike,
  type CollabMentionLike,
} from '@onething/runtime/collab'
import * as store from '../../store.js'
import { getEventBus } from '../../events/index.js'
import { sessionCommands } from '../../session/commands.js'
import { sessionReads } from '../../session/reads.js'

import { SESSION_EVENT_TYPES } from '@shared/events/index.js'

/**
 * Resolve the `@名字` in an already-persisted room message against `members`
 * and stamp the result onto it. Returns the mentions that were resolved (empty
 * when the message mentions nobody — nothing is written or broadcast then, so
 * a message with no mention keeps NO field and stays on the text fallback).
 */
export function attachCollabMentions(
  roomSessionId: string,
  messageId: string,
  members: readonly CollabAgentLike[],
): CollabMentionLike[] {
  const session = store.getSession(roomSessionId)
  if (!session || session.kind !== 'room') return []

  const message = sessionReads.getMessage(roomSessionId, messageId)
  if (!message) return []

  // Already stamped (a re-drive, a replayed harvest): the first write wins —
  // the roster it saw is the one contemporary with the message.
  if (Array.isArray(message.mentions)) return message.mentions

  const mentions = buildCollabMentions(message.content, members)
  if (mentions.length === 0) return []

  if (!sessionCommands.patchMessage(roomSessionId, { messageId, patch: { mentions } })) return []

  void getEventBus().emit(roomSessionId, {
    type: SESSION_EVENT_TYPES.MESSAGE_UPDATED,
    messageId,
    updates: { mentions },
  } as Parameters<ReturnType<typeof getEventBus>['emit']>[1])

  return mentions
}
