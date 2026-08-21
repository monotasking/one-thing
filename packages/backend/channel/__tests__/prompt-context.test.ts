/**
 * Regression: goal-injected messages persist an identity-less origin
 * (transport 'api', source 'goal'). The communication-context provider must
 * skip them when resolving "who is the model talking to" — otherwise every
 * goal-driven run in a plain desktop session injects a developer block
 * claiming the model is talking to an unknown API user, "not to your owner".
 */
import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage, MessageOrigin } from '@shared/ipc.js'

vi.mock('../../engine/prompt/plugin-context.js', () => ({
  registerPromptContextProvider: vi.fn(() => vi.fn()),
}))

vi.mock('../../store.js', () => ({
  getSession: vi.fn(),
}))

const { __testing } = await import('../prompt-context.js')

function desktopOrigin(): MessageOrigin {
  return {
    transport: 'desktop',
    source: 'text',
    receivedAt: 1,
    resolvedIdentity: {
      kind: 'client-user',
      userId: 'local-owner',
      profileId: 'local-owner',
    },
  } as MessageOrigin
}

function goalOrigin(): MessageOrigin {
  return { transport: 'api', source: 'goal', receivedAt: 2 } as MessageOrigin
}

describe('communication prompt context and goal-injected origins', () => {
  it('latestOrigin skips goal-injected origins and returns the prior real origin', () => {
    const messages = [
      { id: 'm1', role: 'user', origin: desktopOrigin() },
      { id: 'm2', role: 'assistant' },
      { id: 'm3', role: 'user', origin: goalOrigin() },
      { id: 'm4', role: 'assistant', origin: goalOrigin() },
    ] as unknown as ChatMessage[]

    const origin = __testing.latestOrigin(messages)
    expect(origin?.transport).toBe('desktop')
    expect(origin?.source).toBe('text')
  })

  it('latestOrigin returns undefined when only goal origins exist', () => {
    const messages = [
      { id: 'm1', role: 'user', origin: goalOrigin() },
    ] as unknown as ChatMessage[]

    expect(__testing.latestOrigin(messages)).toBeUndefined()
  })

  it('buildCommunicationContext would misattribute a bare goal origin (why the skip matters)', () => {
    const content = __testing.buildCommunicationContext(goalOrigin())
    expect(content).toContain('not to your owner')
  })

  it('buildCommunicationContext stays silent for the desktop owner', () => {
    expect(__testing.buildCommunicationContext(desktopOrigin())).toBe('')
  })
})
