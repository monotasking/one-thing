/**
 * R3 — the message classifier (债4).
 *
 * Six markers × two fields is twelve ways to be told apart, and every predicate
 * used to implement that matrix for itself. The duplication has already cost a
 * real incident: the engine copies a drive command's envelope onto the message
 * it persists, so a consumer that read only `message.source` and not
 * `message.origin.source` mistook a turn record for a drive.
 *
 * This file is the matrix, once — it is what makes the delegation in types.ts /
 * say.ts / system-lines.ts safe to trust.
 */
import { describe, expect, it } from 'vitest'
import {
  COLLAB_HARVEST_SOURCE,
  COLLAB_MESSAGE_SOURCE,
  COLLAB_SAY_SOURCE,
  COLLAB_SYSTEM_SOURCE_MEMBERSHIP,
  COLLAB_SYSTEM_SOURCE_TASK,
  COLLAB_TURN_SOURCE,
  classifyCollabRoomMessage,
  isCollabDriveMessage,
  isCollabHarvestMessage,
  isCollabProjectedSystemLine,
  isCollabSayMessage,
  isCollabThinkingMessage,
  type CollabRoomMessageKind,
} from '../classify.js'

/** role + marker → the kind it must classify as, on EITHER field. */
const MATRIX: Array<{ role: string; marker: string; kind: CollabRoomMessageKind }> = [
  { role: 'user', marker: COLLAB_MESSAGE_SOURCE, kind: 'drive' },
  { role: 'assistant', marker: COLLAB_SAY_SOURCE, kind: 'say' },
  { role: 'assistant', marker: COLLAB_TURN_SOURCE, kind: 'thinking' },
  { role: 'assistant', marker: COLLAB_HARVEST_SOURCE, kind: 'harvest' },
  { role: 'system', marker: COLLAB_SYSTEM_SOURCE_TASK, kind: 'task-line' },
  { role: 'system', marker: COLLAB_SYSTEM_SOURCE_MEMBERSHIP, kind: 'membership-line' },
]

describe('classifyCollabRoomMessage — 六标记 × 双字段', () => {
  it.each(MATRIX)('reads $marker off message.source ($kind)', ({ role, marker, kind }) => {
    expect(classifyCollabRoomMessage({ role, source: marker })).toBe(kind)
  })

  it.each(MATRIX)('reads $marker off origin.source too ($kind)', ({ role, marker, kind }) => {
    expect(classifyCollabRoomMessage({ role, origin: { source: marker } })).toBe(kind)
  })

  it('never lets a marker cross roles', () => {
    // A say marker on a user message is not speech; a drive marker on an
    // assistant message is not a drive.
    expect(classifyCollabRoomMessage({ role: 'user', source: COLLAB_SAY_SOURCE })).toBe('plain')
    expect(classifyCollabRoomMessage({ role: 'assistant', source: COLLAB_MESSAGE_SOURCE })).toBe('plain')
    expect(classifyCollabRoomMessage({ role: 'system', source: COLLAB_SAY_SOURCE })).toBe('operational-line')
  })

  it('falls back to plain for anything unmarked — markers are never a migration', () => {
    expect(classifyCollabRoomMessage({ role: 'user' })).toBe('plain')
    expect(classifyCollabRoomMessage({ role: 'assistant' })).toBe('plain')
    expect(classifyCollabRoomMessage({ role: 'assistant', source: 'text' })).toBe('plain')
  })

  it('calls an unmarked system message operational — display-only bookkeeping', () => {
    expect(classifyCollabRoomMessage({ role: 'system' })).toBe('operational-line')
    expect(classifyCollabRoomMessage({ role: 'system', source: COLLAB_MESSAGE_SOURCE }))
      .toBe('operational-line')
  })

  it('gives thinking precedence over say when both markers are present', () => {
    // The rule used to live implicitly in chain.ts's and projection.ts's
    // if-order. A mislabelled record must not count toward the chain or reach
    // the model.
    const both = { role: 'assistant', source: COLLAB_SAY_SOURCE, origin: { source: COLLAB_TURN_SOURCE } }
    expect(classifyCollabRoomMessage(both)).toBe('thinking')
    expect(isCollabSayMessage(both)).toBe(false)
    expect(isCollabThinkingMessage(both)).toBe(true)
  })
})

describe('classify — 事故回归:信封被复制到消息上', () => {
  it('classifies a turn record that inherited the drive envelope as thinking', () => {
    // The 事故 shape: the engine stamps the command's origin onto the message it
    // creates, so a turn record carries origin.source 'collab' — the drive's
    // marker — while its own marker sits on `source`. Reading either field in
    // isolation gets this wrong in one direction or the other.
    const turnRecord = {
      role: 'assistant',
      source: COLLAB_TURN_SOURCE,
      origin: { source: COLLAB_MESSAGE_SOURCE },
    }
    expect(classifyCollabRoomMessage(turnRecord)).toBe('thinking')
    expect(isCollabDriveMessage(turnRecord)).toBe(false)
  })

  it('still calls the drive itself a drive, envelope or not', () => {
    expect(isCollabDriveMessage({ role: 'user', origin: { source: COLLAB_MESSAGE_SOURCE } })).toBe(true)
    expect(isCollabDriveMessage({ role: 'user', source: COLLAB_MESSAGE_SOURCE })).toBe(true)
  })
})

describe('classify — 谓词与分类器同源', () => {
  it('projects exactly the two marked system-line kinds', () => {
    expect(isCollabProjectedSystemLine({ role: 'system', source: COLLAB_SYSTEM_SOURCE_TASK })).toBe(true)
    expect(isCollabProjectedSystemLine({ role: 'system', source: COLLAB_SYSTEM_SOURCE_MEMBERSHIP })).toBe(true)
    expect(isCollabProjectedSystemLine({ role: 'system' })).toBe(false)
    // A marked source on a non-system role is not a system line at all.
    expect(isCollabProjectedSystemLine({ role: 'assistant', source: COLLAB_SYSTEM_SOURCE_TASK })).toBe(false)
  })

  it('keeps harvest distinct from speech — it was posted, not said', () => {
    const harvest = { role: 'assistant', source: COLLAB_HARVEST_SOURCE }
    expect(isCollabHarvestMessage(harvest)).toBe(true)
    expect(isCollabSayMessage(harvest)).toBe(false)
    expect(isCollabThinkingMessage(harvest)).toBe(false)
  })
})
