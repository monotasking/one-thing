/**
 * 发现文件(A 期,docs/design/one-core-2026-08.md §3)。
 *
 * 三条口径要守住:读永不抛、写落在 `<store>/run/http.json` 且权限收紧、
 * 「活着」是 pid + 端口两段判定 —— 只过一段不算。
 */
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getHttpDiscoveryPath,
  httpDiscoveryUrl,
  isHttpDiscoveryAlive,
  readHttpDiscovery,
  removeHttpDiscovery as removeDiscovery,
  writeHttpDiscovery as writeDiscovery,
  type HttpDiscoveryRecord,
} from '../discovery.js'
import { StoreLock } from '@onething/runtime/storage'

describe('http discovery file', () => {
  let storePath: string
  let previousStorePath: string | undefined
  let lease: StoreLock
  const writeHttpDiscovery = (record: HttpDiscoveryRecord) => writeDiscovery(record, { lease })
  const removeHttpDiscovery = () => removeDiscovery({ lease })

  beforeEach(async () => {
    previousStorePath = process.env.ONETHING_STORE_PATH
    storePath = mkdtempSync(path.join(tmpdir(), 'onething-discovery-'))
    process.env.ONETHING_STORE_PATH = storePath
    lease = new StoreLock({ storePath })
    await lease.acquire('server')
  })

  afterEach(() => {
    if (lease.held) lease.release()
    if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
    else process.env.ONETHING_STORE_PATH = previousStorePath
    rmSync(storePath, { recursive: true, force: true })
  })

  it('lands in <store>/run/http.json', () => {
    expect(getHttpDiscoveryPath()).toBe(path.join(storePath, 'run', 'http.json'))
  })

  it('an old lease cannot delete the successor discovery file', async () => {
    const previous = lease
    previous.release()
    lease = new StoreLock({ storePath })
    await lease.acquire('server')
    writeHttpDiscovery({ port: 2, host: '127.0.0.1', pid: process.pid, startedAt: 2, owner: 'server' })
    expect(() => removeDiscovery({ lease: previous })).toThrow()
    expect(readHttpDiscovery()?.port).toBe(2)
  })

  it('rejects discovery changes outside the held store', () => {
    expect(() => writeDiscovery({ port: 2, host: '127.0.0.1', pid: process.pid, startedAt: 2, owner: 'server' }, {
      lease, storePath: path.join(storePath, 'other-store'),
    })).toThrow('outside the held store lease')
    expect(existsSync(path.join(storePath, 'other-store'))).toBe(false)
  })

  it('round-trips a record and keeps the token file private', () => {
    const record: HttpDiscoveryRecord = {
      port: 41234,
      host: '127.0.0.1',
      token: 'secret-token',
      pid: process.pid,
      startedAt: 1_700_000_000_000,
      owner: 'desktop',
    }
    const filePath = writeHttpDiscovery(record)
    expect(readHttpDiscovery()).toEqual(record)
    // token 躺在盘上 —— 0600,不是 0644。
    expect(statSync(filePath).mode & 0o777).toBe(0o600)
  })

  it('overwrites an existing file and still clamps the mode', () => {
    mkdirSync(path.join(storePath, 'run'), { recursive: true })
    writeFileSync(path.join(storePath, 'run', 'http.json'), 'garbage', { mode: 0o644 })
    const filePath = writeHttpDiscovery({
      port: 1, host: '127.0.0.1', pid: process.pid, startedAt: 0, owner: 'server',
    })
    expect(statSync(filePath).mode & 0o777).toBe(0o600)
    expect(readHttpDiscovery()?.owner).toBe('server')
  })

  /**
   * A1(2026-08-31)给 owner 加了第三个值 `shell`(React 壳内嵌的那只 core)。
   * 两条一起断言:新值认得,而白名单**没有因此变宽** —— 下面那条
   * `someone-else` 仍旧被当没有。
   */
  it('round-trips the shell owner', () => {
    writeHttpDiscovery({
      port: 1, host: '127.0.0.1', pid: process.pid, startedAt: 0, owner: 'shell',
    })
    expect(readHttpDiscovery()?.owner).toBe('shell')
  })

  it('never throws on a missing, corrupt or misshaped file', () => {
    expect(readHttpDiscovery()).toBeUndefined()
    mkdirSync(path.join(storePath, 'run'), { recursive: true })
    writeFileSync(path.join(storePath, 'run', 'http.json'), 'not json')
    expect(readHttpDiscovery()).toBeUndefined()
    writeFileSync(path.join(storePath, 'run', 'http.json'), JSON.stringify({ port: 0, host: '' }))
    expect(readHttpDiscovery()).toBeUndefined()
    // owner 不认识 = 不是我们写的,当没有。
    writeFileSync(
      path.join(storePath, 'run', 'http.json'),
      JSON.stringify({ port: 1, host: 'h', pid: 1, owner: 'someone-else' }),
    )
    expect(readHttpDiscovery()).toBeUndefined()
  })

  it('removes the file and stays quiet when it is already gone', () => {
    writeHttpDiscovery({ port: 1, host: '127.0.0.1', pid: process.pid, startedAt: 0, owner: 'server' })
    removeHttpDiscovery()
    expect(readHttpDiscovery()).toBeUndefined()
    expect(() => removeHttpDiscovery()).not.toThrow()
  })

  /**
   * C0 R5。删的判据是**这份是不是我写的**,不是"盘上有没有文件"。
   * 反证(实跑过):把 `if (record?.pid !== process.pid) return` 那一句摘掉 →
   * 第一段立刻红(别人的宣告被删掉了)。
   */
  it('C0 R5:别人 pid 的宣告不删,自己 pid 的才删', () => {
    writeHttpDiscovery({
      port: 1,
      host: '127.0.0.1',
      // 一个绝不可能是自己的 pid(1 = init;这份测试跑在 vitest worker 里)。
      pid: process.pid + 1,
      startedAt: 0,
      owner: 'desktop',
    })
    removeHttpDiscovery()
    expect(readHttpDiscovery()?.pid).toBe(process.pid + 1)

    writeHttpDiscovery({ port: 2, host: '127.0.0.1', pid: process.pid, startedAt: 0, owner: 'shell' })
    removeHttpDiscovery()
    expect(readHttpDiscovery()).toBeUndefined()
  })

  /** 坏文件 / 读不出来时也不删 —— "读不到" 不等于 "是我的"。 */
  it('C0 R5:解析不了的文件不删', () => {
    mkdirSync(path.join(storePath, 'run'), { recursive: true })
    writeFileSync(path.join(storePath, 'run', 'http.json'), 'not json at all')
    removeHttpDiscovery()
    expect(existsSync(path.join(storePath, 'run', 'http.json'))).toBe(true)
  })

  describe('isHttpDiscoveryAlive', () => {
    it('is false without a record', async () => {
      await expect(isHttpDiscoveryAlive(undefined)).resolves.toBe(false)
    })

    it('is false when the pid is gone even if something answers the port', async () => {
      const server = createServer((_req, response) => response.end())
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      try {
        // pid 1 之外挑一个几乎不可能存在的:2^22 是 Linux 默认上限之上。
        await expect(isHttpDiscoveryAlive({
          port, host: '127.0.0.1', pid: 4_194_305, startedAt: 0, owner: 'server',
        })).resolves.toBe(false)
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()))
      }
    })

    it('is false when the pid lives but nothing listens on the port', async () => {
      const server = createServer((_req, response) => response.end())
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      await new Promise<void>(resolve => server.close(() => resolve()))
      await expect(isHttpDiscoveryAlive(
        { port, host: '127.0.0.1', pid: process.pid, startedAt: 0, owner: 'server' },
        { timeoutMs: 200 },
      )).resolves.toBe(false)
    })

    it('is true when both the pid and the port answer', async () => {
      const server = createServer((_req, response) => response.end())
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      try {
        await expect(isHttpDiscoveryAlive({
          port, host: '127.0.0.1', pid: process.pid, startedAt: 0, owner: 'desktop',
        })).resolves.toBe(true)
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()))
      }
    })
  })

  it('formats a url', () => {
    expect(httpDiscoveryUrl({
      port: 5, host: '127.0.0.1', pid: 1, startedAt: 0, owner: 'server',
    })).toBe('http://127.0.0.1:5')
    expect(httpDiscoveryUrl({
      port: 5, host: '::1', pid: 1, startedAt: 0, owner: 'server',
    })).toBe('http://[::1]:5')
  })
})

