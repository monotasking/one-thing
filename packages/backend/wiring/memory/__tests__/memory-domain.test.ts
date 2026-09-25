/**
 * 内存预算表的装配门(2026-09-25):一只真装配的 backend 上,`memory.report`
 * 看得到装配处登记的三只持有者与本进程探针;`memory.trim` 只给本机可信的调用方;
 * dispose 之后表跟着实例一起没了。
 */
import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { resolveMemoryBudget } from '../index.js'

const previousStorePath = process.env.ONETHING_STORE_PATH
const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-memory-domain-'))
process.env.ONETHING_STORE_PATH = storeRoot

afterAll(async () => {
  const { getCurrentBackendSafe, setCurrentBackend } = await import('../../../current.js')
  if (getCurrentBackendSafe()) setCurrentBackend(null)
  if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previousStorePath
  fs.rmSync(storeRoot, { recursive: true, force: true })
})

class NoopSender extends EventEmitter {
  isDestroyed(): boolean { return false }
  send(): void {}
}

async function assemble(localTrust: { origin: 'desktop-embedded' } | null) {
  const { createOnethingBackend } = await import('../../../backend.js')
  return createOnethingBackend({
    host: {
      storePath: {}, sandbox: {}, auth: null, logging: null, shell: null, voice: null, terminal: null,
      skillsEnvironment: null, todoPlan: null, scratchpad: null, plugins: null, gateway: null,
      settings: null, evals: null, mcp: null, localTrust, speechOutput: null, dialog: null,
    },
    toolRegistry: 'headless',
    sender: new NoopSender() as never,
  })
}

describe('resolveMemoryBudget', () => {
  it('defaults to 1024 / 1536 MB and reads the env overrides', () => {
    expect(resolveMemoryBudget({})).toEqual({ softBytes: 1024 * 1024 * 1024, hardBytes: 1536 * 1024 * 1024 })
    expect(resolveMemoryBudget({ ONETHING_MEMORY_SOFT_MB: '512', ONETHING_MEMORY_HARD_MB: '768' }))
      .toEqual({ softBytes: 512 * 1024 * 1024, hardBytes: 768 * 1024 * 1024 })
  })

  it('never lets hard sit below soft, and ignores garbage', () => {
    expect(resolveMemoryBudget({ ONETHING_MEMORY_SOFT_MB: '2048', ONETHING_MEMORY_HARD_MB: '100' }).hardBytes)
      .toBe(2048 * 1024 * 1024)
    expect(resolveMemoryBudget({ ONETHING_MEMORY_SOFT_MB: 'lots' }).softBytes).toBe(1024 * 1024 * 1024)
  })
})

describe('memory RPC domain on a real assembly', () => {
  it('reports the registered holders and this process; trim needs local trust', async () => {
    const { dispatchRpc } = await import('../../../rpc/registry.js')
    const untrusted = await assemble(null)
    try {
      const report = await dispatchRpc({ domain: 'memory', method: 'report', payload: {} })
      expect(report.ok).toBe(true)
      const data = (report as { ok: true; data: import('@shared/ipc/memory.js').MemoryReportResponse }).data
      expect(data.holders.map(row => row.id).sort()).toEqual(['events.replay-buffers', 'sessions.cache', 'sessions.projections'])
      expect(data.processes.find(row => row.pid === process.pid)?.kind).toBe('main')
      expect(data.totalBytes).toBeGreaterThan(0)
      expect(data.heap.usedBytes).toBeGreaterThan(0)
      const refused = await dispatchRpc({ domain: 'memory', method: 'trim', payload: { pressure: 'hard' } })
      expect(refused.ok).toBe(false)
    } finally {
      await untrusted.dispose()
    }
    expect(() => untrusted.memory).toThrow()

    const trusted = await assemble({ origin: 'desktop-embedded' })
    try {
      // 档位真的经信封的 `payload` 送到了处理者(缺省是 hard,所以这里问 soft)。
      const trimmed = await dispatchRpc({ domain: 'memory', method: 'trim', payload: { pressure: 'soft' } })
      expect(trimmed.ok).toBe(true)
      const data = (trimmed as { ok: true; data: import('@shared/ipc/memory.js').MemoryTrimReport }).data
      expect(data.pressure).toBe('soft')
      expect(data.holders.map(row => row.id).sort()).toEqual(['events.replay-buffers', 'sessions.cache', 'sessions.projections'])
      expect(data.holders.every(row => row.error === undefined)).toBe(true)
    } finally {
      await trusted.dispose()
    }
  }, 60_000)
})
