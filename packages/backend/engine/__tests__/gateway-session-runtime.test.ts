import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  sessions: new Map<string, { id: string; name: string }>(),
  currentSessionId: 'regular-session',
  createSession: vi.fn((id: string, name: string) => {
    const session = { id, name }
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

vi.mock('../stream-engine-runtime.js', () => ({
  createMainStreamEngineRuntime: vi.fn(() => ({})),
}))

vi.mock('../stream-engine.js', () => ({
  StreamEngine: class {
    setEventBus(): void {}
    shutdown(): void {}
  },
}))

vi.mock('../../events/index.js', () => ({
  getEventBus: vi.fn(() => ({})),
  getStreamChannel: vi.fn(() => ({
    subscribe: vi.fn(() => vi.fn()),
  })),
}))

vi.mock('../../session/index.js', () => ({
  getSessionManager: vi.fn(() => ({
    getOrCreate: mocks.getOrCreate,
    destroySession: mocks.destroySession,
  })),
}))

vi.mock('../../store.js', () => ({
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
    const {
      getConversationRuntime,
      initializeStreamEngine,
      shutdownStreamEngine,
    } = await import('../index.js')

    initializeStreamEngine()
    getConversationRuntime().ensureSession('gateway:wechat:user@im.wechat')

    expect(mocks.createSession).toHaveBeenCalledWith(
      'gateway:wechat:user@im.wechat',
      'WeChat - user@im.wechat',
    )
    expect(mocks.setCurrentSessionId).toHaveBeenCalledWith('regular-session')
    expect(mocks.getOrCreate).toHaveBeenCalledWith('gateway:wechat:user@im.wechat')
    expect(mocks.currentSessionId).toBe('regular-session')

    shutdownStreamEngine()
  })

  it('does not create duplicate persistent sessions for existing gateway conversations', async () => {
    mocks.sessions.set('gateway:wechat:user@im.wechat', {
      id: 'gateway:wechat:user@im.wechat',
      name: 'WeChat - user@im.wechat',
    })
    const {
      getConversationRuntime,
      initializeStreamEngine,
      shutdownStreamEngine,
    } = await import('../index.js')

    initializeStreamEngine()
    getConversationRuntime().ensureSession('gateway:wechat:user@im.wechat')

    expect(mocks.createSession).not.toHaveBeenCalled()
    expect(mocks.setCurrentSessionId).not.toHaveBeenCalled()
    expect(mocks.getOrCreate).toHaveBeenCalledWith('gateway:wechat:user@im.wechat')

    shutdownStreamEngine()
  })
})
