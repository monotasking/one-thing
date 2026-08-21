/**
 * 发现文件(A 期,docs/design/one-core-2026-08.md §3)。
 *
 * 三条口径要守住:读永不抛、写落在 `<store>/run/http.json` 且权限收紧、
 * 「活着」是 pid + 端口两段判定 —— 只过一段不算。
 */
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getHttpDiscoveryPath,
  httpDiscoveryUrl,
  isHttpDiscoveryAlive,
  readHttpDiscovery,
  removeHttpDiscovery,
  writeHttpDiscovery,
  type HttpDiscoveryRecord,
} from '../discovery.js'

describe('http discovery file', () => {
  let storePath: string
  let previousStorePath: string | undefined

  beforeEach(() => {
    previousStorePath = process.env.ONETHING_STORE_PATH
    storePath = mkdtempSync(path.join(tmpdir(), 'onething-discovery-'))
    process.env.ONETHING_STORE_PATH = storePath
  })

  afterEach(() => {
    if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
    else process.env.ONETHING_STORE_PATH = previousStorePath
    rmSync(storePath, { recursive: true, force: true })
  })

  it('lands in <store>/run/http.json', () => {
    expect(getHttpDiscoveryPath()).toBe(path.join(storePath, 'run', 'http.json'))
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
