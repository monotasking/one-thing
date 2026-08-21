/**
 * W19 真实 typing — the wiring half.
 *
 * The tracker's rules are covered purely (src/collab/__tests__/typing.test.ts);
 * what only this test can make true is the plumbing around them:
 *  - it listens on the EXECUTION session (agent or work), not on the room;
 *  - it emits into the ROOM, so the room's typing line is the one that lights;
 *  - detaching unsubscribes AND forces the light out — no leaked bus handler,
 *    no name stuck typing after the window closed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  emitted: [] as Array<{ sessionId: string; event: Record<string, unknown> }>,
  listeners: [] as Array<{ sessionId: string; handler: (envelope: unknown) => void }>,
}))

vi.mock('../../events/index.js', () => ({
  getEventBus: () => ({
    emit: async (sessionId: string, event: Record<string, unknown>) => {
      mocks.emitted.push({ sessionId, event })
    },
    onAny: (sessionId: string, handler: (envelope: unknown) => void) => {
      const entry = { sessionId, handler }
      mocks.listeners.push(entry)
      return () => {
        mocks.listeners = mocks.listeners.filter(candidate => candidate !== entry)
      }
    },
  }),
}))

const { observeCollabSayTyping } = await import('../typing-observer.js')

const ROOM = 'room-1'
const EXEC = 'agent-exec-fe'

function deliver(sessionId: string, event: Record<string, unknown>): void {
  for (const entry of [...mocks.listeners]) {
    if (entry.sessionId === sessionId) entry.handler({ sessionId, event })
  }
}

function typingLog(): Array<{ sessionId: string; agentId: unknown; typing: unknown }> {
  return mocks.emitted
    .filter(entry => entry.event.type === 'collab:typing')
    .map(entry => ({
      sessionId: entry.sessionId,
      agentId: entry.event.agentId,
      typing: entry.event.typing,
    }))
}

beforeEach(() => {
  mocks.emitted.length = 0
  mocks.listeners = []
})

describe('W19 — observeCollabSayTyping', () => {
  it('watches the execution session and lights the ROOM', () => {
    const detach = observeCollabSayTyping({ sessionId: EXEC, roomSessionId: ROOM, agentId: 'fe' })
    expect(mocks.listeners.map(entry => entry.sessionId)).toEqual([EXEC])

    deliver(EXEC, { type: 'stream:start' })
    deliver(EXEC, { type: 'tool:input-start', toolCallId: 'c1', toolName: 'send_message' })
    deliver(EXEC, { type: 'tool:input-end', toolCallId: 'c1', toolCall: { toolId: 'send_message' } })
    detach()

    expect(typingLog()).toEqual([
      { sessionId: ROOM, agentId: 'fe', typing: true },
      { sessionId: ROOM, agentId: 'fe', typing: false },
    ])
  })

  it('ignores events from other sessions', () => {
    const detach = observeCollabSayTyping({ sessionId: EXEC, roomSessionId: ROOM, agentId: 'fe' })
    deliver('some-other-session', { type: 'tool:input-start', toolCallId: 'c1', toolName: 'send_message' })
    detach()
    expect(typingLog()).toEqual([])
  })

  it('detaching unsubscribes and forces the light out mid-arguments', () => {
    const detach = observeCollabSayTyping({ sessionId: EXEC, roomSessionId: ROOM, agentId: 'fe' })
    deliver(EXEC, { type: 'tool:input-start', toolCallId: 'c1', toolName: 'send_message' })
    detach()

    expect(mocks.listeners).toHaveLength(0)
    expect(typingLog().map(entry => entry.typing)).toEqual([true, false])

    // Idempotent: a second detach (finally + caller) emits nothing extra.
    detach()
    expect(typingLog()).toHaveLength(2)
  })

  it('emits nothing at all for a turn that never called say', () => {
    const detach = observeCollabSayTyping({ sessionId: EXEC, roomSessionId: ROOM, agentId: 'fe' })
    deliver(EXEC, { type: 'stream:start' })
    deliver(EXEC, { type: 'tool:input-start', toolCallId: 'c1', toolName: 'board' })
    deliver(EXEC, { type: 'tool:input-end', toolCallId: 'c1', toolCall: { toolId: 'board' } })
    deliver(EXEC, { type: 'stream:complete' })
    detach()
    expect(mocks.emitted).toEqual([])
  })
})
