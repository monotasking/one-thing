import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { LoggerRoot, type LogRecord, type LogSink, type Logger } from '@onething/core/logging'
import { Gateway } from '../core/gateway.js'
import { GatewayBridge } from '../core/bridge.js'
import { WechatChannel } from '../channels/wechat/index.js'
import { TelegramChannel } from '../channels/telegram/index.js'
import {
  configureGatewayLogging,
  gatewayLogger,
  resetGatewayLoggingForTests,
} from '../core/logging.js'

class CaptureSink implements LogSink {
  readonly records: LogRecord[] = []
  write(record: LogRecord): void {
    this.records.push(record)
  }
}

/** 宿主注入的形状:与 `@onething/backend/logging` 的 `getLogger(ns)` 同签名。 */
function createHostLoggerFactory(): { getLogger: (ns: string) => Logger; sink: CaptureSink } {
  const sink = new CaptureSink()
  const root = new LoggerRoot({ level: 'trace', sinks: [sink], src: 'gateway' })
  return { getLogger: (ns: string) => root.logger(ns), sink }
}

describe('gateway logger injection (L2)', () => {
  beforeEach(() => {
    resetGatewayLoggingForTests()
  })

  afterEach(() => {
    resetGatewayLoggingForTests()
    vi.restoreAllMocks()
  })

  it('routes free-function logs through the injected factory once configured', () => {
    const host = createHostLoggerFactory()
    configureGatewayLogging(host.getLogger)

    gatewayLogger('storage').warn('read failed, using fallback', { file: 'wechat-token.json' })

    expect(host.sink.records).toHaveLength(1)
    expect(host.sink.records[0]).toMatchObject({
      ns: 'gateway.storage',
      level: 'warn',
      msg: 'read failed, using fallback',
      src: 'gateway',
    })
    expect(host.sink.records[0].fields).toMatchObject({ file: 'wechat-token.json' })
  })

  it('the configure call is reversible — the disposer restores the previous factory', () => {
    const first = createHostLoggerFactory()
    const second = createHostLoggerFactory()
    configureGatewayLogging(first.getLogger)
    const restore = configureGatewayLogging(second.getLogger)

    gatewayLogger().info('two')
    restore()
    gatewayLogger().info('one')

    expect(second.sink.records.map(record => record.msg)).toEqual(['two'])
    expect(first.sink.records.map(record => record.msg)).toEqual(['one'])
  })

  it('Gateway logs its own lifecycle through the injected logger, never console', () => {
    const host = createHostLoggerFactory()
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})
    configureGatewayLogging(host.getLogger)

    const bridge = { register: vi.fn(), cleanupInactiveSessions: () => 3 } as unknown as GatewayBridge
    const gateway = new Gateway(bridge)
    ;(gateway as unknown as { log: Logger }).log.info('cleaned up inactive sessions', { removed: 3 })

    expect(consoleLog).not.toHaveBeenCalled()
    expect(host.sink.records.at(-1)).toMatchObject({ ns: 'gateway', msg: 'cleaned up inactive sessions' })
  })

  it('an explicitly constructed logger wins over the process-level factory', () => {
    const process = createHostLoggerFactory()
    const explicit = createHostLoggerFactory()
    configureGatewayLogging(process.getLogger)

    const channel = new TelegramChannel({
      botToken: 'token',
      logger: explicit.getLogger('gateway.telegram'),
    })
    ;(channel as unknown as { logger: Logger }).logger.error('poll failed', {}, new Error('boom'))

    expect(process.sink.records).toHaveLength(0)
    expect(explicit.sink.records.at(-1)).toMatchObject({ ns: 'gateway.telegram', msg: 'poll failed' })
    expect(explicit.sink.records.at(-1)!.err?.message).toBe('boom')
  })

  it('the WeChat channel binds its accountId once, so every line carries it', () => {
    const host = createHostLoggerFactory()
    configureGatewayLogging(host.getLogger)

    const channel = new WechatChannel({ accountId: 'work' })
    ;(channel as unknown as { log: Logger }).log.warn('QR code expired, requesting a new one')

    expect(host.sink.records.at(-1)).toMatchObject({ ns: 'gateway.wechat' })
    expect(host.sink.records.at(-1)!.fields).toMatchObject({ accountId: 'work' })
  })

  it('falls back to a structured console sink when nobody injects — not to raw console.log', () => {
    // 没有注入时用的是内核那套 `LoggerRoot + ConsoleSink`,记录形状与注入路一致。
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    gatewayLogger('fallback').error('boom')

    expect(log).not.toHaveBeenCalled()
    expect(debug).not.toHaveBeenCalled()
    const line = error.mock.calls[0]?.[0] as string
    expect(line).toContain('gateway.fallback')
    expect(line).toContain('boom')
  })
})
