import type {
  CoreConversationRuntime as OnethingConversationRuntime,
  CoreTextStreamChunk as OnethingTextStreamChunk,
} from '@onething/backend/gateway'
import type { Channel, InboundMessage, OutboundMessage } from '@onething/backend/gateway'
import {
  Allowlist,
  GatewayBridge,
  GatewaySessionRegistry,
  RateLimiter,
} from '@onething/backend/gateway'

class MockChannel implements Channel {
  readonly id = 'mock'
  readonly sent: OutboundMessage[] = []
  private handler: ((msg: InboundMessage) => Promise<void>) | null = null

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async send(msg: OutboundMessage): Promise<void> {
    this.sent.push(msg)
    console.log(`[mock channel.send] ${JSON.stringify(msg)}`)
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.handler = handler
  }

  async emit(msg: InboundMessage): Promise<void> {
    await this.handler?.(msg)
  }
}

class MockOnethingRuntime implements OnethingConversationRuntime<OnethingTextStreamChunk> {
  readonly streamChannel = new MockStreamChannel()
  readonly ensuredSessions = new Set<string>()
  readonly destroyedSessions = new Set<string>()

  ensureSession(sessionId: string): void {
    this.ensuredSessions.add(sessionId)
  }

  destroySession(sessionId: string): void {
    this.destroyedSessions.add(sessionId)
  }

  async sendMessage(options: { sessionId: string; content: string }): Promise<void> {
    for (const token of `Echo: ${options.content}`.match(/\S+\s*/g) ?? []) {
      this.streamChannel.push(options.sessionId, { type: 'text-delta', text: token })
    }
  }
}

class MockStreamChannel {
  private readonly handlers = new Map<string, Set<(chunk: OnethingTextStreamChunk) => void>>()

  subscribe(sessionId: string, handler: (chunk: OnethingTextStreamChunk) => void): () => void {
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

  push(sessionId: string, chunk: OnethingTextStreamChunk): void {
    for (const handler of this.handlers.get(sessionId) ?? []) {
      handler(chunk)
    }
  }

  shutdown(): void {
    this.handlers.clear()
  }
}

const runtime = new MockOnethingRuntime()
const mockChannel = new MockChannel()
const bridge = new GatewayBridge({
  allowlist: new Allowlist({ mode: 'open' }),
  rateLimiter: new RateLimiter({ maxPerMinute: 10 }),
  registry: new GatewaySessionRegistry(runtime),
  runtime,
})

bridge.register(mockChannel)

const mockMsg: InboundMessage = {
  channelId: 'mock',
  userId: 'test_user',
  conversationId: 'test_user',
  text: '你好',
  raw: { from_user_id: 'test_user', context_token: 'mock_token' },
}

try {
  await bridge.handle(mockMsg)

  const nonEmpty = mockChannel.sent.find(msg => msg.text.trim().length > 0)
  if (!nonEmpty) {
    throw new Error('mock channel.send was not called with non-empty text')
  }

  console.log(`[gateway smoke test] passed: ${nonEmpty.text}`)
} finally {
  runtime.streamChannel.shutdown()
}
