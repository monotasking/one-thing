import type {
  CoreConversationRuntime,
  CorePermissionMode,
  CorePermissionRequestEvent,
  CorePermissionSurface,
  CoreTextStreamChunk,
} from '@onething/core/gateway-runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Channel, InboundMessage, OutboundMessage, TypingMessage } from '../channel.js'
import { LoggerRoot, type LogRecord, type LogSink } from '@onething/core/logging'
import { GatewayBridge, type GatewayCommandProvider } from '../bridge.js'
import { Allowlist } from '../middleware/allowlist.js'
import { RateLimiter } from '../middleware/rate-limiter.js'
import { GatewaySessionRegistry } from '../session-registry.js'

/**
 * L2:bridge 的失败留痕现在走**构造时注入的 logger**,不再是 console。
 * 断言因此落在捕获 sink 上 —— 记录形状(msg + fields + err)本身就是契约。
 */
function createCaptureLogger(): { logger: ReturnType<LoggerRoot['logger']>; records: LogRecord[] } {
  const records: LogRecord[] = []
  const sink: LogSink = { write: record => { records.push(record) } }
  const root = new LoggerRoot({ level: 'trace', sinks: [sink], src: 'gateway' })
  return { logger: root.logger('gateway.bridge'), records }
}

class MockChannel implements Channel {
  readonly id: string
  readonly sent: OutboundMessage[] = []
  readonly sendAttempts: OutboundMessage[] = []
  readonly typingSignals: TypingMessage[] = []
  failSendAtCall?: number
  private handler: ((msg: InboundMessage) => Promise<void>) | null = null

  constructor(id = 'mock') {
    this.id = id
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async send(msg: OutboundMessage): Promise<void> {
    const callIndex = this.sendAttempts.length
    this.sendAttempts.push(msg)
    if (this.failSendAtCall === callIndex) {
      throw new Error('sendmessage ret=-2')
    }
    this.sent.push(msg)
  }

  async typing(msg: TypingMessage): Promise<void> {
    this.typingSignals.push(msg)
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.handler = handler
  }

  async emit(msg: InboundMessage): Promise<void> {
    await this.handler?.(msg)
  }
}

class MockStreamChannel {
  private readonly handlers = new Map<string, Set<(chunk: CoreTextStreamChunk) => void>>()

  subscribe(sessionId: string, handler: (chunk: CoreTextStreamChunk) => void): () => void {
    let handlers = this.handlers.get(sessionId)
    if (!handlers) {
      handlers = new Set()
      this.handlers.set(sessionId, handlers)
    }
    handlers.add(handler)
    return () => {
      handlers?.delete(handler)
    }
  }

  push(sessionId: string, chunk: CoreTextStreamChunk): void {
    for (const handler of this.handlers.get(sessionId) ?? []) {
      handler(chunk)
    }
  }
}

type MockSendMessageOptions = { sessionId: string; content: string; channel?: string; source?: string }
type MockResponder = (runtime: MockRuntime, options: MockSendMessageOptions) => Promise<void> | void
type PermissionResponse = Parameters<CorePermissionSurface['respondPermission']>[0]

class MockPermissionSurface implements CorePermissionSurface {
  readonly responses: PermissionResponse[] = []
  readonly modes: Array<{ sessionId: string; mode: CorePermissionMode }> = []
  onRespond?: (input: PermissionResponse) => void
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
    this.onRespond?.(input)
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
      targetChannel: request.targetChannel ?? 'mock',
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

class MockRuntime implements CoreConversationRuntime<CoreTextStreamChunk> {
  readonly streamChannel = new MockStreamChannel()
  readonly ensureSession = vi.fn()
  readonly destroySession = vi.fn()
  readonly messages: MockSendMessageOptions[] = []
  readonly permissions?: MockPermissionSurface

  constructor(private readonly responder?: MockResponder, permissions?: MockPermissionSurface) {
    this.permissions = permissions
  }

  async sendMessage(options: MockSendMessageOptions): Promise<void> {
    this.messages.push(options)
    if (this.responder) {
      await this.responder(this, options)
      return
    }
    this.pushText(options.sessionId, `Echo: ${options.content}`)
  }

