/**
 * W23 — collectConsumedSourceIds, the transcript-level idempotence ledger.
 *
 * The rule it encodes: a persisted DRIVE stamped with a room message id is
 * proof that message was already answered. Everything else in a transcript —
 * says, thinking records, human lines, system notices — is evidence of nothing.
 */
import { describe, expect, it } from 'vitest'
import { COLLAB_CONSUMED_SCAN_TAIL, collectConsumedSourceIds } from '../reconcile.js'
import { COLLAB_MESSAGE_SOURCE, type CollabMessageLike } from '../types.js'

function drive(sourceId?: string, overrides: Partial<CollabMessageLike> = {}): CollabMessageLike {
  return {
    role: 'user',
    content: '(小李 · 被点名)',
    source: COLLAB_MESSAGE_SOURCE,
    ...(sourceId ? { collabSourceMessageId: sourceId } : {}),
    ...overrides,
  }
}

describe('collectConsumedSourceIds', () => {
  it('collects the room message id off a stamped drive', () => {
    const consumed = collectConsumedSourceIds([drive('room-msg-1')])
    expect([...consumed]).toEqual(['room-msg-1'])
  })

  it('reads the stamp through the origin-only drive envelope', () => {
    // isCollabDriveMessage accepts either marker; the ledger must not care
    // which one the engine happened to stamp.
    const consumed = collectConsumedSourceIds([
      drive('room-msg-1', { source: 'text', origin: { source: COLLAB_MESSAGE_SOURCE } }),
    ])
    expect([...consumed]).toEqual(['room-msg-1'])
  })

  it('unions every drive in the window, one entry per message', () => {
    const consumed = collectConsumedSourceIds([
      drive('a'), drive('b'), drive('a'),
    ])
    expect([...consumed].sort()).toEqual(['a', 'b'])
  })

  it('returns nothing for a pre-W23 drive that carries no stamp', () => {
    // Compatibility position: old drives are silent, so their message replays
    // exactly once and self-heals.
    expect(collectConsumedSourceIds([drive(undefined)]).size).toBe(0)
  })

  it('ignores empty and non-string stamps', () => {
    const consumed = collectConsumedSourceIds([
      drive('', {}),
      { ...drive('x'), collabSourceMessageId: 42 as unknown as string },
    ])
    expect(consumed.size).toBe(0)
  })

  it('handles absent and empty transcripts', () => {
    expect(collectConsumedSourceIds(undefined).size).toBe(0)
    expect(collectConsumedSourceIds([]).size).toBe(0)
  })

  /**
   * 变异锁 — the drive test is what makes this a ledger rather than a grep. Drop
   * `isCollabDriveMessage` from the scan and these stop being ignored, and any
   * message that ever carries the field could retire a room message.
   */
  it('refuses the stamp on anything that is not a drive', () => {
    const notDrives: CollabMessageLike[] = [
      // A say that somehow carries the field: speech is not consumption.
      { role: 'assistant', content: '好的', source: 'collab-say', collabSourceMessageId: 'room-1' },
      // A turn record in the execution session.
      { role: 'assistant', content: '思考', source: 'collab-turn', collabSourceMessageId: 'room-1' },
      // A human line.
      { role: 'user', content: '再来一次', source: 'text', collabSourceMessageId: 'room-1' },
      // A system notice.
      { role: 'system', content: '「卡」已完成', source: 'collab-task', collabSourceMessageId: 'room-1' },
    ]
    expect(collectConsumedSourceIds(notDrives).size).toBe(0)
  })

  describe('tail window', () => {
    it('reads only the trailing N messages', () => {
      const messages = [
        drive('ancient'),
        ...Array.from({ length: COLLAB_CONSUMED_SCAN_TAIL }, () => drive('recent')),
      ]
      const consumed = collectConsumedSourceIds(messages)
      expect(consumed.has('recent')).toBe(true)
      expect(consumed.has('ancient')).toBe(false)
    })

    it('reads everything when the transcript is shorter than the window', () => {
      const consumed = collectConsumedSourceIds([drive('only')], COLLAB_CONSUMED_SCAN_TAIL)
      expect(consumed.has('only')).toBe(true)
    })

    it('takes an explicit window', () => {
      const consumed = collectConsumedSourceIds([drive('old'), drive('new')], 1)
      expect([...consumed]).toEqual(['new'])
    })
  })
})
