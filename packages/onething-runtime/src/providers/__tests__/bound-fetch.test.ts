import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearOnethingAppDispatcherCache,
  createOnethingAppHttpClient,
  createOnethingAppFetch,
  createOnethingDirectDispatcherOptions,
  createOnethingProxyDispatcherOptions,
  getOnethingAppDispatcher,
  resolveOnethingHttpPolicy,
  shouldBypassOnethingAppProxy,
  validateOnethingAppProxyUrl,
  type OnethingAppFetchNetworkInit,
  type OnethingProxySettings,
} from '../index.js'

beforeEach(() => {
  clearOnethingAppDispatcherCache()
})

describe('onething bound fetch proxy URL validation', () => {
  it('accepts supported proxy protocols', () => {
    expect(validateOnethingAppProxyUrl('http://127.0.0.1:7890').valid).toBe(true)
    expect(validateOnethingAppProxyUrl('https://proxy.example.com:8443').valid).toBe(true)
    expect(validateOnethingAppProxyUrl('socks5://127.0.0.1:7890').valid).toBe(true)
  })

  it('rejects empty, invalid, and unsupported proxy URLs', () => {
    expect(validateOnethingAppProxyUrl('').valid).toBe(false)
    expect(validateOnethingAppProxyUrl('not a url').valid).toBe(false)
    expect(validateOnethingAppProxyUrl('ftp://127.0.0.1:21').valid).toBe(false)
  })
})

describe('onething bound fetch proxy bypass rules', () => {
  it('matches local and wildcard hosts', () => {
    const rules = 'localhost;127.0.0.1;::1;*.local'

    expect(shouldBypassOnethingAppProxy('http://localhost:3000', rules)).toBe(true)
    expect(shouldBypassOnethingAppProxy('http://127.0.0.1:3000', rules)).toBe(true)
    expect(shouldBypassOnethingAppProxy('http://app.local', rules)).toBe(true)
    expect(shouldBypassOnethingAppProxy('https://api.openai.com/v1', rules)).toBe(false)
  })
})

describe('onething bound fetch dispatcher cache keys', () => {
  it('separates proxy URL combinations', () => {
    const proxy: OnethingProxySettings = { enabled: true, url: 'http://127.0.0.1:7890', bypassRules: 'localhost' }

    const first = getOnethingAppDispatcher(proxy)
    const same = getOnethingAppDispatcher(proxy)
    const differentProxy = getOnethingAppDispatcher({ ...proxy, url: 'http://127.0.0.1:7891' })

    expect(same).toBe(first)
    expect(differentProxy).not.toBe(first)
  })

  it('disables body inactivity timeout for long-running direct streams', () => {
    expect(createOnethingDirectDispatcherOptions().bodyTimeout).toBe(0)
  })

  it('disables body inactivity timeout for long-running proxied streams', () => {
    const options = createOnethingProxyDispatcherOptions({
      enabled: true,
      url: 'http://127.0.0.1:7890',
    })

    expect(options.bodyTimeout).toBe(0)
  })
})

describe('onething app fetch runtime adapters', () => {
  it('uses direct fetch when no proxy is active', async () => {
    const response = new Response('direct')
    const directFetch = vi.fn(async () => response)
    const networkFetch = vi.fn(async () => new Response('network'))
    const fetchImpl = createOnethingAppFetch({}, {
      directFetch,
      networkFetch,
    })

    await expect(fetchImpl('https://example.com')).resolves.toBe(response)
    expect(directFetch).toHaveBeenCalledWith('https://example.com', expect.objectContaining({
      signal: expect.any(AbortSignal),
    }))
    expect(networkFetch).not.toHaveBeenCalled()
  })

  it('resolves adapter settings at request time', async () => {
    const proxy: OnethingProxySettings = {
      enabled: true,
      url: 'http://127.0.0.1:7890',
      bypassRules: 'localhost',
    }
    const getProxySettings = vi.fn<() => OnethingProxySettings | undefined>()
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(proxy)
      .mockReturnValueOnce(proxy)
    const directFetch = vi.fn(async () => new Response('direct'))
    const networkFetch = vi.fn(async (_input: RequestInfo | URL, _init: OnethingAppFetchNetworkInit) => new Response('network'))
    const fetchImpl = createOnethingAppFetch({}, {
      getProxySettings,
      directFetch,
      networkFetch,
    })

    await fetchImpl('https://api.example.com/v1')
    await fetchImpl('http://localhost:3000')
    await fetchImpl('https://api.example.com/v1')

    expect(directFetch).toHaveBeenCalledTimes(2)
    expect(networkFetch).toHaveBeenCalledTimes(1)
    expect(networkFetch.mock.calls[0][1].dispatcher).toBeDefined()
  })

  it('logs target and proxy when network fetch fails', async () => {
    const error = new Error('connect failed')
    const logger = { error: vi.fn() }
    const fetchImpl = createOnethingAppFetch({
      policy: 'streaming',
      proxy: {
        enabled: true,
        url: 'http://proxy.example.com:7890',
      },
    }, {
      logger,
      networkFetch: vi.fn(async () => {
        throw error
      }),
    })

    await expect(fetchImpl('https://api.example.com/v1')).rejects.toBe(error)
    expect(logger.error).toHaveBeenCalledWith('[Network] App fetch failed:', expect.objectContaining({
      target: 'https://api.example.com/v1',
      proxy: 'http://proxy.example.com:7890/',
      message: 'connect failed',
    }))
  })
})