  pushText(sessionId: string, text: string): void {
    this.streamChannel.push(sessionId, {
      type: 'text-delta',
      text,
    })
  }
}

describe('GatewayBridge', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('sends typing as an explicit channel signal, not an empty text message', async () => {
    const runtime = new MockRuntime()
    const channel = new MockChannel()
    const raw = { from_user_id: 'user-1', context_token: 'token-1' }
    const bridge = new GatewayBridge({
      allowlist: new Allowlist({ mode: 'open' }),
      rateLimiter: new RateLimiter({ maxPerMinute: 10 }),
      registry: new GatewaySessionRegistry(runtime),
      runtime,
    })
    bridge.register(channel)

    await bridge.handle({
      channelId: 'mock',
      userId: 'user-1',
      conversationId: 'user-1',
      text: 'hello',
      raw,
    })

    expect(channel.typingSignals).toEqual([
      { conversationId: 'user-1', userId: 'user-1', raw },
      { conversationId: 'user-1', userId: 'user-1', raw, status: 'cancel' },
    ])
    expect(channel.sent).toEqual([{ conversationId: 'user-1', userId: 'user-1', text: 'Echo: hello', raw }])
    expect(channel.sent.every(msg => msg.text.trim().length > 0)).toBe(true)
  })

  it('forwards permission requests to the channel and consumes approval replies', async () => {
    const permissions = new MockPermissionSurface()
    let allowPermission!: () => void
    const permissionAllowed = new Promise<void>(resolve => {
      allowPermission = resolve
    })
    permissions.onRespond = () => {
      allowPermission()
    }
    const runtime = new MockRuntime(async (mockRuntime, options) => {
      permissions.emitRequest(options.sessionId, {
        requestId: 'request-1',
        targetChannel: 'mock',
        title: '运行 bash',
      })
      await permissionAllowed
      mockRuntime.pushText(options.sessionId, '工具完成')
    }, permissions)
    const channel = new MockChannel()
    const raw = { from_user_id: 'user-1', context_token: 'token-1' }
    const bridge = new GatewayBridge({
      allowlist: new Allowlist({ mode: 'open' }),
      rateLimiter: new RateLimiter({ maxPerMinute: 1 }),
      registry: new GatewaySessionRegistry(runtime),
      runtime,
      permissionConfig: { mode: 'remote-approval', timeoutMs: 300_000 },
    })
    bridge.register(channel)

    const handlePromise = bridge.handle({
      channelId: 'mock',
      userId: 'user-1',
      conversationId: 'user-1',
      text: '需要工具',
      raw,
    })
    await waitForCall(() => channel.sent.some(message => message.text.includes('AI 想执行：运行 bash')))

    expect(channel.sent[0]?.text).toContain('AI 想执行：运行 bash')

    await bridge.handle({
      channelId: 'mock',
      userId: 'user-1',
      conversationId: 'user-1',
      text: '1',
      raw,
    })
    await handlePromise

    expect(runtime.messages.map(message => message.content)).toEqual(['需要工具'])
    expect(permissions.responses).toEqual([expect.objectContaining({
      sessionId: 'gateway:mock:user-1',
      requestId: 'request-1',
      channel: 'mock',
      decision: 'once',
    })])
    expect(channel.sent.map(message => message.text)).toContain('已允许一次。')
    expect(channel.sent.map(message => message.text)).toContain('工具完成')
    expect(channel.sent.map(message => message.text)).not.toContain('请求太频繁，请稍后再试。')
  })

  it('consumes approval replies when the inbound reply user id differs from the original request', async () => {
    const permissions = new MockPermissionSurface()
    let allowPermission!: () => void
    const permissionAllowed = new Promise<void>(resolve => {
      allowPermission = resolve
    })
    permissions.onRespond = () => {
      allowPermission()
    }
    const runtime = new MockRuntime(async (mockRuntime, options) => {
      permissions.emitRequest(options.sessionId, {
        requestId: 'request-1',
        targetChannel: 'mock',
        title: 'Create tmp.md',
      })
      await permissionAllowed
      mockRuntime.pushText(options.sessionId, 'done')
    }, permissions)
    const channel = new MockChannel()
    const raw = { from_user_id: 'user-1', context_token: 'token-1' }
    const bridge = new GatewayBridge({
      allowlist: new Allowlist({ mode: 'open' }),
      rateLimiter: new RateLimiter({ maxPerMinute: 1 }),
      registry: new GatewaySessionRegistry(runtime),
      runtime,
      permissionConfig: { mode: 'remote-approval', timeoutMs: 300_000 },
    })
    bridge.register(channel)

    const handlePromise = bridge.handle({
      channelId: 'mock',
      userId: 'user-1',
      conversationId: 'user-1',
      text: 'create a tmp.md',
      raw,
    })
    await waitForCall(() => channel.sent.some(message => message.text.includes('AI 想执行：Create tmp.md')))

    await bridge.handle({
      channelId: 'mock',
      userId: 'reply-user',
      conversationId: 'reply-user',
      text: '１',
      raw: { from_user_id: 'reply-user', context_token: 'token-1' },
    })
    await handlePromise

    expect(runtime.messages.map(message => message.content)).toEqual(['create a tmp.md'])
    expect(permissions.responses).toEqual([expect.objectContaining({
      sessionId: 'gateway:mock:user-1',
      requestId: 'request-1',
      channel: 'mock',
      decision: 'once',
    })])
    expect(channel.sent.map(message => message.text)).toContain('已允许一次。')
    expect(channel.sent.map(message => message.text)).toContain('done')
  })

  it('applies configured automatic permission modes to gateway sessions', async () => {
    const permissions = new MockPermissionSurface()
    const runtime = new MockRuntime(undefined, permissions)
    const channel = new MockChannel()
    const raw = { from_user_id: 'user-1', context_token: 'token-1' }
    const bridge = new GatewayBridge({
      allowlist: new Allowlist({ mode: 'open' }),
      rateLimiter: new RateLimiter({ maxPerMinute: 10 }),
      registry: new GatewaySessionRegistry(runtime),
      runtime,
      permissionConfig: { mode: 'auto-accept-edits', timeoutMs: 300_000 },
    })
    bridge.register(channel)

    await bridge.handle({
      channelId: 'mock',
      userId: 'user-1',
      conversationId: 'user-1',
      text: 'hello',
      raw,
    })

    expect(permissions.setSessionPermissionMode).toHaveBeenCalledWith(
      'gateway:mock:user-1',
      'auto-accept-edits',
    )
    expect(channel.sent).toEqual([{ conversationId: 'user-1', userId: 'user-1', text: 'Echo: hello', raw }])
  })

  it('serializes normal messages for one gateway conversation', async () => {
    const releaseFirst = createDeferred<void>()
    const runtime = new MockRuntime(async (mockRuntime, options) => {
      if (options.content === 'first') {
        await releaseFirst.promise
      }
      mockRuntime.pushText(options.sessionId, `done ${options.content}`)
    })
    const channel = new MockChannel()
    const raw = { from_user_id: 'user-1', context_token: 'token-1' }
    const bridge = new GatewayBridge({
      allowlist: new Allowlist({ mode: 'open' }),
      rateLimiter: new RateLimiter({ maxPerMinute: 10 }),
      registry: new GatewaySessionRegistry(runtime),
      runtime,
    })
    bridge.register(channel)

    const first = bridge.handle({
      channelId: 'mock',
      userId: 'user-1',
      conversationId: 'user-1',
      text: 'first',
      raw,
    })
    await waitForCall(() => runtime.messages.length === 1)
    const second = bridge.handle({
      channelId: 'mock',
      userId: 'user-1',
      conversationId: 'user-1',
      text: 'second',
      raw,
    })
    await flushPromises()

    expect(runtime.messages.map(message => message.content)).toEqual(['first'])

    releaseFirst.resolve()
    await Promise.all([first, second])

    expect(runtime.messages.map(message => message.content)).toEqual(['first', 'second'])
    expect(channel.sent.map(message => message.text)).toEqual(['done first', 'done second'])
  })

  it('does not block other gateway users behind a pending conversation', async () => {
    const releaseFirst = createDeferred<void>()
    const runtime = new MockRuntime(async (mockRuntime, options) => {
      if (options.content === 'slow') {
        await releaseFirst.promise
      }
      mockRuntime.pushText(options.sessionId, `done ${options.content}`)
    })
    const channel = new MockChannel()
    const bridge = new GatewayBridge({
      allowlist: new Allowlist({ mode: 'open' }),
      rateLimiter: new RateLimiter({ maxPerMinute: 10 }),
      registry: new GatewaySessionRegistry(runtime),
      runtime,
    })
    bridge.register(channel)

    const slow = bridge.handle({
      channelId: 'mock',
      userId: 'user-1',
      conversationId: 'user-1',
      text: 'slow',
      raw: { from_user_id: 'user-1' },
    })
    await waitForCall(() => runtime.messages.length === 1)

    await bridge.handle({
      channelId: 'mock',
      userId: 'user-2',
      conversationId: 'user-2',
      text: 'fast',
      raw: { from_user_id: 'user-2' },
    })

    expect(runtime.messages.map(message => message.content)).toEqual(['slow', 'fast'])
    expect(channel.sent.map(message => message.text)).toEqual(['done fast'])

    releaseFirst.resolve()
    await slow

    expect(channel.sent.map(message => message.text)).toEqual(['done fast', 'done slow'])
  })

  it('cleans up a pending permission when the stream aborts and consumes a late approval reply', async () => {
    const permissions = new MockPermissionSurface()
    const channel = new MockChannel()
    const raw = { from_user_id: 'user-1', context_token: 'token-1' }
    const capture = createCaptureLogger()
    const runtime = new MockRuntime(async (_mockRuntime, options) => {
      permissions.emitRequest(options.sessionId, {
        requestId: 'request-1',
        targetChannel: 'mock',
        title: '写文件',
      })
      await waitForCall(() => channel.sent.some(message => message.text.includes('AI 想执行：写文件')))
      throw new Error('stream aborted')
    }, permissions)
    const bridge = new GatewayBridge({
      allowlist: new Allowlist({ mode: 'open' }),
      rateLimiter: new RateLimiter({ maxPerMinute: 10 }),
      registry: new GatewaySessionRegistry(runtime),
      runtime,
      permissionConfig: { mode: 'remote-approval', timeoutMs: 300_000 },
      logger: capture.logger,
    })
    bridge.register(channel)

    await bridge.handle({
      channelId: 'mock',
      userId: 'user-1',
      conversationId: 'user-1',
      text: 'needs tool',
      raw,
    })
    await waitForCall(() => channel.sent.some(message => message.text === '审批已失效，请重新发送请求。'))

    await bridge.handle({
      channelId: 'mock',
      userId: 'user-1',
      conversationId: 'user-1',
      text: '1',
      raw,
    })

    expect(runtime.messages.map(message => message.content)).toEqual(['needs tool'])
    expect(permissions.responses).toEqual([])
    expect(channel.sent.map(message => message.text)).toContain('审批已失效，请重新发送请求。')
    const failure = capture.records.find(record => record.msg === 'message handling failed')
    expect(failure).toBeDefined()
    expect(failure).toMatchObject({ level: 'error', ns: 'gateway.bridge' })
    expect(failure!.fields).toMatchObject({ channelId: 'mock' })
    expect(failure!.err?.message).toBe('stream aborted')
  })

  it('streams soft-sized plain text segments before the final flush', async () => {
    const readyText = `${'内容'.repeat(260)}。`
    const runtime = new MockRuntime((mockRuntime, options) => {
      mockRuntime.pushText(options.sessionId, readyText)
      mockRuntime.pushText(options.sessionId, '第二句')
    })
    const channel = new MockChannel()
    const raw = { from_user_id: 'user-1', context_token: 'token-1' }
    const bridge = new GatewayBridge({
      allowlist: new Allowlist({ mode: 'open' }),
      rateLimiter: new RateLimiter({ maxPerMinute: 10 }),
      registry: new GatewaySessionRegistry(runtime),
      runtime,
    })
    bridge.register(channel)

    await bridge.handle({
      channelId: 'mock',
      userId: 'user-1',
      conversationId: 'user-1',
      text: 'hello',
      raw,
    })

    expect(channel.sent.map(message => message.text)).toEqual([readyText, '第二句'])
  })

  it('does not send unbalanced markdown while streaming code fences', async () => {
    const runtime = new MockRuntime((mockRuntime, options) => {
      mockRuntime.pushText(options.sessionId, '说明：\n```ts\n')
      mockRuntime.pushText(options.sessionId, 'const value = 1\n')
      mockRuntime.pushText(options.sessionId, '```\n收尾')
    })
    const channel = new MockChannel()
    const raw = { from_user_id: 'user-1', context_token: 'token-1' }
    const bridge = new GatewayBridge({
      allowlist: new Allowlist({ mode: 'open' }),
      rateLimiter: new RateLimiter({ maxPerMinute: 10 }),
      registry: new GatewaySessionRegistry(runtime),
      runtime,
    })
    bridge.register(channel)

    await bridge.handle({
      channelId: 'mock',
      userId: 'user-1',
      conversationId: 'user-1',
      text: 'hello',
      raw,
    })

    const texts = channel.sent.map(message => message.text)
    expect(texts).toEqual(['说明：\n```ts\nconst value = 1\n```\n收尾'])
    expect(texts.every(hasBalancedFenceMarkers)).toBe(true)
  })

  it('stops sending queued outbound segments after a flush failure', async () => {
    const first = `${'甲'.repeat(500)}。`
    const second = `${'乙'.repeat(500)}。`
    const runtime = new MockRuntime((mockRuntime, options) => {
      mockRuntime.pushText(options.sessionId, first)
      mockRuntime.pushText(options.sessionId, second)
      mockRuntime.pushText(options.sessionId, '尾巴')
    })
    const channel = new MockChannel()
    channel.failSendAtCall = 1
    const raw = { from_user_id: 'user-1', context_token: 'token-1' }
    const capture = createCaptureLogger()
    const bridge = new GatewayBridge({
      allowlist: new Allowlist({ mode: 'open' }),
      rateLimiter: new RateLimiter({ maxPerMinute: 10 }),
      registry: new GatewaySessionRegistry(runtime),
      runtime,
      logger: capture.logger,
    })
    bridge.register(channel)

    await bridge.handle({
      channelId: 'mock',
      userId: 'user-1',
      conversationId: 'user-1',
      text: 'hello',
      raw,
    })

    expect(channel.sendAttempts.map(message => message.text)).toEqual([first, second])
    expect(channel.sent.map(message => message.text)).toEqual([first])
    expect(channel.typingSignals.at(-1)).toEqual({ conversationId: 'user-1', userId: 'user-1', raw, status: 'cancel' })
    const aborted = capture.records.find(record => record.msg === 'aborted outbound flush after send failure')
    expect(aborted).toBeDefined()
    // 丢了多少不再拼进字符串 —— 它是字段,可聚合(§2.1)。
    expect(aborted!.fields).toMatchObject({ droppedSegments: 1, droppedChars: 2, channelId: 'mock' })
    expect(aborted!.err).toBeDefined()
  })

  it('handles /new as a channel command and routes following messages to the new session', async () => {
    const runtime = new MockRuntime()
    const channel = new MockChannel()
    const raw = { from_user_id: 'user-1', context_token: 'token-1' }
    const bridge = new GatewayBridge({
      allowlist: new Allowlist({ mode: 'open' }),
      rateLimiter: new RateLimiter({ maxPerMinute: 10 }),
      registry: new GatewaySessionRegistry(runtime),
      runtime,
    })
    bridge.register(channel)

    await bridge.handle({
      channelId: 'mock',
      userId: 'user-1',
      conversationId: 'user-1',
      text: 'first',
      raw,
    })
    await bridge.handle({
      channelId: 'mock',
      userId: 'user-1',
      conversationId: 'user-1',
      text: '/new',
      raw,
    })
    await bridge.handle({
      channelId: 'mock',
      userId: 'user-1',
      conversationId: 'user-1',
      text: 'second',
      raw,
    })

    expect(runtime.messages.map(message => message.sessionId)).toEqual([
      'gateway:mock:user-1',
      'gateway:mock:user-1:session-2',
    ])
    expect(runtime.messages.map(message => message.content)).toEqual(['first', 'second'])
    expect(channel.sent[1]?.text).toContain('已创建新的会话')
    expect(channel.sent[1]?.text).toContain('gateway:mock:user-1:session-2')
  })

  it('does not reuse the default gateway session when /new is the first message after startup', async () => {
    const runtime = new MockRuntime()
    const channel = new MockChannel()
    const raw = { from_user_id: 'user-1', context_token: 'token-1' }
    const bridge = new GatewayBridge({
      allowlist: new Allowlist({ mode: 'open' }),
      rateLimiter: new RateLimiter({ maxPerMinute: 10 }),
      registry: new GatewaySessionRegistry(runtime),
      runtime,
    })
    bridge.register(channel)

    await bridge.handle({
      channelId: 'mock',
      userId: 'user-1',
      conversationId: 'user-1',
      text: '/new',
      raw,
    })
    await bridge.handle({
      channelId: 'mock',
      userId: 'user-1',
      conversationId: 'user-1',
      text: 'after new',
      raw,
    })

    expect(runtime.messages.map(message => message.sessionId)).toEqual([
      'gateway:mock:user-1:session-2',
    ])
    expect(runtime.messages.map(message => message.content)).toEqual(['after new'])
    expect(channel.sent[0]?.text).toContain('gateway:mock:user-1:session-2')
  })

  it('returns usage feedback for invalid /new command arguments', async () => {
    const runtime = new MockRuntime()
    const channel = new MockChannel()
    const raw = { from_user_id: 'user-1', context_token: 'token-1' }
    const bridge = new GatewayBridge({
      allowlist: new Allowlist({ mode: 'open' }),
      rateLimiter: new RateLimiter({ maxPerMinute: 10 }),
      registry: new GatewaySessionRegistry(runtime),
      runtime,
    })
    bridge.register(channel)

    await bridge.handle({
      channelId: 'mock',
      userId: 'user-1',
      conversationId: 'user-1',
      text: '/new session',
      raw,
    })

    expect(runtime.messages).toEqual([])
    expect(channel.sent).toEqual([{ conversationId: 'user-1', userId: 'user-1', text: '用法：/new', raw }])
  })

  it('recognizes shared renderer commands that do not have channel-side behavior', async () => {
    const runtime = new MockRuntime()
    const channel = new MockChannel()
    const raw = { from_user_id: 'user-1', context_token: 'token-1' }
    const bridge = new GatewayBridge({
      allowlist: new Allowlist({ mode: 'open' }),
      rateLimiter: new RateLimiter({ maxPerMinute: 10 }),
      registry: new GatewaySessionRegistry(runtime),
      runtime,
    })
    bridge.register(channel)

    await bridge.handle({
      channelId: 'mock',
      userId: 'user-1',
      conversationId: 'user-1',
      text: '/cd /tmp/project',
      raw,
    })
    await bridge.handle({
      channelId: 'mock',
      userId: 'user-1',
      conversationId: 'user-1',
      text: '/compact',
      raw,
    })

    expect(runtime.messages).toEqual([])
    expect(channel.sent.map(message => message.text)).toEqual([
      '已识别 /cd <path>，但当前 channel 暂不支持切换工作目录。请在桌面端使用该命令。',
      '已识别 /compact，但当前 channel 暂不支持手动压缩上下文。请在桌面端使用该命令。',
    ])
  })

  it('executes registered external slash commands without sending them to the model', async () => {
    const runtime = new MockRuntime()
    const channel = new MockChannel()
    const raw = { from_user_id: 'user-1', context_token: 'token-1' }
    const commandProvider: GatewayCommandProvider = {
      listCommands: vi.fn(async () => [{
        id: 'memory',
        name: '/memory',
        description: 'Memory command',
        usage: '/memory status',
      }]),
      executeCommand: vi.fn(async () => ({
        success: true,
        message: 'Memory is ready',
      })),
    }
    const bridge = new GatewayBridge({
      allowlist: new Allowlist({ mode: 'open' }),
      rateLimiter: new RateLimiter({ maxPerMinute: 10 }),
      registry: new GatewaySessionRegistry(runtime),
      runtime,
      commandProvider,
    })
    bridge.register(channel)

    await bridge.handle({
      channelId: 'mock',
      userId: 'user-1',
      conversationId: 'user-1',
      text: '/memory status',
      raw,
    })

    expect(runtime.messages).toEqual([])
    expect(commandProvider.executeCommand).toHaveBeenCalledWith({
      command: {
        id: 'memory',
        name: '/memory',
        description: 'Memory command',
        usage: '/memory status',
      },
      args: 'status',
      sessionId: 'gateway:mock:user-1',
      channelId: 'mock',
      userId: 'user-1',
      raw,
    })
    expect(channel.sent).toEqual([{ conversationId: 'user-1', userId: 'user-1', text: 'Memory is ready', raw }])
  })

  it('lets unknown slash input continue as chat content', async () => {
    const runtime = new MockRuntime()
    const channel = new MockChannel()
    const raw = { from_user_id: 'user-1', context_token: 'token-1' }
    const bridge = new GatewayBridge({
      allowlist: new Allowlist({ mode: 'open' }),
      rateLimiter: new RateLimiter({ maxPerMinute: 10 }),
      registry: new GatewaySessionRegistry(runtime),
      runtime,
      commandProvider: {
        listCommands: vi.fn(async () => []),
        executeCommand: vi.fn(),
      },
    })
    bridge.register(channel)

    await bridge.handle({
      channelId: 'mock',
      userId: 'user-1',
      conversationId: 'user-1',
      text: '/skill explain this',
      raw,
      actor: {
        displayName: 'Alice Chen',
        handle: 'alice',
      },
    })

    expect(runtime.messages).toEqual([expect.objectContaining({
      sessionId: 'gateway:mock:user-1',
      content: '/skill explain this',
      channel: 'mock',
      source: 'gateway',
      origin: expect.objectContaining({
        transport: 'im',
        source: 'gateway',
        actor: {
          externalUserId: 'user-1',
          displayName: 'Alice Chen',
          handle: 'alice',
        },
        conversation: expect.objectContaining({
          connector: 'mock',
          externalConversationId: 'user-1',
          type: 'dm',
        }),
      }),
    })])
    expect(channel.sent).toEqual([{ conversationId: 'user-1', userId: 'user-1', text: 'Echo: /skill explain this', raw }])
  })

  it('derives origin connector and workspace from account-scoped channel ids', async () => {
    const runtime = new MockRuntime()
    const channel = new MockChannel('wechat:work')
    const raw = { from_user_id: 'user-1', context_token: 'token-1' }
    const bridge = new GatewayBridge({
      allowlist: new Allowlist({ mode: 'open' }),
      rateLimiter: new RateLimiter({ maxPerMinute: 10 }),
      registry: new GatewaySessionRegistry(runtime),
      runtime,
    })
    bridge.register(channel)

    await bridge.handle({
      channelId: 'wechat:work',
      userId: 'user-1',
      conversationId: 'user-1',
      text: 'hello',
      raw,
    })

    expect(runtime.messages).toEqual([expect.objectContaining({
      sessionId: 'gateway:wechat:work:user-1',
      channel: 'wechat:work',
      origin: expect.objectContaining({
        conversation: expect.objectContaining({
          connector: 'wechat',
          workspaceId: 'work',
          externalConversationId: 'user-1',
        }),
        replyTarget: expect.objectContaining({
          connector: 'wechat',
          workspaceId: 'work',
          externalConversationId: 'user-1',
        }),
      }),
    })])
    expect(channel.sent).toEqual([{ conversationId: 'user-1', userId: 'user-1', text: 'Echo: hello', raw }])
  })
})

function hasBalancedFenceMarkers(text: string): boolean {
  const matches = text.match(/^```/gm) ?? []
  return matches.length % 2 === 0
}

async function waitForCall(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}
