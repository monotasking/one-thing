import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installProcessCrashHooks } from '../crash-hooks.js'

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'crash-hooks.fixture.mjs')

let tempDir = ''

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-crash-hooks-'))
})

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

/**
 * 一个只有 `on/off/emit/exit` 的假 process。返回类型故意放宽 `emit` 的签名 ——
 * `NodeJS.Process['emit']` 的重载表不接受我们要注入的那几个事件名。
 */
type FakeProcess = NodeJS.Process & {
  exit: ReturnType<typeof vi.fn>
  emit(event: string, ...args: unknown[]): boolean
}

function fakeProcess(): FakeProcess {
  const emitter = new EventEmitter() as unknown as FakeProcess
  emitter.exit = vi.fn() as never
  return emitter
}

function fakeLogger(): { records: Array<{ level: string; msg: string; err?: unknown }>; logger: any } {
  const records: Array<{ level: string; msg: string; err?: unknown }> = []
  const logger: any = {
    ns: 'process',
    isLevelEnabled: () => true,
    child: () => logger,
  }
  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
    logger[level] = (msg: string, _fields?: unknown, err?: unknown) => { records.push({ level, msg, err }) }
  }
  return { records, logger }
}

describe('installProcessCrashHooks', () => {
  it('records unhandled rejections as fatal and flushes before the process can die', () => {
    const target = fakeProcess()
    const flushSync = vi.fn()
    const { records, logger } = fakeLogger()

    installProcessCrashHooks(logger, { processRef: target, flushSync })
    target.emit('unhandledRejection', new Error('boom'))

    expect(records).toEqual([expect.objectContaining({ level: 'fatal', msg: 'unhandled promise rejection' })])
    expect(flushSync).toHaveBeenCalledTimes(1)
  })

  it('defaults to uncaughtExceptionMonitor so Node keeps its own crash behaviour', () => {
    const target = fakeProcess()
    const flushSync = vi.fn()
    const { records, logger } = fakeLogger()

    installProcessCrashHooks(logger, { processRef: target, flushSync })

    expect(target.listenerCount('uncaughtExceptionMonitor')).toBe(1)
    expect(target.listenerCount('uncaughtException')).toBe(0)

    target.emit('uncaughtExceptionMonitor', new Error('nope'), 'uncaughtException')
    expect(records.at(-1)).toMatchObject({ level: 'fatal', msg: 'uncaught exception' })
    expect(flushSync).toHaveBeenCalledTimes(1)
    expect(target.exit).not.toHaveBeenCalled()
  })

  it("'handle' mode takes over: fatal → flush → print → exit(1)", () => {
    const target = fakeProcess()
    const flushSync = vi.fn()
    const printFatal = vi.fn()
    const { logger } = fakeLogger()

    installProcessCrashHooks(logger, { processRef: target, flushSync, printFatal, uncaughtException: 'handle' })
    expect(target.listenerCount('uncaughtException')).toBe(1)

    target.emit('uncaughtException', new Error('fatal one'))
    expect(flushSync).toHaveBeenCalled()
    expect(printFatal).toHaveBeenCalled()
    expect(target.exit).toHaveBeenCalledWith(1)
  })

  it('records process warnings and detaches cleanly', () => {
    const target = fakeProcess()
    const { records, logger } = fakeLogger()

    const hooks = installProcessCrashHooks(logger, { processRef: target })
    target.emit('warning', Object.assign(new Error('deprecated'), { name: 'DeprecationWarning' }))
    expect(records.at(-1)).toMatchObject({ level: 'warn', msg: 'process warning' })

    hooks.dispose()
    expect(target.listenerCount('unhandledRejection')).toBe(0)
    expect(target.listenerCount('uncaughtExceptionMonitor')).toBe(0)
    expect(target.listenerCount('warning')).toBe(0)
  })

  it('works in a real process: an unhandled rejection lands a fatal record + a flush', () => {
    const outFile = path.join(tempDir, 'records.jsonl')
    execFileSync(process.execPath, [fixture, outFile, 'rejection'], { stdio: 'ignore' })

    const records = fs.readFileSync(outFile, 'utf-8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    expect(records[0]).toMatchObject({
      level: 'fatal',
      msg: 'unhandled promise rejection',
      err: { message: 'fixture rejection' },
    })
    expect(records[1]).toMatchObject({ level: 'info', msg: 'flushSync' })
  })

  it('works in a real process: an uncaught exception is recorded AND still crashes the process', () => {
    const outFile = path.join(tempDir, 'records.jsonl')
    let exitCode = 0
    try {
      execFileSync(process.execPath, [fixture, outFile, 'uncaught'], { stdio: 'ignore' })
    } catch (error) {
      exitCode = (error as { status?: number }).status ?? 0
    }

    // Node 的默认行为没有被接管:进程照样非零退出。
    expect(exitCode).toBe(1)
    const records = fs.readFileSync(outFile, 'utf-8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    expect(records[0]).toMatchObject({
      level: 'fatal',
      msg: 'uncaught exception',
      err: { message: 'fixture uncaught' },
    })
    expect(records[1]).toMatchObject({ level: 'info', msg: 'flushSync' })
  })
})
