/**
 * Regression: goal-continuation send-message commands must bypass the
 * channel session router. Routing them resolves their `api` origin to an
 * anonymous channel identity, remaps the command into a freshly created
 * identity session (the continuation never reaches the goal's session) and
 * overwrites the session's memory-profile metadata.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  superHandleSendMessage: vi.fn(async () => {}),
  route: vi.fn(() => ({
    sessionId: 'identity:api:api:default:api-anonymous',
    origin: { transport: 'api', source: 'api', receivedAt: 1 },
  })),
}))

// P3'e A1:基类现在直接是 core 的 `CoreStreamEngine`(中间那层已并入)。
vi.mock('@onething/core/engine', async importOriginal => ({
  ...(await importOriginal<typeof import('@onething/core/engine')>()),
  CoreStreamEngine: class {
    constructor(_runtime: unknown) {
      void _runtime
    }

    async handleSendMessage(...args: unknown[]): Promise<void> {
      await mocks.superHandleSendMessage(...(args as []))
    }
  },
}))

const { ProductStreamEngine } = await import('../stream-engine.js')

// 路由是端口:桩直接注进去,不再 mock 装配层模块(P3'e-A2a)。
function engine() {
  return new ProductStreamEngine({} as never, { router: { route: mocks.route as never } })
}

const sender = {} as never

describe('ProductStreamEngine goal-continuation routing', () => {
  beforeEach(() => {
    mocks.superHandleSendMessage.mockClear()
    mocks.route.mockClear()
  })

  it('bypasses the channel router for goal-sourced commands', async () => {
    const command = {
      content: 'Continue working toward the active session goal.',
      channel: 'goal',
      source: 'goal',
      origin: { transport: 'api' as const, source: 'goal', receivedAt: 1 },
    }

    await engine().handleSendMessage('goal-session', command, sender)

    expect(mocks.route).not.toHaveBeenCalled()
    expect(mocks.superHandleSendMessage).toHaveBeenCalledTimes(1)
    const [sessionId, forwarded] = mocks.superHandleSendMessage.mock.calls[0] as unknown as [
      string,
      typeof command,
    ]
    expect(sessionId).toBe('goal-session')
    expect(forwarded.origin).toEqual({ transport: 'api', source: 'goal', receivedAt: 1 })
  })

  it('still routes ordinary commands through the channel router', async () => {
    await engine().handleSendMessage(
      'desktop-session',
      { content: 'hello' },
      sender,
    )

    expect(mocks.route).toHaveBeenCalledTimes(1)
    const [sessionId] = mocks.superHandleSendMessage.mock.calls[0] as unknown as [string]
    expect(sessionId).toBe('identity:api:api:default:api-anonymous')
  })
})