describe('onething http client policies', () => {
  it('resolves named policy defaults', () => {
    expect(resolveOnethingHttpPolicy({ policy: 'streaming' }).retry).toBe(false)
    expect(resolveOnethingHttpPolicy({ policy: 'webSearch' }).timeoutMs).toBe(10_000)
    expect(resolveOnethingHttpPolicy({ policy: 'auth' }).retry).toMatchObject({
      maxAttempts: 2,
      methods: expect.arrayContaining(['POST']),
    })
  })

  it('retries safe methods for retryable response statuses', async () => {
    const directFetch = vi.fn()
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
    const fetchImpl = createOnethingAppFetch({
      retry: {
        maxAttempts: 2,
        baseDelayMs: 0,
      },
    }, {
      directFetch,
    })

    const response = await fetchImpl('https://api.example.com/models')

    expect(response.status).toBe(200)
    expect(directFetch).toHaveBeenCalledTimes(2)
  })

  it('does not retry unsafe methods by default', async () => {
    const directFetch = vi.fn(async () => new Response('unavailable', { status: 503 }))
    const fetchImpl = createOnethingAppFetch({
      retry: {
        maxAttempts: 2,
        baseDelayMs: 0,
      },
    }, {
      directFetch,
    })

    const response = await fetchImpl('https://api.example.com/messages', { method: 'POST', body: '{}' })

    expect(response.status).toBe(503)
    expect(directFetch).toHaveBeenCalledTimes(1)
  })

  it('does not retry streaming policy requests', async () => {
    const directFetch = vi.fn(async () => new Response('unavailable', { status: 503 }))
    const fetchImpl = createOnethingAppFetch({ policy: 'streaming' }, { directFetch })

    const response = await fetchImpl('https://api.example.com/stream')

    expect(response.status).toBe(503)
    expect(directFetch).toHaveBeenCalledTimes(1)
  })

  it('exposes a fetch-compatible client adapter and json helper', async () => {
    const client = createOnethingAppHttpClient({ policy: 'streaming' }, {
      directFetch: vi.fn(async () => new Response('{"error":"failed"}', { status: 500 })),
    })
    const fetchImpl: typeof globalThis.fetch = client.createFetch()

    await expect(fetchImpl('https://api.example.com/status')).resolves.toHaveProperty('status', 500)
    await expect(client.json('https://api.example.com/status')).rejects.toMatchObject({
      name: 'OnethingHttpError',
      status: 500,
      details: expect.objectContaining({
        target: 'https://api.example.com/status',
        policy: 'streaming',
      }),
    })
  })
})

describe('onething app fetch abort after headers', () => {
  // 09-23 事故:头到之后摘了 abort 转发,流中途停住时按停止,body 读流一直挂着。
  it('aborting the caller signal mid-stream rejects the pending body read', async () => {
    const http = await import('node:http')
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: {"a":1}\n\n') // 然后停住,不再发、不断开
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }

    try {
      const controller = new AbortController()
      const fetchImpl = createOnethingAppFetch({}, { getProxySettings: () => undefined })
      const response = await fetchImpl(`http://127.0.0.1:${port}/`, {
        method: 'POST',
        body: '{}',
        signal: controller.signal,
      })
      const reader = response.body!.getReader()
      await reader.read()

      const pending = reader.read()
      controller.abort()
      const outcome = await Promise.race([
        pending.then(() => 'resolved', (error: Error) => error.name),
        new Promise<string>(resolve => setTimeout(() => resolve('hanging'), 2000)),
      ])
      expect(outcome).toBe('AbortError')
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
