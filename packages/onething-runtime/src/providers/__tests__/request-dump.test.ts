import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import zlib from 'node:zlib'
import {
  dumpOnethingProviderRequest,
  getOnethingProviderRequestDumpDir,
  pruneOnethingProviderRequestDumps,
  safeOnethingProviderRequestDumpFilenamePart,
  setOnethingProviderRequestDumpEnabled,
  shouldDumpOnethingProviderRequests,
  stringifyOnethingProviderRequestDump,
} from '../request-dump.js'

const DAY_MS = 24 * 60 * 60 * 1000

async function writeDump(dir: string, name: string, bytes: number, ageDays: number, now: number) {
  const filePath = path.join(dir, name)
  await fs.writeFile(filePath, 'x'.repeat(bytes), 'utf-8')
  const stamp = new Date(now - ageDays * DAY_MS)
  await fs.utimes(filePath, stamp, stamp)
  return filePath
}

describe('onething provider request dump', () => {
  it('keeps dump path and feature flag policy in runtime', () => {
    // 调试转储归 log/dumps/(§2.4 第三类),与诊断日志分家。
    expect(getOnethingProviderRequestDumpDir('/tmp/onething-logs'))
      .toBe(path.join('/tmp/onething-logs', 'dumps', 'provider-requests'))
    // 拍板 B:**默认关**(真机上默认开写出过 1.1G 的请求正文)。只有显式 opt-in
    // 或设置页的诊断模式打得开。
    expect(shouldDumpOnethingProviderRequests({})).toBe(false)
    expect(shouldDumpOnethingProviderRequests({ ONETHING_DUMP_PROVIDER_REQUESTS: '0' })).toBe(false)
    expect(shouldDumpOnethingProviderRequests({ ONETHING_DUMP_PROVIDER_REQUESTS: '1' })).toBe(true)
    expect(safeOnethingProviderRequestDumpFilenamePart('codex/http:model?x')).toBe('codex_http_model_x')
    expect(safeOnethingProviderRequestDumpFilenamePart('!!!')).toBe('unknown')
  })

  it('serializes diagnostic values without throwing', () => {
    const circular: Record<string, unknown> = { count: 1n, error: new Error('boom') }
    circular.self = circular

    const serialized = stringifyOnethingProviderRequestDump(circular)

    expect(serialized).toContain('"count": "1"')
    expect(serialized).toContain('"message": "boom"')
    expect(serialized).toContain('"self": "[Circular]"')
  })

  it('writes provider request dumps under the supplied log directory', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'onething-provider-dump-'))
    const logger = { log: vi.fn(), warn: vi.fn() }

    const dumpPath = await dumpOnethingProviderRequest({
      providerId: 'deepseek/test',
      model: 'deepseek-chat',
      mode: 'stream',
      metadata: { sessionId: 'session-1' },
      requestBody: { model: 'deepseek-chat', messages: ['hello'] },
    }, {
      getLogDir: () => dir,
      env: { ONETHING_DUMP_PROVIDER_REQUESTS: '1' },
      logger,
    })

    expect(dumpPath).toContain(path.join(dir, 'dumps', 'provider-requests'))
    expect(path.basename(dumpPath ?? '')).toContain('deepseek_test')
    const parsed = JSON.parse(await fs.readFile(dumpPath ?? '', 'utf-8'))
    expect(parsed.metadata).toMatchObject({
      providerId: 'deepseek/test',
      model: 'deepseek-chat',
      mode: 'stream',
      sessionId: 'session-1',
    })
    expect(parsed.requestBody).toEqual({ model: 'deepseek-chat', messages: ['hello'] })
    expect(logger.log).toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('does not write by default — opting in is the only way in (拍板 B)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'onething-provider-dump-disabled-'))

    await expect(dumpOnethingProviderRequest({
      providerId: 'deepseek',
      model: 'deepseek-chat',
      mode: 'stream',
      requestBody: {},
    }, {
      getLogDir: () => dir,
      env: {},
    })).resolves.toBeUndefined()

    await expect(fs.readdir(dir)).resolves.toEqual([])
  })

  it('the diagnostics-mode override opens it without touching env', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'onething-provider-dump-diagnostics-'))
    try {
      setOnethingProviderRequestDumpEnabled(true)
      expect(shouldDumpOnethingProviderRequests({})).toBe(true)

      const dumpPath = await dumpOnethingProviderRequest({
        providerId: 'deepseek',
        model: 'deepseek-chat',
        mode: 'stream',
        requestBody: {},
      }, { getLogDir: () => dir, env: {}, skipMaintenance: true })

      expect(dumpPath).toContain(path.join(dir, 'dumps', 'provider-requests'))
    } finally {
      setOnethingProviderRequestDumpEnabled(undefined)
    }
    expect(shouldDumpOnethingProviderRequests({})).toBe(false)
  })

  it('deletes dumps past the retention window', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'onething-dump-retention-'))
    const now = Date.UTC(2026, 6, 20)

    await writeDump(dir, 'fresh.json', 10, 1, now)
    await writeDump(dir, 'edge.json', 10, 29, now)
    await writeDump(dir, 'stale.json', 10, 31, now)
    await writeDump(dir, 'stale-compressed.json.gz', 10, 45, now)

    const result = await pruneOnethingProviderRequestDumps(dir, { retentionDays: 30, now })

    expect(result.deleted).toBe(2)
    await expect(fs.readdir(dir)).resolves.toEqual(['edge.json', 'fresh.json'])
  })

  it('gzips oldest dumps once the directory is over budget', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'onething-dump-budget-'))
    const now = Date.UTC(2026, 6, 20)

    await writeDump(dir, 'oldest.json', 4096, 3, now)
    await writeDump(dir, 'middle.json', 4096, 2, now)
    await writeDump(dir, 'newest.json', 4096, 1, now)

    // Budget forces the two oldest to compress; highly repetitive content gzips
    // far below the limit, so the newest is left untouched.
    const result = await pruneOnethingProviderRequestDumps(dir, {
      maxBytes: 9000,
      retentionDays: 30,
      now,
    })

    expect(result.deleted).toBe(0)
    expect(result.compressed).toBe(1)
    expect(result.bytesAfter).toBeLessThanOrEqual(9000)

    const names = (await fs.readdir(dir)).sort()
    expect(names).toEqual(['middle.json', 'newest.json', 'oldest.json.gz'])

    // The archive must still round-trip to the original bytes.
    const packed = await fs.readFile(path.join(dir, 'oldest.json.gz'))
    expect(zlib.gunzipSync(packed).toString('utf-8')).toBe('x'.repeat(4096))
  })

  it('leaves a directory inside both limits untouched', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'onething-dump-noop-'))
    const now = Date.UTC(2026, 6, 20)

    await writeDump(dir, 'a.json', 128, 1, now)
    await writeDump(dir, 'b.json', 128, 2, now)

    const result = await pruneOnethingProviderRequestDumps(dir, { now })

    expect(result).toMatchObject({ deleted: 0, compressed: 0 })
    await expect(fs.readdir(dir)).resolves.toHaveLength(2)
  })
})
