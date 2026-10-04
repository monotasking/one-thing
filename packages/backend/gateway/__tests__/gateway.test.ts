import { describe, expect, it, vi } from 'vitest'
import type { CoreConversationRuntime } from '@onething/backend/gateway/conversation-runtime'
import type { Channel, InboundMessage, OutboundMessage } from '../hub/gateway-hub.js'
import {
  createGatewayChannelsFromEnv,
  isGatewayEnabledFromEnv,
  readGatewayChannelIdsFromEnv,
  startGateway,
  startGatewayFromEnv,
  type GatewayRuntime,
} from '../gateway.js'

function createRuntime(): CoreConversationRuntime {
  return {
    streamChannel: {
      subscribe: vi.fn(() => () => {}),
    },
    ensureSession: vi.fn(),
    destroySession: vi.fn(),
    sendMessage: vi.fn(),
  }
}

class TestChannel implements Channel {
  readonly id = 'test'
  readonly sent: OutboundMessage[] = []
  started = false
  stopped = false

  async start(): Promise<void> {
    this.started = true
  }

  async stop(): Promise<void> {
    this.stopped = true
  }

  async send(msg: OutboundMessage): Promise<void> {
    this.sent.push(msg)
  }

  onMessage(_handler: (msg: InboundMessage) => Promise<void>): void {}
}

describe('gateway package entrypoint', () => {
  it('does not create a standalone agent runtime from env', async () => {
    await expect(startGatewayFromEnv({ env: {} as NodeJS.ProcessEnv })).rejects.toThrow(
      'Set ONETHING_GATEWAY_RUNTIME_MODULE',
    )
  })

  it('loads a real onething conversation runtime from an env-selected module', async () => {
    const runtime = createRuntime()
    const importRuntimeModule = vi.fn(async () => ({
      createGatewayRuntime: vi.fn(async () => runtime),
    }))
    const startGatewayImpl = vi.fn(async (): Promise<GatewayRuntime> => ({
      gateway: { stop: vi.fn() } as unknown as GatewayRuntime['gateway'],
    }))
    const env = {
      ONETHING_GATEWAY_RUNTIME_MODULE: '@app/onething-gateway-runtime',
      GATEWAY_RATE_LIMIT: '5',
    } as NodeJS.ProcessEnv

    await expect(startGatewayFromEnv({
      env,
      importRuntimeModule,
      startGatewayImpl,
    })).resolves.toBeDefined()

    expect(importRuntimeModule).toHaveBeenCalledWith('@app/onething-gateway-runtime')
    expect(startGatewayImpl).toHaveBeenCalledWith({
      runtime,
      env,
    })
  })

  it('rejects modules that do not export an OnethingConversationRuntime', async () => {
    await expect(startGatewayFromEnv({
      env: {
        ONETHING_GATEWAY_RUNTIME_MODULE: '@app/not-runtime',
      } as NodeJS.ProcessEnv,
      importRuntimeModule: vi.fn(async () => ({ default: { nope: true } })),
      startGatewayImpl: vi.fn(),
    })).rejects.toThrow('must export default, runtime, conversationRuntime')
  })

  it('registers caller-provided channels against the onething runtime bridge', async () => {
    const channel = new TestChannel()
    const runtime = createRuntime()

    const gatewayRuntime = await startGateway({
      runtime,
      channels: [channel],
      env: {} as NodeJS.ProcessEnv,
    })

    expect(channel.started).toBe(true)
    await gatewayRuntime.gateway.stop()
    expect(channel.stopped).toBe(true)
  })

  it('selects gateway channels from env without creating a gateway-owned agent', () => {
    expect(readGatewayChannelIdsFromEnv({ GATEWAY_CHANNELS: 'telegram,wechat,telegram' } as NodeJS.ProcessEnv))
      .toEqual(['telegram', 'wechat'])
    expect(readGatewayChannelIdsFromEnv({ TELEGRAM_BOT_TOKEN: 'token' } as NodeJS.ProcessEnv))
      .toEqual(['telegram'])
    expect(readGatewayChannelIdsFromEnv({} as NodeJS.ProcessEnv))
      .toEqual(['wechat'])

    expect(() => readGatewayChannelIdsFromEnv({ GATEWAY_CHANNELS: 'slack' } as NodeJS.ProcessEnv))
      .toThrow('Unsupported gateway channel')
  })

  it('owns gateway enablement decisions for Electron and standalone hosts', () => {
    expect(isGatewayEnabledFromEnv({} as NodeJS.ProcessEnv)).toBe(false)
    expect(isGatewayEnabledFromEnv({ ONETHING_GATEWAY: '1' } as NodeJS.ProcessEnv)).toBe(true)
    expect(isGatewayEnabledFromEnv({ GATEWAY_ENABLED: 'true' } as NodeJS.ProcessEnv)).toBe(true)
    expect(isGatewayEnabledFromEnv({ GATEWAY_CHANNELS: 'telegram,wechat' } as NodeJS.ProcessEnv)).toBe(true)
    expect(isGatewayEnabledFromEnv({ GATEWAY_CHANNELS: 'slack' } as NodeJS.ProcessEnv)).toBe(false)
    expect(isGatewayEnabledFromEnv({ TELEGRAM_BOT_TOKEN: 'telegram-token' } as NodeJS.ProcessEnv)).toBe(true)
  })

  it('creates Telegram channels from env only when a bot token is configured', () => {
    const channels = createGatewayChannelsFromEnv({
      GATEWAY_CHANNELS: 'telegram',
      GATEWAY_TELEGRAM_BOT_TOKEN: 'telegram-token',
    } as NodeJS.ProcessEnv)

    expect(channels.map(channel => channel.id)).toEqual(['telegram'])
    expect(() => createGatewayChannelsFromEnv({ GATEWAY_CHANNELS: 'telegram' } as NodeJS.ProcessEnv))
      .toThrow('Telegram gateway channel requires TELEGRAM_BOT_TOKEN')
  })
})
