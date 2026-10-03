/**
 * Worker 线程里的出网(2026-09-17)。
 *
 * 判的是四件事,每一件都对应事故里的一段:
 *  ① 代理开着 → 请求**真的走过代理**(起一只真的 CONNECT 隧道代理数一数);
 *  ② 答复裹回**全局** `Response` —— 判不过 `instanceof` 的话 transformers 不写磁盘缓存
 *     (`hub.js:566`),每次起 Worker 重下 110MB;
 *  ③ `bypassRules` 命中 → 走**原件**,不经代理(与 provider 那条路同一份判据);
 *  ④ 关着 / URL 非法 → 一个字都不做,还原函数把 `fetch` 放回去。
 */

import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import { captureRuntimeLogs } from '../../../logging/index.js'
import {
  installWorkerProxyFetch,
  resolveHuggingFaceEndpoint,
  toGlobalResponse,
  type FetchHolder,
} from '../worker-network.js'

interface Closeable { close(): Promise<void> }

/** 一台答 `hello` 的目标站。 */
async function startTarget(): Promise<{ url: string } & Closeable> {
  const server = http.createServer((_req, res) => { res.writeHead(200); res.end('hello') })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>(resolve => { server.close(() => { resolve() }) }),
  }
}

/**
 * 一台真的 CONNECT 隧道代理。
 *
 * **必须是隧道式的**:本机实测 undici 的 `ProxyAgent` 对 `http://` 的目标**也发
 * CONNECT**(不是绝对 URI 的转发式请求)。第一版写成转发式,`fetch` 当场挂死 ——
 * 这条注释就是那次的病历。
 */
async function startTunnelProxy(): Promise<{ url: string; connects: string[] } & Closeable> {
  const connects: string[] = []
  // `http` 的 `connect` 事件给的是 `Duplex`(不保证是 `net.Socket`),`net.connect`
  // 给的是 `net.Socket` —— 这一只集合两种都收,所以按两者的公共面写。
  const sockets = new Set<{ destroy(): void }>()
  const server = http.createServer((_req, res) => { res.writeHead(400); res.end() })
  server.on('connect', (request, clientSocket, head: Buffer) => {
    connects.push(request.url ?? '')
    const [host, port] = (request.url ?? '').split(':')
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    sockets.add(clientSocket)
    sockets.add(upstream)
    upstream.on('error', () => { clientSocket.destroy() })
    clientSocket.on('error', () => { upstream.destroy() })
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    connects,
    close: () => new Promise<void>(resolve => {
      for (const socket of sockets) socket.destroy()
      server.close(() => { resolve() })
    }),
  }
}

function holderWith(fetchImpl: typeof globalThis.fetch): FetchHolder {
  return { fetch: fetchImpl }
}

describe('installWorkerProxyFetch', () => {
  const cleanups: Array<() => void | Promise<void>> = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0, cleanups.length).reverse()) await cleanup()
  })

  it('① 代理开着:请求真的走过代理,②答复是全局 Response', async () => {
    const target = await startTarget()
    const proxy = await startTunnelProxy()
    cleanups.push(() => target.close(), () => proxy.close())

    const holder = holderWith(globalThis.fetch)
    const restore = installWorkerProxyFetch({ enabled: true, url: proxy.url }, holder)
    cleanups.push(restore)

    const response = await holder.fetch(`${target.url}/model.json`)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('hello')
    // ② 判不过这一条,transformers 就不会把模型写进磁盘缓存(见文件头)。
    expect(response instanceof Response).toBe(true)
    expect(proxy.connects.length).toBe(1)
  })

  it('③ bypassRules 命中就走原件,一次都不碰代理', async () => {
    const target = await startTarget()
    const proxy = await startTunnelProxy()
    cleanups.push(() => target.close(), () => proxy.close())

    let direct = 0
    const original: typeof globalThis.fetch = async (input, init) => {
      direct += 1
      return await globalThis.fetch(input, init)
    }
    const holder = holderWith(original)
    const restore = installWorkerProxyFetch(
      { enabled: true, url: proxy.url, bypassRules: '127.0.0.1;localhost' },
      holder,
    )
    cleanups.push(restore)

    const response = await holder.fetch(`${target.url}/model.json`)
    expect(response.status).toBe(200)
    expect(direct).toBe(1)
    expect(proxy.connects.length).toBe(0)
  })

  it('③b 同一张绕过表:表里那个主机走原件,不在表里的那个走代理', async () => {
    const target = await startTarget()
    const proxy = await startTunnelProxy()
    cleanups.push(() => target.close(), () => proxy.close())
    const { port } = new URL(target.url)

    let direct = 0
    const original: typeof globalThis.fetch = async (input, init) => {
      direct += 1
      return await globalThis.fetch(input, init)
    }
    const holder = holderWith(original)
    // 表里只有 `localhost`。`localhost` 与 `127.0.0.1` 指着同一台机器,但**判据是主机名**
    // —— 与 provider 那条路逐字同一份实现,这一条证的正是「同一份」。
    const restore = installWorkerProxyFetch(
      { enabled: true, url: proxy.url, bypassRules: 'localhost' },
      holder,
    )
    cleanups.push(restore)

    await holder.fetch(`http://localhost:${port}/a`)
    expect(direct).toBe(1)
    expect(proxy.connects.length).toBe(0)

    await holder.fetch(`http://127.0.0.1:${port}/b`)
    expect(direct).toBe(1)
    expect(proxy.connects).toEqual([`127.0.0.1:${port}`])
  })

  it('④ 关着 / 缺席 / URL 非法都不换 fetch,还原函数放得回去', () => {
    const original = (async () => new Response('')) as typeof globalThis.fetch

    const off = holderWith(original)
    installWorkerProxyFetch({ enabled: false, url: 'http://127.0.0.1:7890' }, off)
    expect(off.fetch).toBe(original)

    const absent = holderWith(original)
    installWorkerProxyFetch(undefined, absent)
    expect(absent.fetch).toBe(original)

    const logs = captureRuntimeLogs()
    try {
      const broken = holderWith(original)
      installWorkerProxyFetch({ enabled: true, url: 'not a url' }, broken)
      // 非法 URL **不抛**:语义召回不该因为代理那一格填错而把整条 Worker 带走。
      expect(broken.fetch).toBe(original)
      expect(logs.ofLevel('warn').map(record => record.msg))
        .toContain('proxy setting is not a usable URL; the model download goes direct')
    } finally {
      logs.restore()
    }

    const live = holderWith(original)
    const restore = installWorkerProxyFetch({ enabled: true, url: 'http://127.0.0.1:7890' }, live)
    expect(live.fetch).not.toBe(original)
    restore()
    expect(live.fetch).toBe(original)
  })
})

describe('toGlobalResponse', () => {
  it('已经是全局那一只就原样返回(不白裹一层)', () => {
    const response = new Response('x', { status: 200 })
    expect(toGlobalResponse(response)).toBe(response)
  })
})

describe('resolveHuggingFaceEndpoint', () => {
  it('设了就答那一个,空白与缺席都答 undefined', () => {
    expect(resolveHuggingFaceEndpoint({ HF_ENDPOINT: 'https://hf-mirror.com' })).toBe('https://hf-mirror.com')
    expect(resolveHuggingFaceEndpoint({ HF_ENDPOINT: '  ' })).toBeUndefined()
    expect(resolveHuggingFaceEndpoint({})).toBeUndefined()
  })
})
