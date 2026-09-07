import type {
  CorePermissionMode,
  CorePermissionRequestEvent,
  CorePermissionSurface,
} from '@onething/core/gateway-runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GatewayPermissionCoordinator } from '../permission-coordinator.js'

type PermissionResponse = Parameters<CorePermissionSurface['respondPermission']>[0]

class FakePermissionSurface implements CorePermissionSurface {
  readonly responses: PermissionResponse[] = []
  readonly modes: Array<{ sessionId: string; mode: CorePermissionMode }> = []
  private readonly handlers = new Map<string, Set<(req: CorePermissionRequestEvent) => void>>()

  onPermissionRequest(sessionId: string, handler: (req: CorePermissionRequestEvent) => void): () => void {
    const handlers = this.handlers.get(sessionId) ?? new Set()
    handlers.add(handler)
    this.handlers.set(sessionId, handlers)
    return () => {
      handlers.delete(handler)
    }
  }

  respondPermission = vi.fn(async (input: PermissionResponse) => {
    this.responses.push(input)
  })

  setSessionPermissionMode = vi.fn((sessionId: string, mode: CorePermissionMode) => {
    this.modes.push({ sessionId, mode })
  })

  emitRequest(
    sessionId: string,
    request: Partial<CorePermissionRequestEvent> & Pick<CorePermissionRequestEvent, 'requestId' | 'title'>,
  ): void {
    const fullRequest: CorePermissionRequestEvent = {
      sessionId,
      requestId: request.requestId,
      targetChannel: request.targetChannel ?? 'wechat',
      permissionType: request.permissionType ?? 'bash',
      title: request.title,
      toolCallId: request.toolCallId,
      pattern: request.pattern,
      metadata: request.metadata ?? {},
      timeoutMs: request.timeoutMs,
    }

    for (const handler of this.handlers.get(sessionId) ?? []) {
      handler(fullRequest)
    }
  }
}

