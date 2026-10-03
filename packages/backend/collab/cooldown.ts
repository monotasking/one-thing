/**
 * Chatter suppression — docs/design/multi-agent-collab-im.md §4 W21.
 *
 * The 2026-07-28 incident: one human "hi" produced five agent messages and the
 * SAME agent spoke three times (寒暄 → 元评论 → @ 人调侃). Nothing was broken —
 * every message passed its own willingness judgement and the chain gate (K=8)
 * did bound it — but a room where a member can answer its own last sentence is
 * not an IM room, it is a feedback loop.
 *
 * Two structural brakes live here and in activation.ts, both mechanism-only
 * (personas are untouched — a talkative persona is a feature, the loop is not):
 *  1. speech cooldown (this module): an agent whose own utterance is still
 *     inside the last K_cd VISIBLE room messages does not get a self-election
 *     judgement. Being @-ed or pulled in by a task event bypasses this
 *     completely — 点名必须能应.
 *  2. self-elect chain cap (activation.ts): 自选 activations gate at a tighter
 *     cap than mentions.
 */
import { isCollabPassMessage } from './pass.js'
import { isCollabThinkingMessage } from './say.js'
import { isCollabProjectedSystemLine } from './system-lines.js'
import { isCollabDriveMessage, type CollabMessageLike } from './types.js'

/**
 * How many recent VISIBLE messages the cooldown looks back over. 2 = "you just
 * spoke, and one other line since does not make it new input". The window is
 * counted in visible messages of ANY author, so a human reply pushes the
 * agent's own line one slot back — the room recovers by being talked to, which
 * is exactly the intended asymmetry (agents cool down, humans reopen).
 */
export const COLLAB_SELF_ELECT_COOLDOWN = 2

/**
 * Is this message part of what the ROOM SAID — the exact set the willingness
 * window projects as `名字: 内容`.
 *
 * Excluded: coordinator drives (synthetic), `[pass]` sentinels, thinking
 * records (W14b — deliberation is not speech), operational system noise
 * (budget/chain/freeze/未应答 lines are bookkeeping, never projected), and
 * empty bodies. Included: real user/assistant messages and the MARKED collab
 * system lines (task lifecycle, membership) that W9.1 projects as「系统: …」.
 *
 * Distinct from `isCollabVisibleRoomMessage` (reply-quote.ts) on purpose: that
 * one mirrors the RENDERER (does this occupy a row on screen), so it counts
 * operational lines. This one is the MODEL's口径 — the cooldown asks "did the
 * conversation move on", and a budget notice is not the conversation moving on.
 * Sharing it with buildWillingnessWindow keeps the two from drifting.
 */
export function isCollabProjectedRoomMessage(message: CollabMessageLike): boolean {
  if (isCollabProjectedSystemLine(message)) return (message.content ?? '').trim().length > 0
  if (message.role !== 'user' && message.role !== 'assistant') return false
  if (isCollabDriveMessage(message)) return false
  if (isCollabPassMessage(message.content)) return false
  if (isCollabThinkingMessage(message)) return false
  return (message.content ?? '').trim().length > 0
}

/**
 * Is this message part of the CONVERSATION — someone actually saying something
 * (P2-12, 债5).
 *
 * The projection 口径 above answers "does the model read this", and system
 * lines belong in it: a reviewer that cannot see 「开始执行 / 受阻」 can only
 * believe what other agents claim (W9.1). But the cooldown asks a different
 * question — "has the room moved on since this member last spoke" — and a
 * task-fact line the coordinator posted is not the room moving on. Borrowing
 * the projection 口径 for it meant the machine could talk an agent's own line
 * out of the cooldown window and re-open its right to self-elect: two task
 * events and a member could answer its own last sentence, which is exactly the
 * loop W21 exists to close.
 *
 * So there are three 口径 now, each named and tested for what it decides:
 *   visible (reply-quote.ts)   — does this occupy a row on screen
 *   projected (above)          — does the model read this
 *   conversation (here)        — did a person or an agent SAY this
 */
export function isCollabConversationMessage(message: CollabMessageLike): boolean {
  if (message.role !== 'user' && message.role !== 'assistant') return false
  return isCollabProjectedRoomMessage(message)
}

/** The last `limit` projected messages of a transcript tail, oldest first. */
export function selectRecentCollabProjectedMessages(
  messages: readonly CollabMessageLike[],
  limit: number,
): CollabMessageLike[] {
  if (limit <= 0) return []
  const visible = messages.filter(isCollabProjectedRoomMessage)
  return visible.slice(-limit)
}

/** The last `limit` CONVERSATION messages of a transcript tail, oldest first. */
export function selectRecentCollabConversationMessages(
  messages: readonly CollabMessageLike[],
  limit: number,
): CollabMessageLike[] {
  if (limit <= 0) return []
  return messages.filter(isCollabConversationMessage).slice(-limit)
}

/**
 * W21 rule 1 — the self-election candidate filter.
 *
 * Drops every candidate whose own utterance sits inside the last `cooldown`
 * visible messages. Applied by the coordinator BEFORE the willingness round, so
 * a cooled-down member costs zero judgement calls as well as zero noise.
 *
 * Deliberately scoped to SELF-ELECTION: mentions short-circuit the judgement
 * entirely (activation.ts) and task events are queued by the work pipeline, so
 * neither ever reaches this filter — being named always wins.
 *
 * `messages` is a raw transcript tail; the CONVERSATION 口径 is applied here so
 * callers cannot accidentally count drives, thinking records or system lines as
 * elapsed time ("中间夹了一条驱动/思考/任务事实行" must not look like the room
 * moved on).
 */
export function filterCollabSelfElectCandidates<T extends { id: string }>(
  candidates: readonly T[],
  messages: readonly CollabMessageLike[],
  cooldown: number = COLLAB_SELF_ELECT_COOLDOWN,
): T[] {
  if (cooldown <= 0) return [...candidates]
  const window = selectRecentCollabConversationMessages(messages, cooldown)
  const spoke = new Set<string>()
  for (const message of window) {
    // Any visible line an agent left in the room counts as it having spoken:
    // a `say`, a pre-W14b turn utterance, or a legacy harvest post carrying its
    // name. From the room's point of view they are all "他刚说过话".
    if (message.role === 'assistant' && message.agentId) spoke.add(message.agentId)
  }
  if (spoke.size === 0) return [...candidates]
  return candidates.filter(candidate => !spoke.has(candidate.id))
}
