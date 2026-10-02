/**
 * Quote-reply snapshots + the "is a quote worth attaching" rule — pure logic
 * (W7 snapshot shape, W13.2 proactive attachment).
 * docs/design/multi-agent-collab-im.md §3.5 A / §4 W13.2.
 *
 * A reply carries a COPY of what it answers, not a pointer to it: the author
 * label is the signature at quote time and the excerpt is the text at quote
 * time. The original can then be edited, or fall out of the loaded page, and
 * the quote block still reads whole. `messageId` exists only so the block can
 * scroll back — when the target is gone, nothing jumps.
 *
 * DOM-free and store-free: the renderer's composer path and the coordinator's
 * after-the-fact attachment both build snapshots through here, so a human quote
 * and an agent quote are byte-identical in storage.
 */
import { isCollabPassMessage } from './pass.js'
import { truncateAtCodePoint } from './truncate.js'
import { isCollabThinkingMessage } from './say.js'
import { isCollabDriveMessage, type CollabMessageLike, type CollabReplyToLike } from './types.js'

/** §3.5 A: the excerpt is the first 120 chars of the quoted message. */
export const COLLAB_REPLY_EXCERPT_MAX_CHARS = 120

/** The label a quoted human message gets — the same signature the room
 *  projection uses for the user, so UI and model read one name. */
export const COLLAB_REPLY_USER_LABEL = '用户'

/** Fallback for an agent whose roster entry is missing. */
export const COLLAB_REPLY_UNKNOWN_AUTHOR_LABEL = '成员'

/**
 * Flatten to one line: the quote block and the model-side「> 作者: 摘录」line
 * are both single-line, so newlines and runs of whitespace collapse here once
 * instead of being re-squeezed by every consumer.
 */
export function condenseCollabReplyExcerpt(
  content: string,
  maxChars: number = COLLAB_REPLY_EXCERPT_MAX_CHARS,
): string {
  const flat = (content || '').replace(/\s+/g, ' ').trim()
  if (flat.length <= maxChars) return flat
  return `${truncateAtCodePoint(flat, maxChars)}…`
}

export interface BuildCollabReplyToSnapshotOptions {
  messageId: string
  /** Signature at quote time; blank falls back to 成员. */
  authorLabel?: string
  /** The quoted message's text. */
  content: string
}

/**
 * Build the snapshot that rides on the replying message. Returns null when
 * there is nothing worth quoting (no id, or a message with no text at all —
 * an empty quote block is noise, not context).
 */
export function buildCollabReplyToSnapshot(
  options: BuildCollabReplyToSnapshotOptions,
): { messageId: string; authorLabel: string; excerpt: string } | null {
  const messageId = (options.messageId || '').trim()
  if (!messageId) return null
  const excerpt = condenseCollabReplyExcerpt(options.content)
  if (!excerpt) return null
  return {
    messageId,
    authorLabel: (options.authorLabel || '').trim() || COLLAB_REPLY_UNKNOWN_AUTHOR_LABEL,
    excerpt,
  }
}

/**
 * Does this message occupy a row in the room?
 *
 * The gap rule below counts what a HUMAN saw scroll past, so the mirror of the
 * renderer's `isRoomHiddenMessage` is what matters: coordinator drives never
 * render, and a settled pass turn renders nothing either. Everything else that
 * carries text does show — including worker 交付/进展 posts (they read as normal
 * speech in the room) and the projected/operational system lines.
 */
export function isCollabVisibleRoomMessage(message: CollabMessageLike): boolean {
  if (!message.content || !message.content.trim()) return false
  if (isCollabDriveMessage(message)) return false
  if (message.role === 'assistant' && isCollabPassMessage(message.content)) return false
  // W14b: a thinking record renders as a collapsed hairline, not a message.
  // The gap rule asks "did the CONVERSATION drift away from the question", and
  // an unspoken deliberation is not conversation — counting it would hang
  // quotes on answers that in fact followed their trigger immediately.
  if (isCollabThinkingMessage(message)) return false
  return true
}

export interface CollabReplyGapOptions {
  /** The room transcript, oldest first. */
  messages: readonly (CollabMessageLike & { id?: string })[]
  /** The message that triggered the activation (mention target / judged msg). */
  triggerMessageId: string | undefined
  /** The reply that just landed. */
  replyMessageId: string
}

/**
 * How many rows the room showed BETWEEN the trigger and the reply.
 *
 * Returns -1 when the pair cannot be located in order — the caller treats that
 * as "don't touch it" rather than guessing.
 */
export function countCollabVisibleMessagesBetween(options: CollabReplyGapOptions): number {
  const { messages, triggerMessageId, replyMessageId } = options
  if (!triggerMessageId || triggerMessageId === replyMessageId) return -1
  const from = messages.findIndex(message => message.id === triggerMessageId)
  if (from < 0) return -1
  const to = messages.findIndex((message, index) => index > from && message.id === replyMessageId)
  if (to < 0) return -1
  let count = 0
  for (let index = from + 1; index < to; index++) {
    if (isCollabVisibleRoomMessage(messages[index])) count += 1
  }
  return count
}

/**
 * Should the coordinator hang a quote on this reply?
 *
 * IM convention, and the whole reason this is a rule and not "always": quoting
 * the line directly above you is noise — nobody does it in a real group chat.
 * The quote earns its row only once the answer has drifted away from the
 * question, i.e. at least one visible message came in between.
 *
 * A reply that already carries a snapshot is left alone (the model may have
 * been driven with an explicit quote), and a pass turn is never decorated.
 */
export function shouldAttachCollabReplyTo(options: CollabReplyGapOptions & {
  /** The reply's own persisted shape (pass / already-quoted checks). */
  reply: CollabMessageLike
}): boolean {
  if (options.reply.replyTo?.messageId) return false
  if (!isCollabVisibleRoomMessage(options.reply)) return false
  return countCollabVisibleMessagesBetween(options) >= 1
}

export type { CollabReplyToLike }
