/**
 * Emoji reactions, pure logic (W8, docs/design/multi-agent-collab-im.md §3.5 B).
 *
 * The set arithmetic is shared by the chip row and the coordinator, so it is
 * tested here once: add / switch / take back / aggregate, the palette gate, and
 * the two write modes (human toggle vs. the agent's non-retracting add).
 */
import { describe, expect, it } from 'vitest'
import {
  COLLAB_REACTION_EMOJIS,
  addCollabReaction,
  appendCollabReactionSummary,
  formatCollabReactionSummary,
  hasCollabReactionFrom,
  isSameCollabReactionActor,
  normalizeCollabReactionEmoji,
  tallyCollabReactions,
  toggleCollabReaction,
  type CollabReactionLike,
} from '../reactions.js'

const USER = { type: 'user' as const }
const LI = { type: 'agent' as const, agentId: 'a1' }
const MING = { type: 'agent' as const, agentId: 'a2' }

describe('normalizeCollabReactionEmoji', () => {
  it('accepts every palette emoji and nothing else', () => {
    for (const emoji of COLLAB_REACTION_EMOJIS) {
      expect(normalizeCollabReactionEmoji(emoji)).toBe(emoji)
    }
    expect(normalizeCollabReactionEmoji('🚀')).toBeNull()
    expect(normalizeCollabReactionEmoji('👍👍')).toBeNull()
    expect(normalizeCollabReactionEmoji('')).toBeNull()
    expect(normalizeCollabReactionEmoji(undefined)).toBeNull()
  })

  it('canonicalizes a missing variation selector to the palette spelling', () => {
    expect(normalizeCollabReactionEmoji('❤')).toBe('❤️')
    expect(normalizeCollabReactionEmoji(' 👍 ')).toBe('👍')
  })
})

describe('isSameCollabReactionActor', () => {
  it('treats the human as one identity and agents by id', () => {
    expect(isSameCollabReactionActor(USER, { type: 'user' })).toBe(true)
    expect(isSameCollabReactionActor(LI, { type: 'agent', agentId: 'a1' })).toBe(true)
    expect(isSameCollabReactionActor(LI, MING)).toBe(false)
    expect(isSameCollabReactionActor(USER, LI)).toBe(false)
  })
})

describe('toggleCollabReaction', () => {
  it('adds a first reaction as its own group', () => {
    expect(toggleCollabReaction(undefined, '👍', USER)).toEqual([
      { emoji: '👍', by: [{ type: 'user' }] },
    ])
  })

  it('aggregates a second actor into the existing emoji group', () => {
    const first = toggleCollabReaction(undefined, '👍', USER)!
    expect(toggleCollabReaction(first, '👍', LI)).toEqual([
      { emoji: '👍', by: [{ type: 'user' }, { type: 'agent', agentId: 'a1' }] },
    ])
  })

  it('keeps a different emoji as a separate group, in first-use order', () => {
    const first = toggleCollabReaction(undefined, '👍', USER)!
    const both = toggleCollabReaction(first, '🎉', USER)!
    expect(both.map(entry => entry.emoji)).toEqual(['👍', '🎉'])
  })

  it('takes the reaction back when the same actor repeats it', () => {
    const first = toggleCollabReaction(undefined, '👍', USER)!
    const withLi = toggleCollabReaction(first, '👍', LI)!
    const afterUndo = toggleCollabReaction(withLi, '👍', USER)!
    expect(afterUndo).toEqual([{ emoji: '👍', by: [{ type: 'agent', agentId: 'a1' }] }])
  })

  it('drops the group entirely when its last actor takes it back', () => {
    const first = toggleCollabReaction(undefined, '👍', USER)!
    expect(toggleCollabReaction(first, '👍', USER)).toEqual([])
  })

  it('matches an existing group written without the variation selector', () => {
    const stored: CollabReactionLike[] = [{ emoji: '❤', by: [{ type: 'agent', agentId: 'a1' }] }]
    expect(toggleCollabReaction(stored, '❤️', USER)).toEqual([
      { emoji: '❤', by: [{ type: 'agent', agentId: 'a1' }, { type: 'user' }] },
    ])
  })

  it('never mutates the array it was given', () => {
    const original: CollabReactionLike[] = [{ emoji: '👍', by: [{ type: 'user' }] }]
    toggleCollabReaction(original, '👍', LI)
    expect(original).toEqual([{ emoji: '👍', by: [{ type: 'user' }] }])
  })

  it('refuses off-palette emoji and id-less agents', () => {
    expect(toggleCollabReaction(undefined, '🚀', USER)).toBeNull()
    expect(toggleCollabReaction(undefined, '👍', { type: 'agent' })).toBeNull()
  })
})

