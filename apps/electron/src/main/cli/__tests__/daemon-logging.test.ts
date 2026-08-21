import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * daemon 的日志接线(logging L2)。
 *
 * `HeadlessBackend` 被替身掉:本测试问的是"守护进程起来之后写不写
 * `daemon.jsonl`",而不是"后端能不能装配"—— 真把后端拉进来会顺带跑整棵工具树。
 */
vi.mock('@onething/backend/headless/backend.js', () => ({
  HeadlessBackend: class {
    async start(): Promise<void> {}
    async shutdown(): Promise<void> {}
  },
}))

let storePath = ''

describe('daemon logging (L2)', () => {
  beforeEach(() => {
    vi.resetModules()
    storePath = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-daemon-log-'))
  })

  afterEach(async () => {
    const logging = await import('@onething/backend/logging/index.js')
    await logging.shutdownAppLogging()
    fs.rmSync(storePath, { recursive: true, force: true })
  })

  it('writes daemon.jsonl into the store log dir, one JSON record per line', async () => {
    const { configureDaemonLogging } = await import('../daemon-server.js')
    const logging = await import('@onething/backend/logging/index.js')

    const handle = configureDaemonLogging(storePath)
    logging.getLogger('daemon').info('daemon listening', { socketPath: '/tmp/x.sock', pid: 4242 })
    handle.flushSync()

    const logPath = path.join(storePath, 'log', 'daemon.jsonl')
    expect(fs.existsSync(logPath)).toBe(true)

    const records = fs.readFileSync(logPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>)

    const listening = records.find(record => record.msg === 'daemon listening')
    expect(listening).toBeDefined()
    expect(listening).toMatchObject({ ns: 'daemon', level: 'info', src: 'daemon' })
    expect(listening!.fields).toMatchObject({ pid: 4242 })
    for (const record of records) {
      expect(typeof record.time).toBe('number')
      expect(typeof record.level).toBe('string')
      expect(typeof record.ns).toBe('string')
    }
  })

  it('installs process crash hooks so an unhandled rejection is not silent (P7)', async () => {
    const { configureDaemonLogging } = await import('../daemon-server.js')
    const before = process.listenerCount('unhandledRejection')
    configureDaemonLogging(storePath)
    expect(process.listenerCount('unhandledRejection')).toBeGreaterThan(before)
  })

  it('daemon.jsonl is the ledger; daemon.log stays as the pre-config stderr catcher', async () => {
    const { getCliRuntimePaths } = await import('../paths.js')
    const paths = getCliRuntimePaths(storePath)
    expect(path.basename(paths.logPath)).toBe('daemon.jsonl')
    expect(path.basename(paths.bootLogPath)).toBe('daemon.log')
    expect(paths.logDir).toBe(path.join(storePath, 'log'))
  })
})
