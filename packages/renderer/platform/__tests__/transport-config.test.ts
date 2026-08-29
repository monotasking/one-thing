import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyAuthHeaders,
  configureWebTransport,
  getWebTransportConfig,
  resolveApiUrl,
  resolveEventSourceUrl,
} from '../transport-config.js'

afterEach(() => {
  configureWebTransport(undefined)
})

describe('transport-config (React 壳 §5.6 甲案的单槽端口)', () => {
  describe('未配置 = 现行同源行为,一个字节不变', () => {
    it('leaves relative paths and headers untouched', () => {
      expect(getWebTransportConfig()).toBeUndefined()
      expect(resolveApiUrl('/api/rpc')).toBe('/api/rpc')
      expect(resolveEventSourceUrl('/api/events')).toBe('/api/events')

      // 关键的一条:**原样返回入参**,不新造对象 —— apps/web 靠 dev 代理注入
      // Bearer,这里再补一次就是双份注入。
      const headers = { 'content-type': 'application/json' }
      expect(applyAuthHeaders(headers)).toBe(headers)
      expect(applyAuthHeaders(undefined)).toBeUndefined()
    })
  })

  describe('配置后', () => {
    it('prefixes the base url and strips its trailing slash', () => {
      configureWebTransport({ baseUrl: 'http://127.0.0.1:53219/', token: 't0k' })
      expect(getWebTransportConfig()).toEqual({
        baseUrl: 'http://127.0.0.1:53219',
        token: 't0k',
      })
      expect(resolveApiUrl('/api/rpc')).toBe('http://127.0.0.1:53219/api/rpc')
      // 没有前导斜杠也补得上。
      expect(resolveApiUrl('api/capabilities')).toBe('http://127.0.0.1:53219/api/capabilities')
      // 已经是绝对 URL 的不碰(clipboard 那条 `fetch(filePath)` 之类)。
      expect(resolveApiUrl('https://example.test/x')).toBe('https://example.test/x')
    })

    it('adds a bearer header without clobbering an explicit one', () => {
      configureWebTransport({ baseUrl: 'http://127.0.0.1:1', token: 'secret' })
      const merged = new Headers(applyAuthHeaders({ 'content-type': 'application/json' }))
      expect(merged.get('authorization')).toBe('Bearer secret')
      expect(merged.get('content-type')).toBe('application/json')

      const explicit = new Headers(applyAuthHeaders({ authorization: 'Bearer mine' }))
      expect(explicit.get('authorization')).toBe('Bearer mine')
    })

    it('carries the token in a query param for EventSource, which cannot send headers', () => {
      configureWebTransport({ baseUrl: 'http://127.0.0.1:1', token: 'a/b+c' })
      expect(resolveEventSourceUrl('/api/events')).toBe(
        'http://127.0.0.1:1/api/events?token=a%2Fb%2Bc',
      )
      // 已有 query 时接 `&`。
      expect(resolveEventSourceUrl('/api/events?after=7')).toBe(
        'http://127.0.0.1:1/api/events?after=7&token=a%2Fb%2Bc',
      )
    })

    it('changes only the base url when no token is supplied', () => {
      configureWebTransport({ baseUrl: 'http://127.0.0.1:2' })
      expect(resolveApiUrl('/api/rpc')).toBe('http://127.0.0.1:2/api/rpc')
      expect(resolveEventSourceUrl('/api/events')).toBe('http://127.0.0.1:2/api/events')
      const headers = { 'content-type': 'application/json' }
      expect(applyAuthHeaders(headers)).toBe(headers)
    })
  })

  describe('web.ts 真的经过这一槽', () => {
    afterEach(() => {
      vi.unstubAllGlobals()
      vi.resetModules()
    })

    it('sends rpc through the configured base url with a bearer header', async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      vi.stubGlobal('fetch', fetchMock)
      vi.stubGlobal('navigator', {})

      const transport = await import('../transport-config.js')
      transport.configureWebTransport({ baseUrl: 'http://127.0.0.1:4242', token: 'tok' })
      try {
        const { createWebPlatformApi } = await import('../web.js')
        const api = createWebPlatformApi()
        await api.getUsageSummary?.({ range: 'day' } as never)

        // 构造时那次 `/api/capabilities` 也在列;要钉的是 rpc 那条。
        const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>
        expect(calls.map(([url]) => url)).toContain('http://127.0.0.1:4242/api/capabilities')
        const rpcCall = calls.find(([url]) => url.endsWith('/api/rpc'))
        expect(rpcCall?.[0]).toBe('http://127.0.0.1:4242/api/rpc')
        expect(new Headers(rpcCall?.[1].headers).get('authorization')).toBe('Bearer tok')
      } finally {
        transport.configureWebTransport(undefined)
      }
    })

    it('keeps the SSE dedup key on the path while the URL carries the token', async () => {
      const created: string[] = []
      class FakeEventSource {
        constructor(url: string) { created.push(url) }
        addEventListener() {}
        removeEventListener() {}
        close() {}
      }
      vi.stubGlobal('EventSource', FakeEventSource)
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unused') }))
      vi.stubGlobal('navigator', {})

      const transport = await import('../transport-config.js')
      transport.configureWebTransport({ baseUrl: 'http://127.0.0.1:4243', token: 'tok' })
      try {
        const { createWebPlatformApi } = await import('../web.js')
        const api = createWebPlatformApi()
        const off1 = api.onSessionEvent(() => {})
        const off2 = api.onSessionStream(() => {})

        // 两个订阅共享同一条 `/api/events` —— 去重键是路径,与改动前一致。
        expect(created).toEqual(['http://127.0.0.1:4243/api/events?token=tok'])
        off1()
        off2()
      } finally {
        transport.configureWebTransport(undefined)
      }
    })
  })
})
