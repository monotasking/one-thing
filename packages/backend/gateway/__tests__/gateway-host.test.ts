/**
 * 后端进程里的网关生命周期(第④步批 4):按设置起、只按设置起、设置一改就跟着起停、收尾有上限。
 * 渠道与起网关都用替身,一条网络请求都不发。
 */
import { describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '@shared/ipc/settings.js'
import type { CoreConversationRuntime } from '../gateway-conversation-runtime.js'
import type { Channel, InboundMessage, OutboundMessage } from '../hub/gateway-hub.js'
import type { GatewayRuntime, StartGatewayOptions } from '../gateway-standalone.js'
import { createBackendGatewayHost, type BackendGatewayHostOptions } from '../gateway-host.js'

class FakeChannel implements Channel {
  readonly id: string
  constructor(readonly accountId: string) {
    this.id = `wechat:${accountId}`
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async send(_msg: OutboundMessage): Promise<void> {}
  onMessage(_handler: (msg: InboundMessage) => Promise<void>): void {}
}

const runtime = { streamChannel: { subscribe: () => () => {} }, ensureSession() {}, destroySession() {}, async sendMessage() {} } as unknown as CoreConversationRuntime

function setup(settings: { current: Pick<AppSettings, 'channels'> | undefined }, overrides: Partial<BackendGatewayHostOptions> = {}) {
  const started: StartGatewayOptions[] = []
  const stopGateway = vi.fn(async () => {})
  const startGatewayImpl = vi.fn(async (options: StartGatewayOptions): Promise<GatewayRuntime> => {
    started.push(options)
    return { gateway: { stop: stopGateway } as unknown as GatewayRuntime['gateway'], startPromise: Promise.resolve() }
  })
  const host = createBackendGatewayHost({
    getConversationRuntime: () => runtime,
    getSettings: () => settings.current,
    env: {} as NodeJS.ProcessEnv,
    startGatewayImpl,
    createWechatChannel: ({ accountId }) => new FakeChannel(accountId),
    clearWechatAuthState: async () => {},
    ...overrides,
  })
  return { host, started, startGatewayImpl, stopGateway }
}

const wechatOn = (accounts?: Array<{ id: string; enabled: boolean }>): Pick<AppSettings, 'channels'> => ({
  channels: { wechat: { enabled: true, ...(accounts ? { accounts } : {}) } },
})

describe('后端进程里的网关(createBackendGatewayHost)', () => {
  it('设置开着:startFromSettings 起网关,渠道是设置里的账号,对话 runtime 是进程内那一份', async () => {
    const { host, started } = setup({ current: wechatOn() })
    const status = await host.startFromSettings()
    expect(started).toHaveLength(1)
    expect(started[0]!.runtime).toBe(runtime)
    expect(started[0]!.channels?.map(channel => channel.id)).toEqual(['wechat:default'])
    expect(started[0]!.background).toBe(true)
    expect(status.enabled).toBe(true)
    await Promise.resolve()
    expect(host.getStatus().running).toBe(true)
  })

  it('设置关着或没有这一段:不起', async () => {
    for (const current of [undefined, {}, { channels: { wechat: { enabled: false } } }] as Array<Pick<AppSettings, 'channels'> | undefined>) {
      const { host, startGatewayImpl } = setup({ current })
      const status = await host.startFromSettings()
      expect(startGatewayImpl).not.toHaveBeenCalled()
      expect(status.running).toBe(false)
      expect(status.enabled).toBe(false)
    }
  })

  it('只按设置:环境变量里的 Telegram 令牌 / GATEWAY_CHANNELS 不让它起', async () => {
    const { host, startGatewayImpl } = setup({ current: undefined }, {
      env: { TELEGRAM_BOT_TOKEN: 'x', GATEWAY_CHANNELS: 'telegram', ONETHING_GATEWAY: '1' } as NodeJS.ProcessEnv,
    })
    await host.startFromSettings()
    await host.start()
    expect(startGatewayImpl).not.toHaveBeenCalled()
  })

  it('设置存盘之后跟着走:打开就起、关掉就停', async () => {
    const settings = { current: undefined as Pick<AppSettings, 'channels'> | undefined }
    const { host, startGatewayImpl, stopGateway } = setup(settings)
    settings.current = wechatOn()
    await host.applySettings(settings.current)
    expect(startGatewayImpl).toHaveBeenCalledTimes(1)
    settings.current = { channels: { wechat: { enabled: false } } }
    await host.applySettings(settings.current)
    expect(stopGateway).toHaveBeenCalledTimes(1)
    expect(host.getStatus().running).toBe(false)
  })

  it('收尾:停掉网关;渠道挂住时到点认输,不拖住进程', async () => {
    const { host, stopGateway } = setup({ current: wechatOn() })
    await host.startFromSettings()
    expect(await host.shutdown()).toBe(false)
    expect(stopGateway).toHaveBeenCalledTimes(1)

    const hung = setup({ current: wechatOn() }, { shutdownTimeoutMs: 20 })
    hung.stopGateway.mockImplementation(() => new Promise(() => {}))
    await hung.host.startFromSettings()
    const t0 = Date.now()
    expect(await hung.host.shutdown()).toBe(true)
    expect(Date.now() - t0).toBeLessThan(1000)
    // 收尾之后不再起。
    await hung.host.startFromSettings()
    expect(hung.startGatewayImpl).toHaveBeenCalledTimes(1)
  })
})
