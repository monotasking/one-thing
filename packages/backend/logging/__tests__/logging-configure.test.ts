import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  logDir: '',
  setElectronAppLogsPath: vi.fn(),
  ensureDir: vi.fn((dir: string) => { fs.mkdirSync(dir, { recursive: true }) }),
  rendererCapture: {
    attach: vi.fn(),
    detach: vi.fn(),
    log: undefined as undefined | ((entry: unknown) => void),
  },
}))


vi.mock('@onething/backend/storage/storage', () => ({
  ensureDir: mocks.ensureDir,
  getOnethingLogDir: () => mocks.logDir,
}))

function readRecords(): Array<Record<string, any>> {
  const file = path.join(mocks.logDir, 'app.jsonl')
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map(line => JSON.parse(line))
}

describe('app logging assembly (configureLogging)', () => {
  const originalConsole = { ...console }
  const originalLogEnv = process.env.ONETHING_LOG

  beforeEach(() => {
    vi.resetModules()
    mocks.logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-logging-'))
    mocks.setElectronAppLogsPath.mockClear()
    mocks.rendererCapture.attach.mockClear()
    mocks.rendererCapture.detach.mockClear()
    mocks.rendererCapture.log = undefined
    delete process.env.ONETHING_LOG
  })

  afterEach(() => {
    Object.assign(console, originalConsole)
    fs.rmSync(mocks.logDir, { recursive: true, force: true })
    if (originalLogEnv === undefined) delete process.env.ONETHING_LOG
    else process.env.ONETHING_LOG = originalLogEnv
  })

  it('writes structured JSONL and every line carries time/level/ns', async () => {
    const logging = await import('../logging-configure.js')
    const handle = logging.configureLogging({ janitor: false, legacyConsole: false })
    logging.getLogger('engine.stream').info('stream finished', { sessionId: 's1', ms: 12 })
    handle.flushSync()

    const records = readRecords()
    expect(records.length).toBeGreaterThan(0)
    for (const record of records) {
      expect(typeof record.time).toBe('number')
      expect(typeof record.level).toBe('string')
      expect(typeof record.ns).toBe('string')
    }
    expect(records.some(record => record.ns === 'engine.stream' && record.fields?.sessionId === 's1')).toBe(true)
    expect(handle.logPath).toBe(path.join(mocks.logDir, 'app.jsonl'))

    await logging.shutdownAppLogging()
  })

  it('tags legacy console traffic with ns=console + legacy + a callsite', async () => {
    const logging = await import('../logging-configure.js')
    logging.configureLogging({ janitor: false })
    console.log('[IPCBridge] Unbound')
    console.warn('[Themes] slow')
    logging.getRootLogger()
    ;(await import('../logging-configure.js')).getAppLogPath()
    await logging.shutdownAppLogging()

    const records = readRecords().filter(record => record.ns === 'console')
    const info = records.find(record => record.msg.includes('[IPCBridge] Unbound'))
    expect(info).toMatchObject({ level: 'info', src: 'main' })
    expect(info?.fields?.legacy).toBe(true)
    expect(typeof info?.fields?.callsite).toBe('string')
    expect(records.some(record => record.level === 'warn' && record.msg.includes('[Themes] slow'))).toBe(true)
  })

  it('suppresses broken stdout pipes while still writing app logs', async () => {
    const brokenPipeError = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
    console.log = (() => {
      throw brokenPipeError
    }) as typeof console.log

    const logging = await import('../logging-configure.js')

    // EPIPE 抑制那条是 debug 级(它只在排障时才有意义),所以这里显式开 debug。
    expect(() => logging.configureLogging({ janitor: false, level: 'debug' })).not.toThrow()
    expect(() => console.log('[IPCBridge] Unbound')).not.toThrow()

    await logging.shutdownAppLogging()

    const records = readRecords()
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        level: 'debug',
        ns: 'process',
        msg: 'Suppressed broken stdout/stderr pipe during shutdown',
      }),
      expect.objectContaining({ ns: 'console', msg: expect.stringContaining('[IPCBridge] Unbound') }),
    ]))
  })

  it('reads ONETHING_LOG at configure time and can be re-pointed at runtime', async () => {
    process.env.ONETHING_LOG = 'warn,engine.*=debug'
    const logging = await import('../logging-configure.js')
    const handle = logging.configureLogging({ janitor: false, legacyConsole: false })

    logging.getLogger('toolkit.runner').info('dropped by spec')
    logging.getLogger('engine.stream').debug('kept by glob')
    handle.flushSync()

    let messages = readRecords().map(record => record.msg)
    expect(messages).toContain('kept by glob')
    expect(messages).not.toContain('dropped by spec')

    logging.setLogLevelSpec('debug')
    logging.getLogger('toolkit.runner').debug('now kept')
    handle.flushSync()

    messages = readRecords().map(record => record.msg)
    expect(messages).toContain('now kept')

    await logging.shutdownAppLogging()
  })

  it('keeps writeAppLog working — the 8 migration-era call sites map onto ns', async () => {
    const logging = await import('../logging-configure.js')
    const handle = logging.configureLogging({ janitor: false, legacyConsole: false })
    logging.writeAppLog('info', 'channel.identity', 'Resolved local client identity', { userId: 'u1' })
    handle.flushSync()

    expect(readRecords()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        level: 'info',
        ns: 'channel.identity',
        msg: 'Resolved local client identity',
        fields: { userId: 'u1' },
      }),
    ]))

    await logging.shutdownAppLogging()
  })

  it('configureLogging is idempotent — the embedded server never double-configures', async () => {
    const logging = await import('../logging-configure.js')
    const first = logging.configureLogging({ janitor: false, legacyConsole: false })
    const second = logging.configureLogging({ janitor: false, legacyConsole: false, fileBaseName: 'server' })

    expect(second.logPath).toBe(first.logPath)
    expect(fs.existsSync(path.join(mocks.logDir, 'server.jsonl'))).toBe(false)

    await logging.shutdownAppLogging()
  })
})

