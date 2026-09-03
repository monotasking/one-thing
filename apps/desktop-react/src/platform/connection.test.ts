import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryTransport, type MemoryTransport } from '@onething/client'

/**
 * 连通面(C1 起底座是 `@onething/client`)。
 *
 * 换掉的**只有传输**:`createHttpTransport` 换成包自带的内存替身,
 * `createOnethingClient` / 事件枢纽 / 域客户端全是真的 —— 于是这份用例验的是
 * 「壳把线接对了没有」,而不是一堆手写替身之间的自洽。五格状态(表二)因此是
 * 真枢纽算出来的,不是这里摆出来的。
 */

const hoisted = vi.hoisted(() => {
  const state: {
    transport?: MemoryTransport
    httpOptions: unknown[]
  } = { httpOptions: [] }
  return state
})

vi.mock('@onething/client', async importOriginal => {
  const actual = await importOriginal<typeof import('@onething/client')>()
  return {
    ...actual,
    createHttpTransport: (options: unknown) => {
      hoisted.httpOptions.push(options)
      return hoisted.transport ?? actual.createMemoryTransport()
    },
  }
})

/** 让内存传输的异步队列走一拍。 */
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

function newTransport(list: unknown = { success: true, sessions: [] }): MemoryTransport {
  return createMemoryTransport({ handlers: { 'sessions.list': () => list } })
}

describe('D0 connection', () => {
  beforeEach(() => {
    vi.resetModules()
    hoisted.httpOptions.length = 0
    hoisted.transport = newTransport()
    delete (window as { onethingHost?: unknown }).onethingHost
  })

  afterEach(() => {
    hoisted.transport?.close()
    delete (window as { onethingHost?: unknown }).onethingHost
  })

  it('injects the host connection, then proves one RPC round trip and one SSE event', async () => {
    ;(window as unknown as { onethingHost: unknown }).onethingHost = {
      getConnection: async () => ({ ok: true, baseUrl: 'http://127.0.0.1:9', token: 'tok' }),
    }

    const { whenConnected } = await import('./connection')
    const probe = await whenConnected()

    // token 交给**传输**(它进 Authorization 头),壳这一层不拼 URL、不带 query。
    expect(hoisted.httpOptions).toEqual([{ baseUrl: 'http://127.0.0.1:9', token: 'tok' }])
    expect(probe.hosted).toBe(true)
    expect(probe.rpcOk).toBe(true)
    expect(probe.baseUrl).toBe('http://127.0.0.1:9')

    // 订阅在 RPC 之前就挂上了 —— 门造事件的那一刻不能漏。
    hoisted.transport?.emit({ name: 'session:event', data: {} })
    await tick()
    expect(window.__d0?.sseEvents).toBe(1)
  })

  it('skips injection entirely when opened in a plain browser', async () => {
    const { whenConnected } = await import('./connection')
    const probe = await whenConnected()

    // 缺席 = 同源相对路径,一个字节不动(apps/web 的行为):空 baseUrl、无 token。
    expect(hoisted.httpOptions).toEqual([{ baseUrl: '' }])
    expect(probe.hosted).toBe(false)
    expect(probe.rpcOk).toBe(true)
  })

  it('reports the host error instead of connecting when the core is unreachable', async () => {
    ;(window as unknown as { onethingHost: unknown }).onethingHost = {
      getConnection: async () => ({ ok: false, error: '先跑 bun run server:build' }),
    }

    const { whenConnected } = await import('./connection')
    const probe = await whenConnected()

    expect(probe.rpcOk).toBe(false)
    expect(probe.error).toBe('先跑 bun run server:build')
    // 一条 RPC 都没打出去。
    expect(hoisted.transport?.calls).toEqual([])
  })

  /*
   * 08-30 通知系统批:连不通不再只落在 window.__d0.error 那个门的观测口上
   * (用户看不见它)。报一条 warn —— 弹 8s、不拦路、进通知中心存档。
   * 「重连中 / 已恢复」那一档现在有产地了(表二)却仍然不报,理由记在
   * connection.ts 的 whenConnected 文件头。
   */
  it('reports the failure through notify(warn) so the user actually sees it', async () => {
    ;(window as unknown as { onethingHost: unknown }).onethingHost = {
      getConnection: async () => ({ ok: false, error: '先跑 bun run server:build' }),
    }

    const { whenConnected } = await import('./connection')
    // resetModules 之后要拿**同一份**通知中心实例,所以这里也动态取。
    const { useNotifyStore } = await import('../services/notify-store')
    useNotifyStore.setState({ items: [] })

    await whenConnected()

    expect(
      useNotifyStore.getState().items.map((x) => [x.level, x.source, x.body]),
    ).toEqual([['warn', 'platform.connection', '先跑 bun run server:build']])
  })

  it('says nothing when the connection is fine — no news is good news', async () => {
    const { whenConnected } = await import('./connection')
    const { useNotifyStore } = await import('../services/notify-store')
    useNotifyStore.setState({ items: [] })

    await whenConnected()
    expect(useNotifyStore.getState().items).toEqual([])
  })

  it('is idempotent — repeated calls share one connection attempt', async () => {
    const { whenConnected } = await import('./connection')
    const [a, b] = await Promise.all([whenConnected(), whenConnected()])
    expect(a).toBe(b)
    expect(hoisted.transport?.calls.length).toBe(1)
  })

  it('hands out one client — the same object every time (壳的缺省实例住在这里)', async () => {
    const { onethingClient } = await import('./connection')
    const [a, b] = await Promise.all([onethingClient(), onethingClient()])
    expect(a).toBe(b)
  })
})

