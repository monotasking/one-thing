/**
 * **全局事件走既有的 `GET /api/events`**(原子 K2a',`docs/design/atom-2026-09.md`
 * §4 / §9 K2)。
 *
 * K2a 把资源事件转成了总线上的一条全局事件,但那条 SSE **对全局事件没有出口** ——
 * 全仓非测试代码只有三处 `onGlobal(`,`/api/events` 上一处都没有。于是 `resource:event`
 * 只到得了进程内的订阅者,壳收不到。这只文件钉的就是那条出口。
 *
 * 三条用例:
 *
 * 1. **一次真的 `do` 走完管线之后,SSE 上出现一帧 `resource:event`。** 用的是真装配
 *    (`createAppServerRuntime` → `createOnethingBackend`),不是往总线上手塞一条 ——
 *    要证的是「资源事件 → hub → 总线 → SSE」这条整链,手塞会跳过前两段。
 * 2. **出网名单是表说了算。** `mcp:server-error` / `plugin:error` 那种自由文本错误
 *    (结构上带本机路径与 stdio 命令行)不出网;`settings:changed` 也不从这条路走
 *    —— 它在同一条 SSE 上已经有一帧脱敏过的整份设置,两种载荷形状挂一个事件名下,
 *    客户端就得先猜自己收到的是哪一种。
 * 3. **它不占会话事件的序号。** 全局事件不进任何一条会话的环形缓冲,所以帧里没有
 *    `id:` —— 重连的 `Last-Event-ID` 只对会话事件的 seq 有意义。
 */
import { once } from 'node:events'
import type { Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SerializedResourceSpec } from '@shared/ipc/resources.js'
import { createOnethingHttpServer } from '../http.js'
import type { OnethingServerRuntime } from '../runtime.js'
import { createAppServerRuntime } from './test-helpers.js'

const servers: Server[] = []
const runtimes: OnethingServerRuntime[] = []
const tempDirs: string[] = []
const originalStorePath = process.env.ONETHING_STORE_PATH

const SESSION = '5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f'
const PRINCIPAL = { kind: 'user', userId: 'local' } as const

/** 一份假的壳自述(K2b-2)。装配、内核、RPC 域里一个 `workbench` 字都没有。 */
const WORKBENCH_SPEC: SerializedResourceSpec = {
  scheme: 'workbench',
  title: 'Workbench',
  reads: {},
  ops: {
    open: {
      title: 'Open a tile',
      params: { type: 'object', properties: {}, required: [] },
      effects: ['ui_change'],
      home: 'shell',
    },
  },
  events: {},
}

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onething-global-events-sse-'))
  tempDirs.push(dir)
  process.env.ONETHING_STORE_PATH = dir
})

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.close()
    await once(server, 'close').catch(() => {})
  }
  for (const runtime of runtimes.splice(0)) await runtime.shutdown()
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  if (originalStorePath === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = originalStorePath
})

async function listen(server: Server): Promise<Server> {
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server
}

function baseUrl(server: Server): string {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Server did not bind a TCP port')
  return `http://${address.address}:${address.port}`
}

async function readUntil(
  response: Response,
  predicate: (text: string) => boolean,
  timeoutMs = 5000,
): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Response body is not readable')
  const decoder = new TextDecoder()
  let text = ''
  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now())
      const result = await Promise.race([
        reader.read(),
        new Promise<ReadableStreamReadResult<Uint8Array>>(resolve => {
          setTimeout(() => resolve({ done: true, value: undefined }), remaining)
        }),
      ])
      if (result.done) break
      text += decoder.decode(result.value, { stream: true })
      if (predicate(text)) return text
    }
    throw new Error(`Timed out waiting for SSE payload. Received: ${text}`)
  } finally {
    await reader.cancel().catch(() => {})
  }
}

/** 取出一帧具名 SSE 事件(整帧,含 `id:` 行 —— 有没有那一行是本文件的判据之一)。 */
function sseFrame(text: string, eventName: string): string {
  const frame = text.split('\n\n').find(part => part.includes(`event: ${eventName}`))
  if (!frame) throw new Error(`No "${eventName}" frame in: ${text}`)
  return frame
}

function sseData(text: string, eventName: string): unknown {
  const dataLine = sseFrame(text, eventName).split('\n').find(line => line.startsWith('data: '))
  if (!dataLine) throw new Error(`"${eventName}" frame carried no data`)
  return JSON.parse(dataLine.slice('data: '.length))
}

async function startRuntime(): Promise<OnethingServerRuntime> {
  const serverRuntime = await createAppServerRuntime({ storePath: process.env.ONETHING_STORE_PATH! })
  runtimes.push(serverRuntime)
  return serverRuntime
}

