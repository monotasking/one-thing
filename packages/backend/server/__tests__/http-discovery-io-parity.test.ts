/**
 * 发现文件的读与判活有两份实现(server / client 拆分第②步,2026-10-02):
 * `packages/backend/server/http-discovery-io.ts`(后端)与 `packages/client/http-discovery-io.ts`
 * (`@onething/client/node`)。shared 不许碰 node,server 与 client 互不 import,所以只能各放一份;
 * 「两份不许分叉」由这里钉住 —— 同一组样例喂两边,答案必须逐个相等。
 *
 * 测试不受包方向约束,所以这里可以同时 import 两边。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as server from '../http-discovery-io.js'
import * as client from '@onething/client/http-discovery-io.js'
import type { HttpDiscoveryRecord } from '@shared/backend/http-discovery.js'

let dir: string
let listener: Server
let openPort: number
let closedPort: number

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'onething-discovery-parity-'))
  listener = createServer()
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
  openPort = (listener.address() as { port: number }).port
  // 一个刚关掉的端口:先占住拿到号,再放掉。
  const probe = createServer()
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
  closedPort = (probe.address() as { port: number }).port
  await new Promise<void>(resolve => probe.close(() => resolve()))
})

afterAll(async () => {
  await new Promise<void>(resolve => listener.close(() => resolve()))
  rmSync(dir, { recursive: true, force: true })
})

const FILE_SAMPLES: Array<[string, string | null]> = [
  ['missing', null],
  ['not-json', '{ nope'],
  ['wrong-shape', JSON.stringify({ port: 'x', host: 'h', pid: 1, owner: 'server' })],
  ['unknown-owner', JSON.stringify({ port: 1, host: '127.0.0.1', pid: 1, owner: 'robot' })],
  ['minimal', JSON.stringify({ port: 4242, host: '127.0.0.1', pid: 7, owner: 'server' })],
  ['full', JSON.stringify({ port: 4242, host: '::1', token: 'secret', pid: 7, startedAt: 123, owner: 'shell', cdp: { port: 9333 } })],
  ['empty-token-bad-cdp', JSON.stringify({ port: 4242, host: 'localhost', token: '', pid: 7, startedAt: 'x', owner: 'desktop', cdp: { port: 0 }, extra: 1 })],
]

describe('server 与 client 两份发现文件读法逐字同答', () => {
  it('readHttpDiscoveryAt:同一组文件,两边读出同一条记录(或同样读不出)', () => {
    for (const [name, content] of FILE_SAMPLES) {
      const filePath = path.join(dir, `${name}.json`)
      if (content !== null) writeFileSync(filePath, content)
      expect(client.readHttpDiscoveryAt(filePath), name).toEqual(server.readHttpDiscoveryAt(filePath))
    }
  })

  it('isPidAlive:同一组 pid,两边同答', () => {
    for (const pid of [process.pid, 0, -1, 1.5, Number.NaN, 2 ** 31 - 1]) {
      expect(client.isPidAlive(pid), String(pid)).toBe(server.isPidAlive(pid))
    }
  })

  it('isHttpDiscoveryAlive:没记录 / pid 不在 / 端口不通 / 两段都过,两边同答', async () => {
    const record = (pid: number, port: number): HttpDiscoveryRecord =>
      ({ port, host: '127.0.0.1', pid, startedAt: 0, owner: 'server' })
    const samples: Array<[string, HttpDiscoveryRecord | undefined]> = [
      ['no-record', undefined],
      ['dead-pid', record(2 ** 31 - 1, openPort)],
      ['closed-port', record(process.pid, closedPort)],
      ['alive', record(process.pid, openPort)],
    ]
    for (const [name, sample] of samples) {
      const [fromClient, fromServer] = await Promise.all([
        client.isHttpDiscoveryAlive(sample, { timeoutMs: 500 }),
        server.isHttpDiscoveryAlive(sample, { timeoutMs: 500 }),
      ])
      expect(fromClient, name).toBe(fromServer)
      // 样例真的覆盖了两个分支(否则两边都答 false 也算「同答」)。
      expect(fromServer, name).toBe(name === 'alive')
    }
  })
})