/**
 * **一把尺子**(C0,`docs/design/client-sdk-2026-09.md` §9 留账那条)。
 *
 * 判活与记录形状已经搬进 `@shared/backend/http-discovery.ts`,好让
 * `@onething/client/node`(禁 import backend / runtime)问同一个「core 活没活」。
 * 代价是那份 shared 模块必须自己解析 store 根目录 —— 于是有了两处三段解析。
 * **它们不许分叉,而这件事由这一格钉住,不由注释保证**:上面那句注释一旦成了
 * 谎话(比如 shared 那边忘了认 `ONETHING_STORE_PATH`),这里当场红。
 */
describe('discovery 的 store 解析与 @shared 那份同形', () => {
  let storePath: string
  let previousStorePath: string | undefined

  beforeEach(() => {
    previousStorePath = process.env.ONETHING_STORE_PATH
    storePath = mkdtempSync(path.join(tmpdir(), 'onething-discovery-shared-'))
    process.env.ONETHING_STORE_PATH = storePath
  })

  afterEach(() => {
    if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
    else process.env.ONETHING_STORE_PATH = previousStorePath
    rmSync(storePath, { recursive: true, force: true })
  })

  it('显式 storePath / 环境变量 / 缺省家目录 三段都对得上', async () => {
    const { resolveOnethingStoreRoot, httpDiscoveryPathIn } =
      await import('@shared/backend/http-discovery.js')
    const { getOnethingStorePath } = await import('@onething/runtime/storage')

    // ① 环境变量那一段
    expect(resolveOnethingStoreRoot()).toBe(getOnethingStorePath())
    expect(httpDiscoveryPathIn(resolveOnethingStoreRoot())).toBe(getHttpDiscoveryPath())

    // ② 显式 storePath 压过环境变量
    const explicit = path.join(storePath, 'elsewhere')
    expect(resolveOnethingStoreRoot(explicit)).toBe(getOnethingStorePath({ storePath: explicit }))

    // ③ 两者都没有 → 家目录下的 `.onething`
    delete process.env.ONETHING_STORE_PATH
    expect(resolveOnethingStoreRoot()).toBe(getOnethingStorePath())
    expect(resolveOnethingStoreRoot()).toBe(path.join(homedir(), '.onething'))
  })
})
