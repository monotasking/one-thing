import { describe, expect, it } from 'vitest'
import { EventBus } from '../../events/event-bus.js'
import { createSessionAccess } from '../access.js'
import { canReceiveSessionRemoval, withSessionRemovalOwner } from '../removal-event.js'

describe('trusted removal notifications', () => {
  it('delivers deletion to the captured owner through the real event bus after metadata is gone', async () => {
    const bus = new EventBus()
    const alice = { userId: 'alice', workspaceId: 'default' }
    const bob = { userId: 'bob', workspaceId: 'default' }
    const received: string[] = []
    bus.onAnySessionAny(envelope => {
      if (canReceiveSessionRemoval(alice, envelope.sessionId, envelope.event)) received.push('alice')
      if (canReceiveSessionRemoval(bob, envelope.sessionId, envelope.event)) received.push('bob')
    })
    const event = withSessionRemovalOwner({ type: 'session:removed' as const, sessionId: 'gone' }, { ownerUserId: 'alice' })
    await bus.emit('gone', event as never)
    expect(received).toEqual(['alice'])
    expect(JSON.parse(JSON.stringify(event))).toEqual({ type: 'session:removed', sessionId: 'gone' })
    expect(canReceiveSessionRemoval(alice, 'gone', JSON.parse(JSON.stringify(event)))).toBe(false)
    expect(canReceiveSessionRemoval(alice, 'other', event)).toBe(false)
    expect(canReceiveSessionRemoval(alice, 'gone', { type: 'session:renamed' })).toBeUndefined()
    expect(() => createSessionAccess({ findMeta: () => undefined }).resolve(alice, 'gone', 'read')).toThrow('Session not found')
    bus.shutdown()
  })
})