describe('全局事件走既有的 GET /api/events', () => {
  it('一次 do 之后,SSE 上收到一帧 resource:event', async () => {
    const serverRuntime = await startRuntime()
    const backend = serverRuntime.backend
    expect(backend).toBeTruthy()
    await serverRuntime.runtime.sessions.create('Rename me', undefined, SESSION)
    const server = await listen(createOnethingHttpServer({ runtime: serverRuntime.runtime }))

    const stream = await fetch(`${baseUrl(server)}/api/events`)
    expect(stream.headers.get('content-type')).toContain('text/event-stream')
    // 订阅是在 handleEvents 里挂上的,发之前先让连接建立。
    await new Promise(resolve => setTimeout(resolve, 50))

    const outcome = await backend!.resources.do(
      `session:${SESSION}`,
      'rename',
      { title: 'Renamed over SSE' },
      { principal: PRINCIPAL },
    )
    expect(outcome.kind).toBe('ok')

    const text = await readUntil(stream, value => value.includes('event: resource:event'))
    expect(sseData(text, 'resource:event')).toMatchObject({
      type: 'resource:event',
      ref: `session:${SESSION}`,
      event: 'renamed',
    })
    // 不占会话事件的序号:这一帧没有 `id:` 行(`?after=` 也就不会回放它)。
    expect(sseFrame(text, 'resource:event')).not.toContain('id: ')
  })

  /**
   * K2b-2 —— **壳命令是这条出口今天唯一的「非事实」乘客**,所以它单独钉一条。
   *
   * `resource:event` 证的是「一条事实出得了网」;这一条证的是往**反方向**的那一半:
   * 一条 `home: 'shell'` 的做法在 core 里走完管线之后,`apply` 那一步真的到得了壳
   * (§5「资源的家在哪就去哪跑」)。整条往返都在这里跑一遍 —— 命令骑 SSE 出去,
   * 回执骑 `shellResult` 回来,`do` 拿到 `ok`。
   */
  it('一条 home:shell 的做法:命令出得了网,回执回得来', async () => {
    const serverRuntime = await startRuntime()
    const backend = serverRuntime.backend
    expect(backend).toBeTruthy()
    expect(await backend!.shellResources.mountShell('sse-shell', WORKBENCH_SPEC)).toEqual({ ok: true })
    const server = await listen(createOnethingHttpServer({ runtime: serverRuntime.runtime }))

    const stream = await fetch(`${baseUrl(server)}/api/events`)
    await new Promise(resolve => setTimeout(resolve, 50))

    const pending = backend!.resources.do('workbench:center', 'open', {}, { principal: PRINCIPAL })
    const text = await readUntil(stream, value => value.includes('event: resource:shell-command'))
    const command = sseData(text, 'resource:shell-command') as { shellId: string; callId: string; kind: string }
    expect(command).toMatchObject({
      type: 'resource:shell-command',
      shellId: 'sse-shell',
      kind: 'op',
      ref: 'workbench:center',
      op: 'open',
    })
    // 全局事件不占会话事件的序号,所以这一帧也没有 `id:`。
    expect(sseFrame(text, 'resource:shell-command')).not.toContain('id: ')

    backend!.shellResources.settleResult('sse-shell', command.callId, { kind: 'ok', text: 'opened' })
    expect((await pending).kind).toBe('ok')
  })

  it('出网名单说不出网的,一帧都不发', async () => {
    const serverRuntime = await startRuntime()
    const server = await listen(createOnethingHttpServer({ runtime: serverRuntime.runtime }))

    const stream = await fetch(`${baseUrl(server)}/api/events`)
    await new Promise(resolve => setTimeout(resolve, 50))

    // 两条自由文本错误(结构上带本机路径 / stdio 命令行)+ 一条已经有别的载荷形状
    // 的同名事件。三条都往总线上放,断言 SSE 上一条都没有。
    serverRuntime.eventBus.emitGlobal({
      type: 'mcp:server-error',
      serverId: 'demo',
      error: '/Users/someone/.onething/mcp/demo --token=sk-secret failed',
    } as never)
    serverRuntime.eventBus.emitGlobal({
      type: 'plugin:error',
      pluginId: 'demo',
      error: '/Users/someone/.onething/plugins/node_modules/demo/index.js: boom',
    } as never)
    serverRuntime.eventBus.emitGlobal({ type: 'settings:changed', changedKeys: ['ai'] } as never)
    // 一条出得了网的,当成「流真的活着」的对照 —— 否则「什么都没收到」这条断言
    // 会因为流根本没通而假绿。
    serverRuntime.eventBus.emitGlobal({ type: 'app:initialized', timestamp: Date.now() } as never)

    const text = await readUntil(stream, value => value.includes('event: app:initialized'))
    expect(text).not.toContain('mcp:server-error')
    expect(text).not.toContain('sk-secret')
    expect(text).not.toContain('plugin:error')
    expect(text).not.toContain('settings:changed')
  })
})