/**
 * 表二的五格 —— 每格一例。状态是枢纽算的,这里只负责把它逼到那一格。
 */
describe('D0 connection:推送流的五格状态', () => {
  beforeEach(() => {
    vi.resetModules()
    hoisted.httpOptions.length = 0
    hoisted.transport = newTransport()
    delete (window as { onethingHost?: unknown }).onethingHost
  })

  afterEach(() => {
    hoisted.transport?.close()
  })

  it('idle —— 连通之前(还没有客户端,更没有订阅者)', async () => {
    const { connectionStatus } = await import('./connection')
    expect(connectionStatus()).toBe('idle')
  })

  it('connecting —— 流拉起来了,第一条还没到', async () => {
    const { whenConnected, connectionStatus } = await import('./connection')
    await whenConnected()
    expect(connectionStatus()).toBe('connecting')
    expect(window.__d0?.status).toBe('connecting')
  })

  it('live —— 收到过至少一条', async () => {
    const { whenConnected, connectionStatus } = await import('./connection')
    await whenConnected()
    hoisted.transport?.emit({ name: 'session:event', data: {} })
    await tick()
    expect(connectionStatus()).toBe('live')
    expect(window.__d0?.status).toBe('live')
  })

  it('reconnecting —— 流断了而没人退订', async () => {
    const { whenConnected, connectionStatus, onConnectionStatusChange } = await import(
      './connection'
    )
    const seen: string[] = []
    const off = onConnectionStatusChange(next => seen.push(next))
    await whenConnected()
    hoisted.transport?.emit({ name: 'session:event', data: {} })
    await tick()

    hoisted.transport?.close()
    await tick()

    expect(connectionStatus()).toBe('reconnecting')
    expect(window.__d0?.status).toBe('reconnecting')
    // 连通**之前**订的那一位也收到了(订早了不该收不到)。
    expect(seen).toEqual(['connecting', 'live', 'reconnecting'])
    off()
  })

  it('closed —— client.close() 之后的终态', async () => {
    const { onethingClient, connectionStatus } = await import('./connection')
    const client = await onethingClient()
    client.close()
    expect(connectionStatus()).toBe('closed')
  })
})
