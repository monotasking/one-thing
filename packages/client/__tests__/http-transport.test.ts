// @vitest-environment node
/**
 * HTTP 传输对着一台**真的** `node:http` 服务器跑。
 *
 * 为什么不 mock fetch:被测的正是"在 Node 里用全局 fetch 拿 `ReadableStream` 再自己
 * 解析 SSE"这件事能不能成立(§7 C0 门的一半;另一半是 `gate:client` 在 Electron 下
 * 再跑一遍)。mock 掉 fetch 就把要证的东西证没了。
 *
 * 假服务器同时是**契约的复读机**:它按 `packages/backend/server/http.ts` 的形回话
 * (`/api/rpc` 永远 200 + `RpcResponse`;`/api/events` 的 `id:` 只盖在 `session:event`
 * 上;`?after=` 续播),并把每次请求的 header 与 URL 记下来给断言用。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHttpTransport } from '../transport/http.js'
import type { TransportEvent } from '../transport/types.js'

interface SeenRequest {
  method: string
  url: string
  authorization?: string
  accept?: string
}

interface Harness {
  baseUrl: string
  seen: SeenRequest[]
  /** 每条新的 `/api/events` 连接建立时叫一声,参数是 `?after=` 的值(没有就是 null)。 */
  onEventsConnection?: (after: string | null, write: (chunk: string) => void, end: () => void) => void
  close(): Promise<void>
}

async function startHarness(): Promise<Harness> {
  const seen: SeenRequest[] = []
  const harness: Partial<Harness> & { seen: SeenRequest[] } = { seen }

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    seen.push({
      method: request.method ?? 'GET',
      url: request.url ?? '/',
      ...(typeof request.headers.authorization === 'string'
        ? { authorization: request.headers.authorization }
        : {}),
      ...(typeof request.headers.accept === 'string' ? { accept: request.headers.accept } : {}),
    })

    if (url.pathname === '/api/rpc') {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(chunk as Buffer))
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
          domain: string
          method: string
          payload: unknown
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(
          body.method === 'boom'
            ? { ok: false, error: { message: 'handler said no' } }
            : { ok: true, data: { echo: body.payload, of: `${body.domain}.${body.method}` } },
        ))
      })
      return
    }

    if (url.pathname === '/api/capabilities') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        localFileSystem: true,
        workspaceFileSystem: true,
        nativeWindowControls: false,
        shellTools: true,
        clipboardWrite: false,
        desktopWindows: false,
        globalMenuEvents: false,
        terminal: true,
      }))
      return
    }

    if (url.pathname === '/api/events') {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      response.write(': connected\n\n')
      harness.onEventsConnection?.(
        url.searchParams.get('after'),
        chunk => response.write(chunk),
        () => response.end(),
      )
      return
    }

    response.writeHead(404)
    response.end()
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  harness.baseUrl = `http://127.0.0.1:${port}`
  harness.close = () =>
    new Promise<void>(resolve => {
      server.closeAllConnections?.()
      server.close(() => resolve())
    })
  return harness as Harness
}

