import { afterEach, describe, expect, it, vi } from 'vitest'
import { LoggerRoot, type LogRecord } from '@onething/core/logging'
import { configureGatewayLogging } from '../../../../core/logging.js'
import { ILinkPoller } from '../poller.js'
import type { GetUpdatesResponse } from '../types.js'

const originalFetch = globalThis.fetch

describe('ILinkPoller', () => {
  afterEach(() => {
    Object.defineProperty(globalThis, 'fetch', {
      value: originalFetch,
      writable: true,
      configurable: true,
    })
    vi.restoreAllMocks()
  })

  it('accepts getupdates responses that omit ret but include cursors', async () => {
    const responseBody = {
      msgs: [],
      sync_buf: 'CAAY4ZiNlvAz',
      get_updates_buf: 'CgkIABjhmI2W8DMSOjlkNGJhM2NjNjUxZEBpbS5ib3Q=',
    }
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(responseBody), { status: 200 }))
    stubFetch(fetchMock)

    const poller = new ILinkPoller('bot-token', async () => {}, 'https://ilink.example.test')
    const data = await (poller as unknown as {
      pollOnce(): Promise<GetUpdatesResponse>
    }).pollOnce()

    expect(data).toEqual(responseBody)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://ilink.example.test/ilink/bot/getupdates',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer bot-token',
          AuthorizationType: 'ilink_bot_token',
        }),
      }),
    )
  })

  it('logs and skips malformed getupdates responses without throwing', async () => {
    const responseBody = {
      msgs: 'not-an-array',
      sync_buf: 'sync-cursor',
      get_updates_buf: 'updates-cursor',
    }
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(responseBody), { status: 200 }))
    // L2:poller 记的是结构化记录,进程级工厂决定它落哪儿 —— 测试装一个捕获用的。
    const records: LogRecord[] = []
    const root = new LoggerRoot({ level: 'trace', sinks: [{ write: record => { records.push(record) } }], src: 'gateway' })
    const restoreLogging = configureGatewayLogging(ns => root.logger(ns))
    stubFetch(fetchMock)

    const poller = new ILinkPoller('bot-token', async () => {}, 'https://ilink.example.test')
    const data = await (poller as unknown as {
      pollOnce(): Promise<GetUpdatesResponse>
    }).pollOnce()

    expect(data).toEqual({
      msgs: [],
      sync_buf: 'sync-cursor',
      get_updates_buf: 'updates-cursor',
    })
    const record = records.find(entry => entry.msg === 'unexpected getupdates response')
    expect(record).toBeDefined()
    expect(record).toMatchObject({ level: 'error', ns: 'gateway.wechat.poller' })
    expect(record!.fields).toMatchObject({ response: responseBody })
    restoreLogging()
  })
})

function stubFetch(fetchMock: typeof fetch): void {
  Object.defineProperty(globalThis, 'fetch', {
    value: fetchMock,
    writable: true,
    configurable: true,
  })
}