describe('addCollabReaction (agent path)', () => {
  it('is idempotent: being asked twice never retracts', () => {
    const first = addCollabReaction(undefined, '👍', LI)!
    expect(addCollabReaction(first, '👍', LI)).toBeNull()
    expect(first).toEqual([{ emoji: '👍', by: [{ type: 'agent', agentId: 'a1' }] }])
  })

  it('still aggregates a different agent onto the same emoji', () => {
    const first = addCollabReaction(undefined, '👍', LI)!
    expect(addCollabReaction(first, '👍', MING)?.[0].by).toHaveLength(2)
  })
})

describe('tallyCollabReactions / hasCollabReactionFrom', () => {
  it('counts actors per emoji and drops empty groups', () => {
    const reactions: CollabReactionLike[] = [
      { emoji: '👍', by: [{ type: 'user' }, { type: 'agent', agentId: 'a1' }] },
      { emoji: '🎉', by: [] },
      { emoji: '👀', by: [{ type: 'agent', agentId: 'a2' }] },
    ]
    expect(tallyCollabReactions(reactions).map(t => [t.emoji, t.count])).toEqual([
      ['👍', 2],
      ['👀', 1],
    ])
  })

  it('answers whether a given actor is in a group', () => {
    const reactions: CollabReactionLike[] = [{ emoji: '👍', by: [{ type: 'user' }] }]
    expect(hasCollabReactionFrom(reactions, '👍', USER)).toBe(true)
    expect(hasCollabReactionFrom(reactions, '👍', LI)).toBe(false)
    expect(hasCollabReactionFrom(reactions, '🎉', USER)).toBe(false)
    expect(hasCollabReactionFrom(undefined, '👍', USER)).toBe(false)
  })
})

describe('formatCollabReactionSummary', () => {
  it('renders ×N for multiple reactors and the bare emoji for one', () => {
    expect(formatCollabReactionSummary([
      { emoji: '👍', by: [{ type: 'user' }, { type: 'agent', agentId: 'a1' }] },
      { emoji: '🎉', by: [{ type: 'agent', agentId: 'a2' }] },
    ])).toBe('(👍×2 🎉)')
  })

  it('is empty for no reactions and for groups nobody is in', () => {
    expect(formatCollabReactionSummary(undefined)).toBe('')
    expect(formatCollabReactionSummary([])).toBe('')
    expect(formatCollabReactionSummary([{ emoji: '👍', by: [] }])).toBe('')
  })

  it('caps how many distinct emoji reach the model', () => {
    const many = COLLAB_REACTION_EMOJIS.concat(['👍']).map(emoji => ({
      emoji,
      by: [{ type: 'user' as const }],
    }))
    const summary = formatCollabReactionSummary(many)
    expect(summary.slice(1, -1).split(' ')).toHaveLength(COLLAB_REACTION_EMOJIS.length)
  })

  it('appends to a speech block only when there is something to append', () => {
    expect(appendCollabReactionSummary('用户: 上线了', [
      { emoji: '🎉', by: [{ type: 'agent', agentId: 'a1' }, { type: 'agent', agentId: 'a2' }] },
    ])).toBe('用户: 上线了 (🎉×2)')
    expect(appendCollabReactionSummary('用户: 上线了', undefined)).toBe('用户: 上线了')
  })
})
