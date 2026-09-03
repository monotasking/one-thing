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


vi.mock('@onething/runtime/storage/index', () => ({
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
    const logging = await import('../index.js')
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
    const logging = await import('../index.js')
    logging.configureLogging({ janitor: false })
    console.log('[IPCBridge] Unbound')
    console.warn('[Themes] slow')
    logging.getRootLogger()
    ;(await import('../index.js')).getAppLogPath()
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

    const logging = await import('../index.js')

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
    const logging = await import('../index.js')
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
    const logging = await import('../index.js')
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
    const logging = await import('../index.js')
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
    vi.doMock('@onething/runtime/providers/index', () => ({
      setOnethingProviderRequestDumpEnabled: (enabled: boolean | undefined) => { dumpState.enabled = enabled },
    }))
    const logging = await import('../index.js')
    const diagnostics = await import('../diagnostics.js')
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
    vi.doUnmock('@onething/runtime/providers/index')
  })
})
