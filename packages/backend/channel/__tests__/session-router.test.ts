import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatSession, MessageOrigin } from '@shared/ipc.js'

const mocks = vi.hoisted(() => ({
  sessions: new Map<string, ChatSession>(),
  createSession: vi.fn((id: string, name: string) => {
    const session = {
      id,
      name,
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    } as ChatSession
    mocks.sessions.set(id, session)
    return session
  }),
  getSession: vi.fn((id: string) => mocks.sessions.get(id)),
  getCurrentSessionId: vi.fn(() => 'desktop-session'),
  setCurrentSessionId: vi.fn(),
  getOrCreate: vi.fn(),
  resolveOrigin: vi.fn((origin: MessageOrigin) => ({
    ...origin,
    resolvedIdentity: {
      kind: 'channel-user',
      userId: 'channel:wechat_default_user-1',
      profileId: 'channel-wechat-default-user-1',
      displayName: 'user-1',
      externalUserKey: 'wechat:default:user-1',
    },
  })),
  normalizeOrigin: vi.fn((origin: MessageOrigin) => origin),
}))

vi.mock('../../store.js', () => ({
  getSession: mocks.getSession,
  createSession: mocks.createSession,
  getCurrentSessionId: mocks.getCurrentSessionId,
  setCurrentSessionId: mocks.setCurrentSessionId,
}))

vi.mock('../../session/index.js', () => ({
  getSessionManager: () => ({
    getOrCreate: mocks.getOrCreate,
  }),
}))

vi.mock('../../logging/index.js', () => ({
  writeAppLog: vi.fn(),
}))

vi.mock('../identity-service.js', () => ({
  getChannelIdentityService: () => ({
    normalizeOrigin: mocks.normalizeOrigin,
    resolveOrigin: mocks.resolveOrigin,
  }),
}))

const { ChannelSessionRouter } = await import('../session-router.js')

function gatewayOrigin(): MessageOrigin {
  return {
    transport: 'im',
    source: 'gateway',
    actor: {
      externalUserId: 'user-1',
    },
    conversation: {
      connector: 'wechat',
      externalConversationId: 'user-1',
      type: 'dm',
    },
    replyTarget: {
      connector: 'wechat',
      externalConversationId: 'user-1',
    },
    receivedAt: 1,
  }
}

describe('ChannelSessionRouter', () => {
  beforeEach(() => {
    mocks.sessions.clear()
    mocks.createSession.mockClear()
    mocks.getSession.mockClear()
    mocks.getCurrentSessionId.mockClear()
    mocks.setCurrentSessionId.mockClear()
    mocks.getOrCreate.mockClear()
    mocks.resolveOrigin.mockClear()
    mocks.normalizeOrigin.mockClear()
  })

  it('preserves gateway session ids so the gateway stream subscription receives replies', () => {
    const session = {
      id: 'gateway:wechat:user-1',
      name: 'WeChat - user-1',
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    } as ChatSession
    mocks.sessions.set(session.id, session)

    const routed = new ChannelSessionRouter().route({
      sessionId: session.id,
      origin: gatewayOrigin(),
      preserveSessionId: true,
    })

    expect(routed.sessionId).toBe('gateway:wechat:user-1')
    expect(mocks.createSession).not.toHaveBeenCalled()
    expect(mocks.getOrCreate).toHaveBeenCalledWith('gateway:wechat:user-1')
    expect(session).toMatchObject({
      originIdentityKey: 'identity:im:wechat:default:channel:wechat_default_user-1',
      memoryProfileId: 'channel-wechat-default-user-1',
      lastConnector: 'wechat',
    })
    // memoryProfileId is the single routing key; the legacy scope field is no
    // longer written.
  })

  it('routes non-gateway IM messages to identity sessions', () => {
    const routed = new ChannelSessionRouter().route({
      sessionId: 'incoming-session',
      origin: {
        ...gatewayOrigin(),
        source: 'slack',
        conversation: {
          connector: 'slack',
          externalConversationId: 'user-1',
          type: 'dm',
        },
        replyTarget: {
          connector: 'slack',
          externalConversationId: 'user-1',
        },
      },
    })

    expect(routed.sessionId).toBe('identity:im:slack:default:channel:wechat_default_user-1')
    expect(mocks.createSession).toHaveBeenCalledWith(
      'identity:im:slack:default:channel:wechat_default_user-1',
      'slack - user-1',
    )
  })
})
