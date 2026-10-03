import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  Permission,
  type PermissionBusEvent,
  type PermissionCommandEnvelope,
  type PermissionEventBusLike,
} from '../permission-asks.js'

interface EmittedEvent {
  sessionId: string
  event: PermissionBusEvent
}

/**
 * Bus harness that also captures the command:permission-respond subscription
 * so tests can dispatch respond commands the way the EventBus would.
 */
function createCommandBus(emitted: EmittedEvent[]) {
  const handlers = new Map<string, (envelope: PermissionCommandEnvelope) => void>()
  const bus: PermissionEventBusLike = {
    onAnySession: (eventType, handler) => {
      handlers.set(eventType, handler)
      return () => handlers.delete(eventType)
    },
    emit: async (sessionId, event) => {
      emitted.push({ sessionId, event })
    },
  }
  return {
    bus,
    respond(sessionId: string, event: Record<string, unknown>) {
      handlers.get('command:permission-respond')?.({ sessionId, event })
    },
  }
}

async function settled(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

let sessionCounter = 0

describe('Permission respond by toolCallId', () => {
  const emitted: EmittedEvent[] = []
  let sessionId = ''
  let harness: ReturnType<typeof createCommandBus>

  beforeEach(() => {
    emitted.length = 0
    sessionId = `respond-by-call-${++sessionCounter}`
    harness = createCommandBus(emitted)
    Permission.initialize(harness.bus, () => 'ipc')
  })

  afterEach(() => {
    Permission.clearSession(sessionId)
    Permission.shutdown()
  })

  function ask(pattern: string, callId: string, metadata: Record<string, unknown> = {}) {
    return Permission.ask({
      type: 'bash',
      title: `run ${pattern}`,
      pattern,
      callId,
      sessionId,
      messageId: 'message-1',
      metadata: metadata as never,
    })
  }

  it('resolves the emitted prompt via toolCallId without a requestId', async () => {
    const pending = ask('cmd-1', 'call-1')
    await settled()

    harness.respond(sessionId, { decision: 'once', toolCallId: 'call-1' })
    await expect(pending).resolves.toBe('once')
    expect(Permission.getPending(sessionId)).toHaveLength(0)
  })

  it('resolves head and followers via a coalesced follower toolCallId', async () => {
    const head = ask('same-cmd', 'call-head')
    const follower = ask('same-cmd', 'call-follower')
    await settled()

    // Single prompt emitted; the follower coalesced into it.
    const requests = emitted.filter(e => e.event.type === 'permission:request')
    expect(requests).toHaveLength(1)

    harness.respond(sessionId, { decision: 'once', toolCallId: 'call-follower' })
    await expect(head).resolves.toBe('once')
    await expect(follower).resolves.toBe('once')
  })

  it('rejects via toolCallId with a reason', async () => {
    const pending = ask('cmd-1', 'call-1')
    await settled()

    harness.respond(sessionId, {
      decision: 'reject',
      toolCallId: 'call-1',
      rejectReason: 'not now',
    })
    await expect(pending).rejects.toThrow('not now')
  })

  it('ignores responses addressed to a queued (never-emitted) prompt', async () => {
    const head = ask('cmd-1', 'call-1')
    const queued = ask('cmd-2', 'call-2')
    await settled()

    // call-2 sits behind call-1 in the prompt queue: never shown, not respondable.
    harness.respond(sessionId, { decision: 'once', toolCallId: 'call-2' })
    await settled()
    expect(Permission.getPending(sessionId)).toHaveLength(1)

    // The head is still respondable and promotes the queued one afterwards.
    harness.respond(sessionId, { decision: 'once', toolCallId: 'call-1' })
    await expect(head).resolves.toBe('once')
    await settled()
    harness.respond(sessionId, { decision: 'once', toolCallId: 'call-2' })
    await expect(queued).resolves.toBe('once')
  })

  it('prefers requestId when both keys are present', async () => {
    const pending = ask('cmd-1', 'call-1')
    await settled()
    const request = emitted.find(e => e.event.type === 'permission:request')!.event as
      Extract<PermissionBusEvent, { type: 'permission:request' }>

    harness.respond(sessionId, {
      decision: 'once',
      requestId: request.requestId,
      toolCallId: 'call-1',
    })
    await expect(pending).resolves.toBe('once')
  })

  it('still validates channel affinity for toolCallId responses', async () => {
    Permission.shutdown()
    Permission.initialize(harness.bus, () => 'telegram')

    const pending = ask('cmd-1', 'call-1')
    await settled()

    // An ipc response must not settle a telegram-targeted prompt.
    harness.respond(sessionId, { decision: 'once', toolCallId: 'call-1', channel: 'ipc' })
    await settled()
    expect(Permission.getPending(sessionId)).toHaveLength(1)

    harness.respond(sessionId, { decision: 'once', toolCallId: 'call-1', channel: 'telegram' })
    await expect(pending).resolves.toBe('once')
  })
})

describe('Permission.getPendingPrompts', () => {
  const emitted: EmittedEvent[] = []
  let sessionId = ''
  let harness: ReturnType<typeof createCommandBus>

  beforeEach(() => {
    emitted.length = 0
    sessionId = `pending-prompts-${++sessionCounter}`
    harness = createCommandBus(emitted)
    Permission.initialize(harness.bus, () => 'ipc')
  })

  afterEach(() => {
    Permission.clearSession(sessionId)
    Permission.shutdown()
  })

  function ask(pattern: string, callId: string) {
    return Permission.ask({
      type: 'bash',
      title: `run ${pattern}`,
      pattern,
      callId,
      sessionId,
      messageId: 'message-1',
      metadata: {} as never,
    })
  }

  it('labels emitted head, queued prompt, and coalesced follower per callId', async () => {
    const head = ask('cmd-1', 'call-head')
    const follower = ask('cmd-1', 'call-follower')
    const queued = ask('cmd-2', 'call-queued')
    await settled()

    const prompts = Permission.getPendingPrompts(sessionId)
    const byCallId = new Map(prompts.map(p => [p.callId, p.promptState]))
    expect(byCallId.get('call-head')).toBe('actionable')
    expect(byCallId.get('call-follower')).toBe('queued')
    expect(byCallId.get('call-queued')).toBe('queued')

    // getPending keeps its visible-prompts-only contract.
    expect(Permission.getPending(sessionId)).toHaveLength(1)

    harness.respond(sessionId, { decision: 'once', toolCallId: 'call-head' })
    await expect(head).resolves.toBe('once')
    await expect(follower).resolves.toBe('once')
    await settled()
    harness.respond(sessionId, { decision: 'once', toolCallId: 'call-queued' })
    await expect(queued).resolves.toBe('once')
  })
})
