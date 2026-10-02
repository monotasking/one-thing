import type { Channel } from './channel.js'
import type { GatewayBridge } from './bridge.js'
import { resolveGatewayLogger, type Logger } from './logging.js'

export class Gateway {
  private readonly channels: Channel[] = []
  private readonly log: Logger
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  /** 第二个参数是构造时注入的 logger(L2);不给就走进程级工厂。 */
  constructor(private readonly bridge: GatewayBridge, logger?: Logger) {
    this.log = resolveGatewayLogger(logger)
  }

  register(channel: Channel): this {
    this.channels.push(channel)
    this.bridge.register(channel)
    channel.onMessage((msg) => {
      void this.bridge.handle(msg).catch(error => {
        this.log.error('message handling failed', { channelId: msg.channelId }, error)
      })
      return Promise.resolve()
    })
    return this
  }

  async start(): Promise<void> {
    await Promise.all(this.channels.map(channel => channel.start()))

    this.cleanupTimer = setInterval(() => {
      const removed = this.bridge.cleanupInactiveSessions()
      if (removed > 0) {
        this.log.info('cleaned up inactive sessions', { removed })
      }
    }, 60 * 60 * 1000)
  }

  async stop(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }

    for (const channel of this.channels) {
      await channel.stop()
    }
  }
}
