import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const configureWebTransport = vi.fn()
const list = vi.fn()
let sessionEventListener: (() => void) | undefined

vi.mock('@renderer/platform/transport-config', () => ({
  configureWebTransport: (...args: unknown[]) => configureWebTransport(...args),
}))
vi.mock('@renderer/platform', () => ({
  platformApi: {
    onSessionEvent: (callback: () => void) => {
      sessionEventListener = callback
      return () => { sessionEventListener = undefined }
    },
  },
}))
vi.mock('@renderer/platform/sessions-client', () => ({
  sessionsApi: { list: (...args: unknown[]) => list(...args) },
}))

describe('D0 connection', () => {
  beforeEach(() => {
    vi.resetModules()
    configureWebTransport.mockClear()
    list.mockReset()
    sessionEventListener = undefined
    delete (window as { onethingHost?: unknown }).onethingHost
  })

  afterEach(() => {
    delete (window as { onethingHost?: unknown }).onethingHost
  })

  it('injects the host connection, then proves one RPC round trip and one SSE event', async () => {
    ;(window as unknown as { onethingHost: unknown }).onethingHost = {
      getConnection: async () => ({ ok: true, baseUrl: 'http://127.0.0.1:9', token: 'tok' }),
    }
    list.mockResolvedValue({ success: true, sessions: [] })

    const { whenConnected } = await import('./connection')
    const probe = await whenConnected()

    expect(configureWebTransport).toHaveBeenCalledWith({
      baseUrl: 'http://127.0.0.1:9',
      token: 'tok',
    })
    expect(probe.hosted).toBe(true)
    expect(probe.rpcOk).toBe(true)
    expect(probe.baseUrl).toBe('http://127.0.0.1:9')

    // 订阅在 RPC 之前就挂上了 —— 门造事件的那一刻不能漏。
    expect(sessionEventListener).toBeTypeOf('function')
    sessionEventListener?.()
    expect(window.__d0?.sseEvents).toBe(1)
  })

  it('skips injection entirely when opened in a plain browser', async () => {
    list.mockResolvedValue({ success: true, sessions: [] })

    const { whenConnected } = await import('./connection')
    const probe = await whenConnected()

    // 缺席 = 同源相对路径,一个字节不动(apps/web 的行为)。
    expect(configureWebTransport).not.toHaveBeenCalled()
    expect(probe.hosted).toBe(false)
    expect(probe.rpcOk).toBe(true)
  })

  it('reports the host error instead of connecting when the core is unreachable', async () => {
    ;(window as unknown as { onethingHost: unknown }).onethingHost = {
      getConnection: async () => ({ ok: false, error: '先跑 bun run server:build' }),
    }

    const { whenConnected } = await import('./connection')
    const probe = await whenConnected()

    expect(configureWebTransport).not.toHaveBeenCalled()
    expect(probe.rpcOk).toBe(false)
    expect(probe.error).toBe('先跑 bun run server:build')
    expect(list).not.toHaveBeenCalled()
  })

  it('is idempotent — repeated calls share one connection attempt', async () => {
    list.mockResolvedValue({ success: true, sessions: [] })
    const { whenConnected } = await import('./connection')
    const [a, b] = await Promise.all([whenConnected(), whenConnected()])
    expect(a).toBe(b)
    expect(list).toHaveBeenCalledTimes(1)
  })
})
