/**
 * W13.2 — the gap rule that decides whether an agent reply earns a quote.
 *
 * The rule is the whole feature: quoting the line directly above you is IM
 * noise, quoting across an interruption is what a quote is FOR. These cases are
 * the matrix of "what came in between".
 */
import { describe, expect, it } from 'vitest'
import {
  COLLAB_HARVEST_SOURCE,
  COLLAB_MESSAGE_SOURCE,
  buildCollabReplyToSnapshot,
  condenseCollabReplyExcerpt,
  countCollabVisibleMessagesBetween,
  isCollabVisibleRoomMessage,
  shouldAttachCollabReplyTo,
  type CollabMessageLike,
} from '../index.js'

type Row = CollabMessageLike & { id: string }

const user = (id: string, content = '问题'): Row => ({ id, role: 'user', content })
const agent = (id: string, agentId: string, content = '回答'): Row =>
  ({ id, role: 'assistant', agentId, content })
const drive = (id: string): Row =>
  ({ id, role: 'user', content: '(小李 · 被 @ 激活)', source: COLLAB_MESSAGE_SOURCE })
const pass = (id: string, agentId: string): Row =>
  ({ id, role: 'assistant', agentId, content: '[pass]' })
const harvest = (id: string, agentId: string): Row =>
  ({ id, role: 'assistant', agentId, content: '【交付】…', source: COLLAB_HARVEST_SOURCE })
const systemLine = (id: string, content = '「卡」→ 小李 开始执行'): Row =>
  ({ id, role: 'system', content })

function gap(messages: Row[], triggerMessageId: string, replyMessageId: string): number {
  return countCollabVisibleMessagesBetween({ messages, triggerMessageId, replyMessageId })
}

function attaches(messages: Row[], triggerMessageId: string, replyMessageId: string): boolean {
  const reply = messages.find(message => message.id === replyMessageId)!
  return shouldAttachCollabReplyTo({ messages, triggerMessageId, replyMessageId, reply })
}

describe('isCollabVisibleRoomMessage', () => {
  it('hides drives and settled passes, shows speech, system lines and harvest posts', () => {
    expect(isCollabVisibleRoomMessage(drive('d'))).toBe(false)
    expect(isCollabVisibleRoomMessage(pass('p', 'fe'))).toBe(false)
    expect(isCollabVisibleRoomMessage(agent('a', 'fe'))).toBe(true)
    expect(isCollabVisibleRoomMessage(user('u'))).toBe(true)
    expect(isCollabVisibleRoomMessage(systemLine('s'))).toBe(true)
    // Worker reports DO occupy a row in the room — they read as normal speech.
    expect(isCollabVisibleRoomMessage(harvest('h', 'fe'))).toBe(true)
  })

  it('treats an empty/whitespace message as no row at all', () => {
    expect(isCollabVisibleRoomMessage({ role: 'assistant', content: '   ' })).toBe(false)
    expect(isCollabVisibleRoomMessage({ role: 'user', content: '' })).toBe(false)
  })
})

describe('countCollabVisibleMessagesBetween', () => {
  it('is 0 for an immediate reply, even with the drive sitting in between', () => {
    const rows = [user('u1'), drive('d1'), agent('a1', 'fe')]
    expect(gap(rows, 'u1', 'a1')).toBe(0)
  })

  it('counts real messages that landed in between', () => {
    const rows = [user('u1'), user('u2', '另说一句'), drive('d1'), agent('a1', 'fe')]
    expect(gap(rows, 'u1', 'a1')).toBe(1)
  })

  it('does not count hidden machinery as distance', () => {
    // Two drives and a pass turn: the room showed NOTHING between them.
    const rows = [user('u1'), drive('d1'), pass('p1', 'pm'), drive('d2'), agent('a1', 'fe')]
    expect(gap(rows, 'u1', 'a1')).toBe(0)
  })

  it('refuses pairs it cannot locate in order', () => {
    const rows = [user('u1'), agent('a1', 'fe')]
    expect(gap(rows, 'ghost', 'a1')).toBe(-1)
    expect(gap(rows, 'u1', 'ghost')).toBe(-1)
    expect(gap(rows, 'a1', 'u1')).toBe(-1) // reply BEFORE trigger
    expect(gap(rows, 'a1', 'a1')).toBe(-1)
    expect(countCollabVisibleMessagesBetween({ messages: rows, triggerMessageId: undefined, replyMessageId: 'a1' }))
      .toBe(-1)
  })
})

describe('shouldAttachCollabReplyTo', () => {
  it('attaches once at least one visible message came between', () => {
    const rows = [user('u1'), agent('a0', 'pm', '我先说两句'), drive('d1'), agent('a1', 'fe')]
    expect(attaches(rows, 'u1', 'a1')).toBe(true)
  })

  it('never attaches to the line directly above (IM noise)', () => {
    const rows = [user('u1'), drive('d1'), agent('a1', 'fe')]
    expect(attaches(rows, 'u1', 'a1')).toBe(false)
  })

  it('leaves an already-quoted reply alone', () => {
    const rows: Row[] = [
      user('u1'),
      user('u2', '另说一句'),
      { ...agent('a1', 'fe'), replyTo: { messageId: 'u2', authorLabel: '用户', excerpt: '另说一句' } },
    ]
    expect(attaches(rows, 'u1', 'a1')).toBe(false)
  })

  it('never decorates a pass turn or an empty reply', () => {
    const rows = [user('u1'), user('u2', '另说一句'), pass('p1', 'fe')]
    expect(attaches(rows, 'u1', 'p1')).toBe(false)
    const blank: Row[] = [user('u1'), user('u2', 'x'), { id: 'a1', role: 'assistant', agentId: 'fe', content: '' }]
    expect(attaches(blank, 'u1', 'a1')).toBe(false)
  })

  it('a worker report in between IS distance', () => {
    const rows = [user('u1'), harvest('h1', 'pm'), drive('d1'), agent('a1', 'fe')]
    expect(attaches(rows, 'u1', 'a1')).toBe(true)
  })
})

describe('buildCollabReplyToSnapshot', () => {
  it('flattens, truncates at 120 chars and falls back to 成员', () => {
    expect(condenseCollabReplyExcerpt(' 先做\n\n接口 ')).toBe('先做 接口')
    const long = 'a'.repeat(200)
    expect(buildCollabReplyToSnapshot({ messageId: 'm1', content: long })).toEqual({
      messageId: 'm1',
      authorLabel: '成员',
      excerpt: `${'a'.repeat(120)}…`,
    })
  })

  it('returns null when there is nothing worth quoting', () => {
    expect(buildCollabReplyToSnapshot({ messageId: '', content: 'x' })).toBeNull()
    expect(buildCollabReplyToSnapshot({ messageId: 'm1', content: '   ' })).toBeNull()
  })
})
