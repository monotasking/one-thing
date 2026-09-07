import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  sessions: new Map<string, { id: string; name: string; ownerUserId?: string; ownerWorkspaceId?: string }>(),
  currentSessionId: 'regular-session',
  createSession: vi.fn((id: string, name: string, options: { initialOwner: { userId: string; workspaceId: string } }) => {
    const session = { id, name, ownerUserId: options.initialOwner.userId, ownerWorkspaceId: options.initialOwner.workspaceId }
    mocks.sessions.set(id, session)
    mocks.currentSessionId = id
    return session
  }),
  getSession: vi.fn((id: string) => mocks.sessions.get(id)),
  getCurrentSessionId: vi.fn(() => mocks.currentSessionId),
  setCurrentSessionId: vi.fn((id: string) => {
    mocks.currentSessionId = id
  }),
  getOrCreate: vi.fn(),
  destroySession: vi.fn(),
}))

vi.mock('../../../session/access.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../session/access.js')>()
  return { ...actual, sessionAccess: actual.createSessionAccess({ findMeta: id => mocks.sessions.get(id) }) }
})

vi.mock('../stream-engine-runtime.js', () => ({
  createMainStreamEngineRuntime: vi.fn(() => ({})),
}))

vi.mock('../stream-engine-bound.js', () => ({
  createBoundStreamEngine: () => ({
    setEventBus(): void {},
    shutdown(): void {},
  }),
}))

vi.mock('../../../events/index.js', () => ({
  getEventBus: vi.fn(() => ({})),
  getStreamChannel: vi.fn(() => ({
    subscribe: vi.fn(() => vi.fn()),
  })),
}))

vi.mock('../../../session/index.js', () => ({
  ensureSessionWritable: vi.fn(async () => undefined),
  getSessionManager: vi.fn(() => ({
    getOrCreate: mocks.getOrCreate,
    destroySession: mocks.destroySession,
  })),
}))

vi.mock('../../../store.js', () => ({
  getSession: mocks.getSession,
  createSession: mocks.createSession,
  getCurrentSessionId: mocks.getCurrentSessionId,
  setCurrentSessionId: mocks.setCurrentSessionId,
}))

describe('main gateway conversation runtime sessions', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.sessions.clear()
    mocks.currentSessionId = 'regular-session'
    mocks.createSession.mockClear()
    mocks.getSession.mockClear()
    mocks.getCurrentSessionId.mockClear()
    mocks.setCurrentSessionId.mockClear()
    mocks.getOrCreate.mockClear()
    mocks.destroySession.mockClear()
  })

  it('creates gateway conversations as persistent sessions without stealing the current session', async () => {
    const { getConversationRuntime, createStreamEngineLayer } = await import('../index.js')
    const { createBackendHandle, setCurrentBackend } = await import('../../../current.js')
    const { getEventBus, getStreamChannel } = await import('../../../events/index.js')

    // A2:引擎层是造出来的,产物装进进程当前实例槽 —— `getConversationRuntime()`
    // 读的就是那个槽。这份测试把事件系统整个 mock 成空对象,所以两件依赖直接
    // 从被 mock 的那两个 getter 拿。
    const layer = createStreamEngineLayer({
      eventBus: getEventBus(),
      streamChannel: getStreamChannel(),
    })
    setCurrentBackend(createBackendHandle({ engine: layer.engine, runtime: layer.runtime }))
    getConversationRuntime().ensureSession('gateway:wechat:user@im.wechat')

    expect(mocks.createSession).toHaveBeenCalledWith(
      'gateway:wechat:user@im.wechat',
      'WeChat - user@im.wechat',
      { initialOwner: { userId: 'local-user', workspaceId: 'default' } },
    )
    expect(mocks.setCurrentSessionId).toHaveBeenCalledWith('regular-session')
    expect(mocks.getOrCreate).toHaveBeenCalledWith('gateway:wechat:user@im.wechat')
    expect(mocks.currentSessionId).toBe('regular-session')

    await layer.dispose()
    setCurrentBackend(null)
  })

  it('does not create duplicate persistent sessions for existing gateway conversations', async () => {
    mocks.sessions.set('gateway:wechat:user@im.wechat', {
      id: 'gateway:wechat:user@im.wechat',
      name: 'WeChat - user@im.wechat',
    })
    const { getConversationRuntime, createStreamEngineLayer } = await import('../index.js')
    const { createBackendHandle, setCurrentBackend } = await import('../../../current.js')
    const { getEventBus, getStreamChannel } = await import('../../../events/index.js')

    // A2:引擎层是造出来的,产物装进进程当前实例槽 —— `getConversationRuntime()`
    // 读的就是那个槽。这份测试把事件系统整个 mock 成空对象,所以两件依赖直接
    // 从被 mock 的那两个 getter 拿。
    const layer = createStreamEngineLayer({
      eventBus: getEventBus(),
      streamChannel: getStreamChannel(),
    })
    setCurrentBackend(createBackendHandle({ engine: layer.engine, runtime: layer.runtime }))
    getConversationRuntime().ensureSession('gateway:wechat:user@im.wechat')

    expect(mocks.createSession).not.toHaveBeenCalled()
    expect(mocks.setCurrentSessionId).not.toHaveBeenCalled()
    expect(mocks.getOrCreate).toHaveBeenCalledWith('gateway:wechat:user@im.wechat')

    await layer.dispose()
    setCurrentBackend(null)
  })

  it('does not adopt an existing gateway session belonging to another product owner', async () => {
    const id = 'gateway:wechat:user@im.wechat'
    mocks.sessions.set(id, { id, name: 'Private', ownerUserId: 'alice', ownerWorkspaceId: 'tenant-a' })
    const { getConversationRuntime, createStreamEngineLayer } = await import('../index.js')
    const { createBackendHandle, setCurrentBackend } = await import('../../../current.js')
    const { getEventBus, getStreamChannel } = await import('../../../events/index.js')
    const layer = createStreamEngineLayer({ eventBus: getEventBus(), streamChannel: getStreamChannel() })
    setCurrentBackend(createBackendHandle({ engine: layer.engine, runtime: layer.runtime }))
    try {
      expect(() => getConversationRuntime().ensureSession(id)).toThrow('Session not found')
      expect(mocks.getOrCreate).not.toHaveBeenCalled()
      expect(mocks.createSession).not.toHaveBeenCalled()
    } finally {
      await layer.dispose()
      setCurrentBackend(null)
    }
  })
})
