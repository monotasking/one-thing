/**
 * Emoji reactions — pure logic (W8, docs/design/multi-agent-collab-im.md §3.5 B).
 *
 * Reactions are stored ALREADY AGGREGATED (one entry per emoji, carrying the
 * list of actors), so the chip count, the tooltip roster and the model-side
 * `(👍×2)` annotation all read the same array instead of each re-grouping it.
 *
 * Two write modes share one implementation:
 *  - toggle (the human tapping a chip): same actor + same emoji again removes it
 *  - add-only (an agent's judgement react): a member can never RETRACT its own
 *    reaction by being asked twice, which is the only way toggle semantics could
 *    misfire on the automatic path
 *
 * Kept DOM-free / wire-free so both halves — the renderer chip row and the
 * coordinator's judgement path — run the exact same set arithmetic.
 */

export interface CollabReactionActorLike {
  type: 'user' | 'agent'
  agentId?: string
}

export interface CollabReactionLike {
  emoji: string
  by: CollabReactionActorLike[]
}

/**
 * The palette. One list serves both halves of the feature: the picker offers
 * exactly these, and a judgement reply naming anything else is dropped — the
 * model must not be able to invent an emoji vocabulary for the room.
 */
export const COLLAB_REACTION_EMOJIS = ['👍', '❤️', '😂', '🎉', '🤔', '👀'] as const

export type CollabReactionEmoji = (typeof COLLAB_REACTION_EMOJIS)[number]

/** How many distinct emoji a projection annotation may carry (总长截断). */
export const COLLAB_REACTION_SUMMARY_MAX_ENTRIES = 6

/**
 * Variation selectors are invisible and models emit them inconsistently
 * ('❤' vs '❤️'), so comparison happens on the stripped form while the palette
 * spelling is what gets stored — one canonical byte sequence per emoji.
 */
const VARIATION_SELECTORS = /[\uFE0E\uFE0F]/g

function stripPresentation(value: string): string {
  return value.replace(VARIATION_SELECTORS, '')
}

/** Palette membership check; returns the canonical spelling or null. */
export function normalizeCollabReactionEmoji(
  raw: string | null | undefined,
): CollabReactionEmoji | null {
  if (!raw) return null
  const needle = stripPresentation(String(raw).trim())
  if (!needle) return null
  return COLLAB_REACTION_EMOJIS.find(
    candidate => stripPresentation(candidate) === needle,
  ) ?? null
}

/** The human is one identity; agents are distinguished by roster id. */
export function isSameCollabReactionActor(
  a: CollabReactionActorLike,
  b: CollabReactionActorLike,
): boolean {
  if (a.type !== b.type) return false
  if (a.type === 'user') return true
  return (a.agentId ?? '') === (b.agentId ?? '')
}

function cloneActor(actor: CollabReactionActorLike): CollabReactionActorLike {
  return actor.type === 'agent'
    ? { type: 'agent', agentId: actor.agentId }
    : { type: 'user' }
}

export interface ApplyCollabReactionOptions {
  /** Default true. false = add-only (an ask twice is not a retraction). */
  toggle?: boolean
}

/**
 * Apply one reaction. Returns the NEW array, or null when nothing changed —
 * callers use that to skip both the persist and the broadcast (an add-only
 * re-react is a no-op, and a no-op must not look like an edit to the UI).
 *
 * Rejects emoji outside the palette and agent actors with no id: a reaction
 * nobody can be named for cannot be counted, toggled off, or explained.
 */
export function applyCollabReaction(
  reactions: readonly CollabReactionLike[] | undefined,
  emoji: string,
  actor: CollabReactionActorLike,
  options: ApplyCollabReactionOptions = {},
): CollabReactionLike[] | null {
  const canonical = normalizeCollabReactionEmoji(emoji)
  if (!canonical) return null
  if (actor.type === 'agent' && !actor.agentId) return null

  const next: CollabReactionLike[] = (reactions ?? []).map(entry => ({
    emoji: entry.emoji,
    by: (entry.by ?? []).map(cloneActor),
  }))

  const stripped = stripPresentation(canonical)
  const groupIndex = next.findIndex(entry => stripPresentation(entry.emoji ?? '') === stripped)
  if (groupIndex < 0) {
    next.push({ emoji: canonical, by: [cloneActor(actor)] })
    return next
  }

  const group = next[groupIndex]
  const actorIndex = group.by.findIndex(existing => isSameCollabReactionActor(existing, actor))
  if (actorIndex < 0) {
    group.by.push(cloneActor(actor))
    return next
  }

  if (options.toggle === false) return null
  group.by.splice(actorIndex, 1)
  if (group.by.length === 0) next.splice(groupIndex, 1)
  return next
}

/** Human tap: same actor + same emoji again takes it back. */
export function toggleCollabReaction(
  reactions: readonly CollabReactionLike[] | undefined,
  emoji: string,
  actor: CollabReactionActorLike,
): CollabReactionLike[] | null {
  return applyCollabReaction(reactions, emoji, actor, { toggle: true })
}

/** Agent judgement react: idempotent, never a retraction. */
export function addCollabReaction(
  reactions: readonly CollabReactionLike[] | undefined,
  emoji: string,
  actor: CollabReactionActorLike,
): CollabReactionLike[] | null {
  return applyCollabReaction(reactions, emoji, actor, { toggle: false })
}

export interface CollabReactionTally {
  emoji: string
  count: number
  actors: CollabReactionActorLike[]
}

/** Display view: empty groups dropped, order preserved (first reaction first). */
export function tallyCollabReactions(
  reactions: readonly CollabReactionLike[] | undefined,
): CollabReactionTally[] {
  const tallies: CollabReactionTally[] = []
  for (const entry of reactions ?? []) {
    const actors = entry?.by ?? []
    if (!entry?.emoji || actors.length === 0) continue
    tallies.push({ emoji: entry.emoji, count: actors.length, actors: [...actors] })
  }
  return tallies
}

/** True when this actor is already in the emoji's group (chip "mine" state). */
export function hasCollabReactionFrom(
  reactions: readonly CollabReactionLike[] | undefined,
  emoji: string,
  actor: CollabReactionActorLike,
): boolean {
  const stripped = stripPresentation(emoji ?? '')
  const group = (reactions ?? []).find(entry => stripPresentation(entry?.emoji ?? '') === stripped)
  if (!group) return false
  return (group.by ?? []).some(existing => isSameCollabReactionActor(existing, actor))
}

/**
 * The model-side annotation (§3.5 B): `(👍×2 🎉)`. A single reactor renders as
 * the bare emoji — `×1` is noise in a line the model reads as atmosphere, not
 * as a table. Empty reactions produce '' so no caller emits a stray `()`.
 */
export function formatCollabReactionSummary(
  reactions: readonly CollabReactionLike[] | undefined,
): string {
  const parts: string[] = []
  for (const tally of tallyCollabReactions(reactions)) {
    parts.push(tally.count > 1 ? `${tally.emoji}×${tally.count}` : tally.emoji)
    if (parts.length >= COLLAB_REACTION_SUMMARY_MAX_ENTRIES) break
  }
  return parts.length > 0 ? `(${parts.join(' ')})` : ''
}

/** A speech block with its reaction annotation appended, when it has any. */
export function appendCollabReactionSummary(
  block: string,
  reactions: readonly CollabReactionLike[] | undefined,
): string {
  const summary = formatCollabReactionSummary(reactions)
  return summary ? `${block} ${summary}` : block
}
