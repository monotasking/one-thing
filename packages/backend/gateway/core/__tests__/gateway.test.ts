import { describe, expect, it, vi } from 'vitest'
import type { Channel, InboundMessage, OutboundMessage } from '../channel.js'
import type { GatewayBridge } from '../bridge.js'
import { Gateway } from '../gateway.js'

class TestChannel implements Channel {
  readonly id = 'test'
  private handler: ((msg: InboundMessage) => Promise<void>) | null = null

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async send(_msg: OutboundMessage): Promise<void> {}

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.handler = handler
  }

  async emit(msg: InboundMessage): Promise<void> {
    await this.handler?.(msg)
  }
}

describe('Gateway', () => {
  it('acknowledges inbound channel messages without waiting for bridge handling to finish', async () => {
    const never = new Promise<void>(() => {})
    const bridge = {
      register: vi.fn(),
      handle: vi.fn(() => never),
      cleanupInactiveSessions: vi.fn(() => 0),
    }
    const channel = new TestChannel()
    const gateway = new Gateway(bridge as unknown as GatewayBridge)

    gateway.register(channel)
    await channel.emit({
      channelId: 'test',
      userId: 'user-1',
      conversationId: 'user-1',
      text: 'hello',
      raw: {},
    })

    expect(bridge.handle).toHaveBeenCalledWith({
      channelId: 'test',
      userId: 'user-1',
      conversationId: 'user-1',
      text: 'hello',
      raw: {},
    })
  })
})
