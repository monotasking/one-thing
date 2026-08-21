/**
 * `server.http` 访问日志(logging L1)。
 *
 * 盘点 §1.4:这个 1900 行的 HTTP 面此前 console 出现 **0** 次 —— 没有访问记录、
 * 没有 4xx/5xx、没有耗时。这条测试钉住三件事:每次请求恰好一条记录、状态码分级
 * (5xx=error / 4xx=warn / 其余=info)、以及会话路径能反解出 `sessionId`。
 */
import { once } from 'node:events'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LogRecord } from '@onething/core/logging'
import { getRootLogger } from '../../wiring/logging/index.js'
import { createOnethingHttpServer, sessionIdFromPath } from '../http.js'

const servers: Server[] = []
let records: LogRecord[] = []
let removeSink: (() => void) | undefined

function stubRuntime(): never {
  return {
    capabilities: {
      get: async () => ({ success: true, capabilities: {} }),
    },
    sessions: {
      list: async () => {
        throw new Error('sessions store exploded')
      },
    },
  } as never
}

async function listen(): Promise<string> {
  const server = createOnethingHttpServer({ runtime: stubRuntime() })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return `http://127.0.0.1:${port}`
}

beforeEach(() => {
  records = []
  removeSink = getRootLogger().addSink({
    write: (record) => {
      if (record.ns === 'server.http') records.push(record)
    },
  })
})

afterEach(async () => {
  removeSink?.()
  removeSink = undefined
  await Promise.all(servers.map(server => new Promise<void>((resolve) => { server.close(() => resolve()) })))
  servers.length = 0
})

describe('server.http request log', () => {
  it('records one line per request with method/path/status/ms', async () => {
    const base = await listen()

    const ok = await fetch(`${base}/api/capabilities`)
    expect(ok.status).toBe(200)
    const missing = await fetch(`${base}/api/nope`)
    expect(missing.status).toBe(404)
    const failed = await fetch(`${base}/api/sessions`)
    expect(failed.status).toBe(500)

    // 响应的 `close` 是异步的,给事件循环一拍。
    await new Promise(resolve => setTimeout(resolve, 50))

    const byPath = new Map(records.map(record => [String(record.fields?.path), record]))
    expect(records).toHaveLength(3)

    expect(byPath.get('/api/capabilities')).toMatchObject({
      level: 'info',
      msg: 'request',
      fields: { method: 'GET', status: 200 },
    })
    expect(byPath.get('/api/nope')).toMatchObject({
      level: 'warn',
      msg: 'request rejected',
      fields: { method: 'GET', status: 404 },
    })
    expect(byPath.get('/api/sessions')).toMatchObject({
      level: 'error',
      msg: 'request failed',
      fields: { method: 'GET', status: 500 },
    })
    for (const record of records) {
      expect(typeof record.fields?.ms).toBe('number')
    }
  })

  it('carries the sessionId so the access log joins the session ledger', () => {
    expect(sessionIdFromPath('/api/sessions/abc-123/permissions/pending')).toBe('abc-123')
    expect(sessionIdFromPath('/api/sessions/abc%20def')).toBe('abc def')
    expect(sessionIdFromPath('/api/sessions')).toBeUndefined()
    expect(sessionIdFromPath('/api/capabilities')).toBeUndefined()
  })
})