describe('diagnostics mode', () => {
  const dumpState = vi.hoisted(() => ({ enabled: undefined as boolean | undefined }))

  beforeEach(() => {
    vi.resetModules()
    mocks.logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-logging-diag-'))
    dumpState.enabled = undefined
    delete process.env.ONETHING_LOG
  })

  afterEach(() => {
    fs.rmSync(mocks.logDir, { recursive: true, force: true })
  })

  it('flips the level spec and the provider request dump together', async () => {
    // 2026-10-04 起转储开关与诊断模式同住 logging(`logging-provider-request-dump.ts`,D24),mock 打在它身上。
    vi.doMock('../logging-provider-request-dump.js', () => ({
      setOnethingProviderRequestDumpEnabled: (enabled: boolean | undefined) => { dumpState.enabled = enabled },
    }))
    const logging = await import('../logging-configure.js')
    const diagnostics = await import('../logging-diagnostics.js')
    logging.configureLogging({ janitor: false, legacyConsole: false })

    expect(logging.getLogLevelSpec()).toBe('info')
    expect(dumpState.enabled).toBeUndefined()

    diagnostics.applyDiagnosticsMode(true)
    expect(logging.getLogLevelSpec()).toBe('debug')
    expect(dumpState.enabled).toBe(true)
    expect(diagnostics.isDiagnosticsModeApplied()).toBe(true)

    diagnostics.applyDiagnosticsMode(false)
    expect(logging.getLogLevelSpec()).toBe('info')
    expect(dumpState.enabled).toBeUndefined()

    await logging.shutdownAppLogging()
    vi.doUnmock('@onething/backend/provider')
  })
})

/**
 * D161 钉子:两只同名 `getLogger` 合成一只之后,落进文件的结果与合并之前逐字一样。
 *
 * 合并之前(2026-10-04 实测,临时 store 跑一遍):接线(`configureLogging`)之前,无论经 configure 那只
 * 还是经入口那只写的记录,**都不落文件** —— 前者留在 configure 的 400 条内存环里,后者留在入口的 200 条兜底环里;
 * 文件里第一条永远是 `logging configured`。接线之后两只写的记录形状相同:`{ time, level, ns, msg, fields, src }`。
 * 合并之后这两点都不许变:接线前写的 info / warn 不能出现在文件里,接线后写的那条字段与从前相同。
 */
describe('records written before configureLogging (D161)', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-logging-pre-'))
  })

  afterEach(() => {
    fs.rmSync(mocks.logDir, { recursive: true, force: true })
  })

  it('keeps pre-wiring records out of the jsonl and writes post-wiring records unchanged', async () => {
    const entry = await import('../logging.js')
    const logging = await import('../logging-configure.js')
    // 只剩一只:configure 转交的就是入口那个函数。
    expect(logging.getLogger).toBe(entry.getLogger)
    entry.getLogger('probe.pre').info('pre-configure info', { k: 1 })
    entry.getLogger('probe.pre').warn('pre-configure warn', { k: 2 })
    expect(entry.dumpRuntimeLogRecords().map(record => record.msg)).toEqual(['pre-configure info', 'pre-configure warn'])

    const handle = logging.configureLogging({ janitor: false, legacyConsole: false, crashHooks: false, src: 'server' })
    entry.getLogger('probe.post').info('post-configure info', { k: 3 })
    handle.flushSync()

    const records = readRecords().map(({ time, ...rest }) => {
      expect(typeof time).toBe('number')
      return rest
    })
    expect(records.map(record => record.msg)).toEqual(['logging configured', 'post-configure info'])
    expect(records[1]).toEqual({ level: 'info', ns: 'probe.post', msg: 'post-configure info', fields: { k: 3 }, src: 'server' })

    await logging.shutdownAppLogging()
    logging.resetLoggingForTests()
  })
})
