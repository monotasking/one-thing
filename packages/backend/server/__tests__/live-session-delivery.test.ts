import { expect, it } from 'vitest'
import { EventBus, StreamChannel, type AgentEngineSessionEvent, type AgentEngineStreamChunk } from '@onething/core'
import { createTenantAudienceFactory, type SessionOwnershipRecord } from '../audience.js'
import { createServerLiveSessionDelivery } from '../live-session-delivery.js'

it('revokes both scoped and wildcard delivery on ownership changes and releases every subscription', async () => {
  const eventBus = new EventBus<AgentEngineSessionEvent>()
  const streamChannel = new StreamChannel<AgentEngineStreamChunk>()
  const rows = new Map<string, SessionOwnershipRecord>([['a', { ownerUserId: 'alice', ownerWorkspaceId: 'workspace' }]])
  const listeners = new Set<(id: string | undefined) => void>()
  const delivery = createServerLiveSessionDelivery({
    eventBus, streamChannel, defaultContext: () => ({ userId: 'alice', workspaceId: 'workspace' }),
    audienceFactory: createTenantAudienceFactory({
      findMeta: id => rows.get(id),
      onChanged: handler => { listeners.add(handler); return () => { listeners.delete(handler) } },
    }),
  })
  const scoped: unknown[] = [], wildcard: unknown[] = [], events: unknown[] = []
  const off = delivery.streams.subscribe('a', payload => scoped.push(payload))
  delivery.streams.subscribe('*', payload => wildcard.push(payload))
  delivery.events.subscribe('a', envelope => events.push(envelope))
  delivery.streams.subscribe('missing', () => { throw new Error('Denied stream received a chunk') })
  expect(listeners.size).toBe(3)
  const chunk = { type: 'text', text: 'visible' } as unknown as AgentEngineStreamChunk
  streamChannel.push('a', chunk)
  await eventBus.emit('a', { type: 'stream:complete' } as AgentEngineSessionEvent)
  expect([scoped.length, wildcard.length, events.length]).toEqual([1, 1, 1])
  rows.set('a', { ownerUserId: 'bob', ownerWorkspaceId: 'workspace' })
  for (const listener of listeners) listener('a')
  streamChannel.push('a', chunk)
  await eventBus.emit('a', { type: 'stream:complete' } as AgentEngineSessionEvent)
  expect([scoped.length, wildcard.length, events.length]).toEqual([1, 1, 1])
  delivery.dispose(); off(); delivery.dispose()
  expect(listeners.size).toBe(0)
  rows.set('a', { ownerUserId: 'alice', ownerWorkspaceId: 'workspace' })
  delivery.streams.subscribe('*', payload => wildcard.push(payload))
  streamChannel.push('a', chunk)
  await eventBus.emit('a', { type: 'stream:complete' } as AgentEngineSessionEvent)
  expect([scoped.length, wildcard.length, events.length]).toEqual([1, 1, 1])
  expect(listeners.size).toBe(0)
  streamChannel.shutdown()
  await eventBus.shutdown()
})
