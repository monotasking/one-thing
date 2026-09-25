import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Permission, type PermissionBusEvent, type PermissionEventBusLike } from '../index.js'

interface EmittedEvent {
  sessionId: string
  event: PermissionBusEvent
}

function createBus(emitted: EmittedEvent[]): PermissionEventBusLike {
  return {
    onAnySession: () => () => {},
    emit: async (sessionId, event) => {
      emitted.push({ sessionId, event })
    },
  }
}

async function settled(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

let sessionCounter = 0

describe('Permission.ask serialization and coalescing', () => {
  const emitted: EmittedEvent[] = []
  let sessionId = ''

  beforeEach(() => {
    emitted.length = 0
    sessionId = `ask-serialization-${++sessionCounter}`
    Permission.initialize(createBus(emitted), () => 'ipc')
  })

  afterEach(() => {
    Permission.clearSession(sessionId)
    Permission.shutdown()
  })

  function ofType<TType extends PermissionBusEvent['type']>(type: TType) {
    return emitted
      .map(item => item.event)
      .filter((event): event is Extract<PermissionBusEvent, { type: TType }> => event.type === type)
  }

  function ask(pattern: string, callId?: string, type = 'bash', metadata: Record<string, unknown> = {}) {
    return Permission.ask({
      type,
      title: `run ${pattern}`,
      pattern,
      callId,
      sessionId,
      messageId: 'message-1',
      metadata: metadata as never,
    })
  }

  it('emits only the head request; the next one goes out after the head settles', async () => {
    const first = ask('cmd-1')
    const second = ask('cmd-2')
    await settled()

    const requests = ofType('permission:request')
    expect(requests).toHaveLength(1)
    expect(requests[0].pattern).toBe('cmd-1')
    expect(Permission.getPending(sessionId)).toHaveLength(1)

    Permission.respond({ sessionId, permissionId: requests[0].requestId, response: 'once' })
    await expect(first).resolves.toBe('once')
    await settled()

    const requestsAfter = ofType('permission:request')
    expect(requestsAfter).toHaveLength(2)
    expect(requestsAfter[1].pattern).toBe('cmd-2')

    Permission.respond({ sessionId, permissionId: requestsAfter[1].requestId, response: 'once' })
    await expect(second).resolves.toBe('once')
  })

  it('coalesces equivalent concurrent asks into one prompt and settles both', async () => {
    const first = ask('same-cmd')
    const second = ask('same-cmd')
    await settled()

    expect(ofType('permission:request')).toHaveLength(1)

    Permission.respond({ sessionId, permissionId: ofType('permission:request')[0].requestId, response: 'once' })
    await expect(first).resolves.toBe('once')
    await expect(second).resolves.toBe('once')
    expect(ofType('permission:request')).toHaveLength(1)
  })

  it('rejecting a coalesced prompt rejects every follower', async () => {
    const outcomes: string[] = []
    const first = ask('same-cmd').then(() => outcomes.push('first:ok'), () => outcomes.push('first:rejected'))
    const second = ask('same-cmd').then(() => outcomes.push('second:ok'), () => outcomes.push('second:rejected'))
    await settled()

    Permission.respond({ sessionId, permissionId: ofType('permission:request')[0].requestId, response: 'reject' })
    await Promise.all([first, second])

    expect(outcomes.sort()).toEqual(['first:rejected', 'second:rejected'])
  })

  it('a session grant settles the head and its followers, then prompts the next distinct ask', async () => {
    const first = ask('cmd-1')
    // Equivalent ask: coalesced onto `first` instead of queued separately.
    const second = ask('cmd-1')
    // Distinct pattern: queued unemitted behind the head.
    const third = ask('cmd-2')
    await settled()

    expect(ofType('permission:request')).toHaveLength(1)

    // The session grant covers cmd-1 only; cmd-2 stays pending and becomes the
    // next prompt.
    Permission.respond({ sessionId, permissionId: ofType('permission:request')[0].requestId, response: 'session' })
    await expect(first).resolves.toBe('session')
    await expect(second).resolves.toBe('session')
    await settled()

    const requests = ofType('permission:request')
    expect(requests).toHaveLength(2)
    expect(requests[1].pattern).toBe('cmd-2')
    Permission.respond({ sessionId, permissionId: requests[1].requestId, response: 'once' })
    await expect(third).resolves.toBe('once')
  })

  it('getPending only reports emitted prompts', async () => {
    void ask('cmd-1').catch(() => {})
    void ask('cmd-2').catch(() => {})
    await settled()

    const pending = Permission.getPending(sessionId)
    expect(pending).toHaveLength(1)
    expect(pending[0].pattern).toBe('cmd-1')
  })

  it('does not coalesce asks that share a pattern but differ in metadata (different concrete commands)', async () => {
    const first = ask('rm *', 'call-1', 'bash', { command: 'rm -rf ./build' })
    const second = ask('rm *', 'call-2', 'bash', { command: 'rm -rf ./src' })
    await settled()

    // Same prefix pattern, different commands: the second must queue as its
    // own prompt, never ride the first approval.
    expect(ofType('permission:request')).toHaveLength(1)
    expect(Permission.getPending(sessionId)).toHaveLength(1)

    Permission.respond({ sessionId, permissionId: ofType('permission:request')[0].requestId, response: 'once' })
    await expect(first).resolves.toBe('once')
    await settled()

    const requests = ofType('permission:request')
    expect(requests).toHaveLength(2)
    Permission.respond({ sessionId, permissionId: requests[1].requestId, response: 'once' })
    await expect(second).resolves.toBe('once')
  })

  it('emits permission:queued for waiting asks and followers, and permission:settled with all tool call ids', async () => {
    const first = ask('cmd-1', 'call-head')
    const second = ask('cmd-1', 'call-follower')
    const third = ask('cmd-2', 'call-queued')
    await settled()

    const queued = ofType('permission:queued')
    expect(queued.map(event => event.toolCallId).sort()).toEqual(['call-follower', 'call-queued'])
    const headRequestId = ofType('permission:request')[0].requestId
    expect(queued.find(event => event.toolCallId === 'call-follower')?.requestId).toBe(headRequestId)

    Permission.respond({ sessionId, permissionId: headRequestId, response: 'once' })
    await expect(first).resolves.toBe('once')
    await expect(second).resolves.toBe('once')
    await settled()

    const settledEvents = ofType('permission:settled')
    expect(settledEvents).toHaveLength(1)
    expect(settledEvents[0].requestId).toBe(headRequestId)
    expect(settledEvents[0].decision).toBe('allowed')
    expect(settledEvents[0].toolCallIds.sort()).toEqual(['call-follower', 'call-head'])

    // cmd-2 becomes the next prompt after the head settles.
    const requests = ofType('permission:request')
    expect(requests).toHaveLength(2)
    Permission.respond({ sessionId, permissionId: requests[1].requestId, response: 'reject' })
    await expect(third).rejects.toThrow()

    const rejectedSettled = ofType('permission:settled').find(event => event.decision === 'rejected')
    expect(rejectedSettled?.toolCallIds).toEqual(['call-queued'])
  })
})
