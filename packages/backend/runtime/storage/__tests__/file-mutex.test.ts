import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withFileLockSync } from '../file-mutex.js'

const tempDirs: string[] = []

function tempLockPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-mutex-'))
  tempDirs.push(dir)
  return path.join(dir, 'index.json.lock')
}

describe('withFileLockSync', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('runs the critical section and releases the lock afterwards', () => {
    const lockPath = tempLockPath()
    const result = withFileLockSync(lockPath, () => {
      expect(fs.existsSync(lockPath)).toBe(true) // 持锁期间锁文件存在
      return 'ok'
    })
    expect(result).toBe('ok')
    expect(fs.existsSync(lockPath)).toBe(false) // 释放后清理
  })

  it('is reentrant within the same process (no self-deadlock)', () => {
    const lockPath = tempLockPath()
    const result = withFileLockSync(lockPath, () =>
      withFileLockSync(lockPath, () => 42),
    )
    expect(result).toBe(42)
    expect(fs.existsSync(lockPath)).toBe(false)
  })

  it('steals a stale lock whose holder process is dead', () => {
    const lockPath = tempLockPath()
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    // 写一个 holder 已死的锁文件(极大 pid,几乎不可能存活)。
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 2 ** 30, acquiredAt: Date.now() }))

    let ran = false
    withFileLockSync(lockPath, () => {
      ran = true
    }, { timeoutMs: 200, retryMs: 5 })

    expect(ran).toBe(true)
    expect(fs.existsSync(lockPath)).toBe(false)
  })

  it('proceeds without the lock when a live holder times it out (best-effort default)', () => {
    const lockPath = tempLockPath()
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    // 用当前进程 pid 冒充活着的 holder;因为没走 withFileLockSync 获取,不会命中重入捷径。
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }))
    const warn = vi.fn()

    let ran = false
    const result = withFileLockSync(lockPath, () => {
      ran = true
      return 'degraded'
    }, { timeoutMs: 40, retryMs: 10, logger: { warn } })

    expect(ran).toBe(true)
    expect(result).toBe('degraded')
    expect(warn).toHaveBeenCalled()
    // 未偷走活 holder 的锁
    expect(fs.existsSync(lockPath)).toBe(true)
  })

  it('throws on timeout when onTimeout is "throw"', () => {
    const lockPath = tempLockPath()
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }))

    expect(() =>
      withFileLockSync(lockPath, () => 'never', { timeoutMs: 40, retryMs: 10, onTimeout: 'throw' }),
    ).toThrow(/timed out/)
  })
})
