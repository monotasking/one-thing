/**
 * daemon 的四支 `resource.*`(原子 K4-b)。
 *
 * 与 `daemon-logging.test.ts` 同一条:`HeadlessBackend` 被替身掉 —— 本测试问的是
 * **「方法表上有没有这四支、参数怎么落到转发口上」**,不是「后端能不能装配」
 * (真把后端拉进来会顺带跑整棵工具树)。转发口再往下那一段(主体是本机用户、
 * 投影复用 RPC 域那三只)由 `packages/backend` 那边的资源门证。
 *
 * 它跑的是**真 socket**:起一台 `DaemonServer` 在临时 store 上,用真的
 * `DaemonClient` 连过去。所以这一份同时钉住了 NDJSON 那一层 —— 把 daemon 方法表
 * 里那四支拆掉,这里当场红(反证②)。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls: Array<{ method: string; args: unknown[] }> = []

/**
 * 替身后端。只实现 daemon 起停要用到的那几格 + 四只资源转发口。
 *
 * `ownedBackend` 要给出 `own` / `storeLease` / `runTask` 三样 —— `DaemonServer.start`
 * 与 `dispatch` 各自要一样,少一样就起不来。
 */
vi.mock('@onething/backend/wiring/headless/backend.js', () => ({
  HeadlessBackend: class {
    ownedBackend = {
      own: () => {},
      storeLease: { assertHeld: () => {} },
      runTask: <T>(_label: string, run: () => Promise<T>) => run(),
    }

    async start(): Promise<void> {}
    async shutdown(): Promise<void> {}
    getActiveStreams(): unknown[] { return [] }

    listResources() {
      calls.push({ method: 'listResources', args: [] })
      return { schemes: [{ scheme: 'session', title: 'Sessions' }] }
    }

    describeResource(scheme: string) {
      calls.push({ method: 'describeResource', args: [scheme] })
      if (scheme === 'nope') throw new Error(`No resource is registered for scheme: ${scheme}`)
      return { scheme, title: 'Sessions', reads: {}, ops: {}, events: {} }
    }

    async readResource(ref: string, name: string, query: unknown, sessionId?: string) {
      calls.push({ method: 'readResource', args: [ref, name, query, sessionId] })
      return { kind: 'ok', value: { id: 's1' } }
    }

    async doResource(ref: string, op: string, params: unknown, sessionId?: string) {
      calls.push({ method: 'doResource', args: [ref, op, params, sessionId] })
      return { kind: 'ok', text: 'done' }
    }
  },
}))

let storePath = ''
let stop: (() => Promise<void>) | undefined

describe('daemon 方法表:resource.list / describe / read / do', () => {
  beforeEach(() => {
    calls.length = 0
    vi.resetModules()
    storePath = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-resource-daemon-'))
  })

  afterEach(async () => {
    await stop?.()
    stop = undefined
    const logging = await import('@onething/backend/wiring/logging/index.js')
    await logging.shutdownAppLogging()
    fs.rmSync(storePath, { recursive: true, force: true })
  })

  async function connect() {
    const { DaemonServer } = await import('../daemon-server.js')
    const { DaemonClient } = await import('../daemon-client.js')
    const server = new DaemonServer({ storePath })
    await server.start()
    stop = () => server.stop('test over')
    const client = new DaemonClient({ storePath })
    await client.connect()
    return client
  }

  it('四支都在表上,参数原样落到转发口', async () => {
    const client = await connect()
    try {
      expect(await client.request('resource.list' as never)).toEqual({
        schemes: [{ scheme: 'session', title: 'Sessions' }],
      })
      expect(await client.request('resource.describe' as never, { scheme: 'session' }))
        .toMatchObject({ scheme: 'session', title: 'Sessions' })
      expect(await client.request('resource.read' as never, {
        ref: 'session:s1', name: 'get', query: { limit: 5 }, sessionId: 'origin-1',
      })).toEqual({ kind: 'ok', value: { id: 's1' } })
      expect(await client.request('resource.do' as never, {
        ref: 'session:s1', op: 'rename', params: { name: 'x' },
      })).toEqual({ kind: 'ok', text: 'done' })
    } finally {
      client.close()
    }

    expect(calls).toEqual([
      { method: 'listResources', args: [] },
      { method: 'describeResource', args: ['session'] },
      { method: 'readResource', args: ['session:s1', 'get', { limit: 5 }, 'origin-1'] },
      // 发起坐标缺席就是缺席 —— 不拿 ref 里那条会话顶上(K1 留账的那个病)。
      { method: 'doResource', args: ['session:s1', 'rename', { name: 'x' }, undefined] },
    ])
  })

  it('query / params 不给就是空表,不是 undefined 穿到内核', async () => {
    const client = await connect()
    try {
      await client.request('resource.read' as never, { ref: 'session:s1', name: 'get' })
      await client.request('resource.do' as never, { ref: 'session:s1', op: 'rename' })
    } finally {
      client.close()
    }
    expect(calls[0].args[2]).toEqual({})
    expect(calls[1].args[2]).toEqual({})
  })

  it('形状不对是 ERR_VALIDATION;「没有这种资源」原样过网络,不被折成校验错', async () => {
    const client = await connect()
    try {
      await expect(client.request('resource.read' as never, { name: 'get' }))
        .rejects.toMatchObject({ name: 'ERR_VALIDATION', message: 'ref is required' })
      await expect(client.request('resource.do' as never, { ref: 'session:s1' }))
        .rejects.toMatchObject({ name: 'ERR_VALIDATION', message: 'op is required' })
      await expect(client.request('resource.describe' as never, { scheme: 'nope' }))
        .rejects.toThrow(/No resource is registered for scheme: nope/)
    } finally {
      client.close()
    }
    // 「这条读法存不存在」**不在这里判** —— 那是自述说了算的事,内核会回 invalid。
    // 所以一个形状合法但读法不存在的请求照样要抵达转发口。
    calls.length = 0
    const second = await connect()
    try {
      await second.request('resource.read' as never, { ref: 'session:s1', name: 'no-such-read' })
    } finally {
      second.close()
    }
    expect(calls).toEqual([
      { method: 'readResource', args: ['session:s1', 'no-such-read', {}, undefined] },
    ])
  })
})