/** SSE 一条的字节形状,与 server 的 `writeSse` 逐字同形。 */
function sse(event: string, payload: unknown, id?: number): string {
  return `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
}

let harness: Harness

beforeEach(async () => {
  harness = await startHarness()
})

afterEach(async () => {
  await harness.close()
})

describe('createHttpTransport.invoke', () => {
  it('打 POST /api/rpc,带 Bearer 头,token 不进 URL', async () => {
    const transport = createHttpTransport({ baseUrl: harness.baseUrl, token: 's3cret' })
    const response = await transport.invoke({ domain: 'sessions', method: 'list', payload: { a: 1 } })

    expect(response).toEqual({ ok: true, data: { echo: { a: 1 }, of: 'sessions.list' } })
    const request = harness.seen.at(-1)
    expect(request?.method).toBe('POST')
    expect(request?.url).toBe('/api/rpc')
    expect(request?.authorization).toBe('Bearer s3cret')
    // 反证钉子:token 回到 URL 的那一刻这一行红。
    expect(request?.url).not.toContain('s3cret')
    expect(request?.url).not.toContain('token=')
    transport.close()
  })

  it('处理者失败原样交出 { ok:false },不抛', async () => {
    const transport = createHttpTransport({ baseUrl: harness.baseUrl })
    await expect(transport.invoke({ domain: 'sessions', method: 'boom', payload: null }))
      .resolves.toEqual({ ok: false, error: { message: 'handler said no' } })
    transport.close()
  })

  it('没有 token 时不发 Authorization 头', async () => {
    const transport = createHttpTransport({ baseUrl: harness.baseUrl })
    await transport.invoke({ domain: 'sessions', method: 'list', payload: null })
    expect(harness.seen.at(-1)?.authorization).toBeUndefined()
    transport.close()
  })

  it('baseUrl 末尾的 / 不会拼出 //api/rpc', async () => {
    const transport = createHttpTransport({ baseUrl: `${harness.baseUrl}/` })
    await transport.invoke({ domain: 'sessions', method: 'list', payload: null })
    expect(harness.seen.at(-1)?.url).toBe('/api/rpc')
    transport.close()
  })

  it('传输层失败(非 2xx)照实抛,不伪装成 { ok:false }', async () => {
    const transport = createHttpTransport({ baseUrl: `${harness.baseUrl}/nope` })
    await expect(transport.invoke({ domain: 'x', method: 'y', payload: null })).rejects.toThrow(/404/)
    transport.close()
  })
})

describe('createHttpTransport.capabilities', () => {
  it('GET /api/capabilities,带 Bearer 头', async () => {
    const transport = createHttpTransport({ baseUrl: harness.baseUrl, token: 'cap-token' })
    await expect(transport.capabilities()).resolves.toMatchObject({
      localFileSystem: true,
      shellTools: true,
      terminal: true,
    })
    expect(harness.seen.at(-1)).toMatchObject({
      method: 'GET',
      url: '/api/capabilities',
      authorization: 'Bearer cap-token',
    })
    transport.close()
  })
})

describe('createHttpTransport.events', () => {
  it('GET /api/events 带 Bearer 头,token 不进 URL,收到三种事件名', async () => {
    harness.onEventsConnection = (_after, write) => {
      write(sse('session:event', { sessionId: 's1', sequence: 1 }, 1))
      write(sse('session:stream', { sessionId: 's1', chunk: { type: 'text-delta' } }))
      write(sse('settings:changed', { ai: {} }))
    }
    const transport = createHttpTransport({ baseUrl: harness.baseUrl, token: 'sse-token' })
    const controller = new AbortController()
    const got: TransportEvent[] = []
    for await (const event of transport.events({ signal: controller.signal })) {
      got.push(event)
      if (got.length === 3) controller.abort()
    }

    expect(got.map(event => event.name)).toEqual([
      'session:event',
      'session:stream',
      'settings:changed',
    ])
    expect(got[0]).toEqual({ name: 'session:event', data: { sessionId: 's1', sequence: 1 }, id: 1 })
    // **id 是粘的**(SSE 规范):server 只给 `session:event` 盖号,随后的
    // `session:stream` / `settings:changed` 带的是上一条会话事件的号。这正是续播
    // 要问的那个数,所以对;它不是"这条分片的序号"。改成"每条自己的号"会让
    // 重连时的 `?after=` 退回到 0 或跳号 —— 这一格就是钉住这件事的。
    expect(got[1].id).toBe(1)
    expect(got[2].id).toBe(1)

    const eventsRequest = harness.seen.find(request => request.url.startsWith('/api/events'))
    expect(eventsRequest?.authorization).toBe('Bearer sse-token')
    expect(eventsRequest?.accept).toBe('text/event-stream')
    expect(eventsRequest?.url).not.toContain('token')
    transport.close()
  })

  it('首次连接把 options.after 带成 ?after=', async () => {
    const afters: (string | null)[] = []
    harness.onEventsConnection = (after, write) => {
      afters.push(after)
      write(sse('session:event', { sequence: 91 }, 91))
    }
    const transport = createHttpTransport({ baseUrl: harness.baseUrl })
    const controller = new AbortController()
    for await (const _event of transport.events({ after: 90, signal: controller.signal })) {
      controller.abort()
    }
    expect(afters).toEqual(['90'])
    transport.close()
  })

  it('断线重连:带上最后一个 id 当 ?after=,并按服务器的 retry 退避', async () => {
    vi.useFakeTimers()
    try {
      const afters: (string | null)[] = []
      let connection = 0
      harness.onEventsConnection = (after, write, end) => {
        afters.push(after)
        connection += 1
        if (connection === 1) {
          // 服务器先说"下次 40ms 后再来",发一条盖了号的事件,然后收线。
          write('retry: 40\n\n')
          write(sse('session:event', { sequence: 7 }, 7))
          setTimeout(() => end(), 0)
          return
        }
        write(sse('session:event', { sequence: 8 }, 8))
      }

      const transport = createHttpTransport({ baseUrl: harness.baseUrl })
      const controller = new AbortController()
      const got: TransportEvent[] = []
      const drain = (async () => {
        for await (const event of transport.events({ signal: controller.signal })) {
          got.push(event)
          if (got.length === 2) controller.abort()
        }
      })()

      // fake timers 下真 IO 仍然要推进:反复让出微任务并把定时器拨到底。
      for (let tick = 0; tick < 60 && got.length < 2; tick += 1) {
        await vi.advanceTimersByTimeAsync(20)
      }
      await drain

      expect(got.map(event => event.id)).toEqual([7, 8])
      // 第一次没有 after,重连那次带上 7 —— 续播语义。
      expect(afters).toEqual([null, '7'])
      transport.close()
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * C1:自愈的传输必须自己说出「断了」。
   *
   * 只看那个 `for await` 是看不见断线的 —— 它自愈,从头到尾不结束。所以
   * `onConnectionChange` 是**枢纽那一格 `reconnecting` 唯一的产地**(真机门
   * `gate:connect` 路径三验的就是这条链的另一头)。
   */
  it('onConnectionChange:接上报 open,断了报 retrying,重连再报 open', async () => {
    vi.useFakeTimers()
    try {
      let connection = 0
      harness.onEventsConnection = (_after, write, end) => {
        connection += 1
        if (connection === 1) {
          write('retry: 20\n\n')
          write(sse('session:event', { sequence: 1 }, 1))
          setTimeout(() => end(), 0)
          return
        }
        write(sse('session:event', { sequence: 2 }, 2))
      }

      const transport = createHttpTransport({ baseUrl: harness.baseUrl })
      const states: string[] = []
      const off = transport.onConnectionChange?.(state => states.push(state))
      expect(off).toBeTypeOf('function')

      const controller = new AbortController()
      const got: TransportEvent[] = []
      const drain = (async () => {
        for await (const event of transport.events({ signal: controller.signal })) {
          got.push(event)
          if (got.length === 2) controller.abort()
        }
      })()
      for (let tick = 0; tick < 60 && got.length < 2; tick += 1) {
        await vi.advanceTimersByTimeAsync(20)
      }
      await drain

      // 只在**变了**的时候叫 —— 不是每次退避都重报一遍 retrying。
      expect(states).toEqual(['open', 'retrying', 'open'])
      off?.()
      transport.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('close() 让在途的 events() 循环收尾', async () => {
    harness.onEventsConnection = (_after, write) => {
      write(sse('session:event', { sequence: 1 }, 1))
    }
    const transport = createHttpTransport({ baseUrl: harness.baseUrl })
    const got: TransportEvent[] = []
    const drain = (async () => {
      for await (const event of transport.events()) {
        got.push(event)
        transport.close()
      }
    })()
    await drain
    expect(got).toHaveLength(1)
  })

  it('运行时没有全局 fetch 时当场说清楚,而不是留一个 undefined 崩在别处', () => {
    const original = globalThis.fetch
    try {
      // @ts-expect-error 故意抹掉全局,证明构造时就报警。
      delete globalThis.fetch
      expect(() => createHttpTransport({ baseUrl: 'http://x' })).toThrow(/no global fetch/)
    } finally {
      globalThis.fetch = original
    }
  })
})