describe('GatewayPermissionCoordinator', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('prompts for a permission request and echoes the target channel on approval', async () => {
    const permissions = new FakePermissionSurface()
    const sent: string[] = []
    const coordinator = new GatewayPermissionCoordinator({ permissions, timeoutMs: 300_000 })
    coordinator.watch({
      sessionId: 'session-1',
      channelId: 'wechat',
      userId: 'user-1',
      conversationId: 'user-1',
      sendText: async text => {
        sent.push(text)
      },
    })

    permissions.emitRequest('session-1', {
      requestId: 'request-1',
      targetChannel: 'wechat',
      title: '运行 bash',
    })
    await flushPromises()

    expect(sent[0]).toContain('AI 想执行：运行 bash')
    expect(sent[0]).toContain('5 分钟内未回复将自动拒绝')

    await expect(coordinator.tryHandleReply('wechat', 'user-1', 'user-1', '1')).resolves.toBe(true)

    expect(permissions.responses).toEqual([expect.objectContaining({
      sessionId: 'session-1',
      requestId: 'request-1',
      channel: 'wechat',
      decision: 'once',
    })])
    expect(sent).toContain('已允许一次。')
  })

  it.each([
    ['允许', 'once'],
    ['yes', 'once'],
    ['１', 'once'],
    ['2', 'session'],
    ['２', 'session'],
    ['本次会话', 'session'],
    ['3', 'reject'],
    ['３', 'reject'],
    ['no', 'reject'],
  ] as const)('maps reply "%s" to %s', async (reply, decision) => {
    const permissions = new FakePermissionSurface()
    const coordinator = new GatewayPermissionCoordinator({ permissions, timeoutMs: 300_000 })
    coordinator.watch({
      sessionId: 'session-1',
      channelId: 'wechat',
      userId: 'user-1',
      conversationId: 'user-1',
      sendText: async () => {},
    })

    permissions.emitRequest('session-1', {
      requestId: `request-${decision}`,
      targetChannel: 'wechat',
      title: '写文件',
    })
    await flushPromises()

    await expect(coordinator.tryHandleReply('wechat', 'user-1', 'user-1', reply)).resolves.toBe(true)

    expect(permissions.responses[0]).toMatchObject({
      requestId: `request-${decision}`,
      decision,
    })
  })

  it('consumes unrecognized replies and re-prompts without responding', async () => {
    const permissions = new FakePermissionSurface()
    const sent: string[] = []
    const coordinator = new GatewayPermissionCoordinator({ permissions, timeoutMs: 300_000 })
    coordinator.watch({
      sessionId: 'session-1',
      channelId: 'wechat',
      userId: 'user-1',
      conversationId: 'user-1',
      sendText: async text => {
        sent.push(text)
      },
    })

    permissions.emitRequest('session-1', {
      requestId: 'request-1',
      targetChannel: 'wechat',
      title: '执行命令',
    })
    await flushPromises()

    await expect(coordinator.tryHandleReply('wechat', 'user-1', 'user-1', 'maybe')).resolves.toBe(true)

    expect(permissions.responses).toEqual([])
    expect(sent.at(-1)).toBe('未能识别，请回复 1 / 2 / 3。')
  })

  it('rejects another user even when there is only one pending channel request', async () => {
    const permissions = new FakePermissionSurface()
    const sent: string[] = []
    const coordinator = new GatewayPermissionCoordinator({ permissions, timeoutMs: 300_000 })
    coordinator.watch({
      sessionId: 'session-1',
      channelId: 'wechat',
      userId: 'original-user',
      conversationId: 'original-user',
      sendText: async text => {
        sent.push(text)
      },
    })

    permissions.emitRequest('session-1', {
      requestId: 'request-1',
      targetChannel: 'wechat',
      title: '写文件',
    })
    await flushPromises()

    await expect(coordinator.tryHandleReply('wechat', 'reply-user', 'reply-user', '1')).resolves.toBe(true)
    expect(permissions.responses).toEqual([])
    expect(sent).not.toContain('已允许一次。')
    await expect(coordinator.tryHandleReply('wechat', 'original-user', 'original-user', '1')).resolves.toBe(true)

    expect(permissions.responses).toEqual([expect.objectContaining({
      requestId: 'request-1',
      channel: 'wechat',
      decision: 'once',
    })])
    expect(sent).toContain('已允许一次。')
  })

  it('does not use channel fallback when multiple users have pending requests', async () => {
    const permissions = new FakePermissionSurface()
    const coordinator = new GatewayPermissionCoordinator({ permissions, timeoutMs: 300_000 })
    coordinator.watch({
      sessionId: 'session-1',
      channelId: 'wechat',
      userId: 'user-1',
      conversationId: 'user-1',
      sendText: async () => {},
    })
    coordinator.watch({
      sessionId: 'session-2',
      channelId: 'wechat',
      userId: 'user-2',
      conversationId: 'user-2',
      sendText: async () => {},
    })

    permissions.emitRequest('session-1', {
      requestId: 'request-1',
      targetChannel: 'wechat',
      title: '第一个工具',
    })
    permissions.emitRequest('session-2', {
      requestId: 'request-2',
      targetChannel: 'wechat',
      title: '第二个工具',
    })
    await flushPromises()

    await expect(coordinator.tryHandleReply('wechat', 'other-user', 'other-user', '1')).resolves.toBe(true)

    expect(permissions.responses).toEqual([])
  })

  it.each(['pending', 'cancelled'] as const)('binds %s approval replies to channel, user and conversation', async state => {
    const permissions = new FakePermissionSurface()
    const sent: string[] = []
    const coordinator = new GatewayPermissionCoordinator({ permissions, timeoutMs: 300_000 })
    const unwatch = coordinator.watch({
      sessionId: 'session-1',
      channelId: 'wechat',
      userId: 'alice',
      conversationId: 'room-1',
      sendText: async text => { sent.push(text) },
    })
    permissions.emitRequest('session-1', { requestId: 'request-1', title: 'Write a file' })
    await flushPromises()
    if (state === 'cancelled') unwatch()
    await flushPromises()
    const before = [...sent]

    await coordinator.tryHandleReply('wechat', 'bob', 'room-1', '1')
    await coordinator.tryHandleReply('wechat', 'alice', 'room-2', '1')
    await coordinator.tryHandleReply('telegram', 'alice', 'room-1', '1')
    expect(permissions.responses).toEqual([])
    expect(sent).toEqual(before)

    await expect(coordinator.tryHandleReply('wechat', 'alice', 'room-1', '1')).resolves.toBe(true)
    expect(permissions.responses).toHaveLength(state === 'pending' ? 1 : 0)
    expect(sent).toHaveLength(before.length + 1)
    unwatch()
  })

  it('keeps simultaneous approvals by the same user in different rooms independent', async () => {
    const permissions = new FakePermissionSurface()
    const coordinator = new GatewayPermissionCoordinator({ permissions, timeoutMs: 300_000 })
    for (const room of ['room-1', 'room-2']) {
      coordinator.watch({
        sessionId: room,
        channelId: 'wechat',
        userId: 'alice',
        conversationId: room,
        sendText: async () => {},
      })
      permissions.emitRequest(room, { requestId: room, title: 'Write a file' })
    }
    await flushPromises()
    await coordinator.tryHandleReply('wechat', 'alice', 'room-2', '3')
    expect(permissions.responses).toEqual([expect.objectContaining({ requestId: 'room-2', decision: 'reject' })])
    await coordinator.tryHandleReply('wechat', 'alice', 'room-1', '1')
    expect(permissions.responses[1]).toMatchObject({ requestId: 'room-1', decision: 'once' })
  })

  it('rejects automatically when the approval times out', async () => {
    vi.useFakeTimers()
    const permissions = new FakePermissionSurface()
    const sent: string[] = []
    const coordinator = new GatewayPermissionCoordinator({ permissions, timeoutMs: 1000 })
    coordinator.watch({
      sessionId: 'session-1',
      channelId: 'wechat',
      userId: 'user-1',
      conversationId: 'user-1',
      sendText: async text => {
        sent.push(text)
      },
    })

    permissions.emitRequest('session-1', {
      requestId: 'request-1',
      targetChannel: 'wechat',
      title: '执行命令',
    })
    await flushPromises()

    expect(sent[0]).toContain('1 秒内未回复将自动拒绝')
    await vi.advanceTimersByTimeAsync(1000)

    expect(permissions.responses).toEqual([expect.objectContaining({
      requestId: 'request-1',
      channel: 'wechat',
      decision: 'reject',
      rejectReason: '审批超时自动拒绝',
    })])
    expect(sent).toContain('审批超时，已自动拒绝。')

    await expect(coordinator.tryHandleReply('wechat', 'user-1', 'user-1', '1')).resolves.toBe(true)
    expect(permissions.responses).toHaveLength(1)
    expect(sent).toContain('审批已过期，请重新发送请求。')
  })

  it('removes pending requests when a watch is cleaned up and consumes late approval replies', async () => {
    vi.useFakeTimers()
    const permissions = new FakePermissionSurface()
    const sent: string[] = []
    const coordinator = new GatewayPermissionCoordinator({ permissions, timeoutMs: 300_000 })
    const unwatch = coordinator.watch({
      sessionId: 'session-1',
      channelId: 'wechat',
      userId: 'user-1',
      conversationId: 'user-1',
      sendText: async text => {
        sent.push(text)
      },
    })

    permissions.emitRequest('session-1', {
      requestId: 'request-1',
      targetChannel: 'wechat',
      title: '写文件',
    })
    await flushPromises()

    unwatch()
    await flushPromises()

    expect(permissions.responses).toEqual([])
    expect(sent).toContain('审批已失效，请重新发送请求。')

    await expect(coordinator.tryHandleReply('wechat', 'user-1', 'user-1', '1')).resolves.toBe(true)
    expect(permissions.responses).toEqual([])
    expect(sent.filter(text => text === '审批已失效，请重新发送请求。')).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(60_001)
    await expect(coordinator.tryHandleReply('wechat', 'user-1', 'user-1', '1')).resolves.toBe(false)
  })

  it('processes multiple pending requests in FIFO order for one chat', async () => {
    const permissions = new FakePermissionSurface()
    const sent: string[] = []
    const coordinator = new GatewayPermissionCoordinator({ permissions, timeoutMs: 300_000 })
    coordinator.watch({
      sessionId: 'session-1',
      channelId: 'wechat',
      userId: 'user-1',
      conversationId: 'user-1',
      sendText: async text => {
        sent.push(text)
      },
    })

    permissions.emitRequest('session-1', {
      requestId: 'request-1',
      targetChannel: 'wechat',
      title: '第一个工具',
    })
    permissions.emitRequest('session-1', {
      requestId: 'request-2',
      targetChannel: 'wechat',
      title: '第二个工具',
    })
    await flushPromises()

    expect(sent.filter(text => text.startsWith('AI 想执行'))).toHaveLength(1)
    expect(sent[0]).toContain('第一个工具')

    await coordinator.tryHandleReply('wechat', 'user-1', 'user-1', '1')
    await flushPromises()

    expect(sent.filter(text => text.startsWith('AI 想执行'))).toHaveLength(2)
    expect(sent.at(-1)).toContain('第二个工具')

    await coordinator.tryHandleReply('wechat', 'user-1', 'user-1', '3')

    expect(permissions.responses.map(response => [response.requestId, response.decision])).toEqual([
      ['request-1', 'once'],
      ['request-2', 'reject'],
    ])
  })
})

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
