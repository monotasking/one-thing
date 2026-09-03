// @vitest-environment node
/**
 * `@onething/client/node` 的 `readCoreDiscovery` —— 三态。
 *
 * 每一格都用真文件系统 + 真端口(临时目录 / `listen(0)`),因为被测的正是"文件在不在、
 * pid 活没活、端口通不通"这三件真事;把 `node:fs` / `node:net` mock 掉就等于把要证的
 * 东西证没了(判活假绿 = CLI 连一台死 core)。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { readCoreDiscovery } from '../node.js'

let storeRoot: string
let server: Server | undefined

function writeDiscovery(record: Record<string, unknown>): void {
  const runDir = path.join(storeRoot, 'run')
  mkdirSync(runDir, { recursive: true })
  writeFileSync(path.join(runDir, 'http.json'), JSON.stringify(record, null, 2))
}

beforeEach(() => {
  storeRoot = mkdtempSync(path.join(os.tmpdir(), 'onething-client-discovery-'))
})

afterEach(async () => {
  if (server) {
    await new Promise<void>(resolve => {
      server?.closeAllConnections?.()
      server?.close(() => resolve())
    })
    server = undefined
  }
  rmSync(storeRoot, { recursive: true, force: true })
})

describe('readCoreDiscovery', () => {
  it('① 没有发现文件 → undefined', async () => {
    await expect(readCoreDiscovery({ storePath: storeRoot })).resolves.toBeUndefined()
  })

  it('① 文件坏了 / 形状不对 → undefined,不抛(线索不是契约)', async () => {
    mkdirSync(path.join(storeRoot, 'run'), { recursive: true })
    writeFileSync(path.join(storeRoot, 'run', 'http.json'), '{ not json')
    await expect(readCoreDiscovery({ storePath: storeRoot })).resolves.toBeUndefined()

    writeDiscovery({ port: 1, host: '127.0.0.1', pid: 1, owner: 'martian' })
    await expect(readCoreDiscovery({ storePath: storeRoot })).resolves.toBeUndefined()
  })

  it('② pid 死了 → 交出记录但 alive:false,并且**不删文件**', async () => {
    // 2^22 之上的 pid 在 macOS/Linux 上不可能存在。
    writeDiscovery({
      port: 65000, host: '127.0.0.1', pid: 4194304, startedAt: 1, owner: 'shell', token: 't',
    })
    const found = await readCoreDiscovery({ storePath: storeRoot, timeoutMs: 100 })
    expect(found).toMatchObject({ alive: false, owner: 'shell', pid: 4194304 })

    // 再读一次还在 —— 探活失败不是删除的理由(删只由写它的进程按 pid 做)。
    await expect(readCoreDiscovery({ storePath: storeRoot, timeoutMs: 100 }))
      .resolves.toMatchObject({ alive: false })
  })

  it('② pid 活着但端口不通 → alive:false(只看 pid 会被复用骗)', async () => {
    // 关掉的端口:先起再关,拿一个确定没人听的号。
    const probe = createServer()
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
    const { port } = probe.address() as AddressInfo
    await new Promise<void>(resolve => probe.close(() => resolve()))

    writeDiscovery({
      port, host: '127.0.0.1', pid: process.pid, startedAt: 1, owner: 'server',
    })
    await expect(readCoreDiscovery({ storePath: storeRoot, timeoutMs: 200 }))
      .resolves.toMatchObject({ alive: false, owner: 'server' })
  })

  it('③ pid 活着 + 端口通 → alive:true,baseUrl / token 直接能喂给传输', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200)
      response.end()
    })
    await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo

    writeDiscovery({
      port, host: '127.0.0.1', pid: process.pid, startedAt: Date.now(), owner: 'shell', token: 'live-token',
    })
    await expect(readCoreDiscovery({ storePath: storeRoot, timeoutMs: 500 })).resolves.toMatchObject({
      alive: true,
      owner: 'shell',
      token: 'live-token',
      baseUrl: `http://127.0.0.1:${port}`,
    })
  })

  it('没有 token 的 core:token 缺席而不是空串', async () => {
    server = createServer((_request, response) => { response.end() })
    await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    writeDiscovery({ port, host: '127.0.0.1', pid: process.pid, startedAt: 1, owner: 'desktop' })
    const found = await readCoreDiscovery({ storePath: storeRoot, timeoutMs: 500 })
    expect(found?.alive).toBe(true)
    expect('token' in (found ?? {})).toBe(false)
  })

  it('storePath 缺席时走 ONETHING_STORE_PATH', async () => {
    const previous = process.env.ONETHING_STORE_PATH
    process.env.ONETHING_STORE_PATH = storeRoot
    try {
      writeDiscovery({ port: 1, host: '127.0.0.1', pid: 4194304, startedAt: 1, owner: 'server' })
      await expect(readCoreDiscovery({ timeoutMs: 100 })).resolves.toMatchObject({ owner: 'server' })
    } finally {
      if (previous === undefined) delete process.env.ONETHING_STORE_PATH
      else process.env.ONETHING_STORE_PATH = previous
    }
  })
})
