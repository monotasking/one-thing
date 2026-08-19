import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { LogRecord } from '@onething/core/logging'
import { createRendererLogHub, resetRendererLogHubForTests, type RendererLogHub } from '../log'
import {
  recordCrash,
  getCrashLogEntries,
  dumpCrashLog,
  clearCrashLog,
  installGlobalCrashCapture,
} from '../crash-log'

function createStorageStub(): Storage {
  const map = new Map<string, string>()
  return {
    get length() { return map.size },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => { map.delete(key) },
    setItem: (key: string, value: string) => { map.set(key, value) },
  }
}

/**
 * L3:crash-log 不再自打 console,它是 RendererLogHub 的一个 producer。
 * 测试因此对着 hub 的**内存环**断言 —— 那就是上行的同一批记录。
 */
let hub: RendererLogHub
function hubRecords(): LogRecord[] {
  return hub.dump()
}

describe('crash-log', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createStorageStub())
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    hub = createRendererLogHub({ echo: false, level: 'trace' })
    resetRendererLogHubForTests(hub)
  })

  afterEach(() => {
    resetRendererLogHubForTests(null)
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('records errors with message, stack and increasing seq', () => {
    recordCrash('error-boundary', new Error('first'))
    recordCrash('window-error', new Error('second'))

    const entries = getCrashLogEntries()
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ seq: 1, source: 'error-boundary', message: 'first' })
    expect(entries[0].stack).toContain('first')
    expect(entries[1]).toMatchObject({ seq: 2, source: 'window-error', message: 'second' })
  })

  it('survives across module usage via storage (reload scenario)', () => {
    recordCrash('error-boundary', new Error('before reload'))
    // A reload re-reads from the same storage — entries remain.
    expect(getCrashLogEntries()[0].message).toBe('before reload')
  })

  it('caps the ring buffer and keeps the newest entries', () => {
    for (let i = 0; i < 45; i++) recordCrash('window-error', new Error(`e${i}`))
    const entries = getCrashLogEntries()
    expect(entries).toHaveLength(40)
    expect(entries[entries.length - 1].message).toBe('e44')
    expect(entries[0].message).toBe('e5')
  })

  it('stringifies non-Error values', () => {
    recordCrash('unhandled-rejection', 'plain rejection reason')
    expect(getCrashLogEntries()[0].message).toBe('plain rejection reason')
  })

  it('truncates oversized stacks', () => {
    const err = new Error('big')
    err.stack = 'x'.repeat(10_000)
    recordCrash('error-boundary', err)
    const entry = getCrashLogEntries()[0]
    expect(entry.stack!.length).toBeLessThan(5_000)
    expect(entry.stack).toContain('[truncated]')
  })

  it('emits ONE structured record per error and no console line at all', () => {
    recordCrash('error-boundary', new Error('boom'), { info: 'component event handler' })

    expect(console.error).not.toHaveBeenCalled()
    expect(console.warn).not.toHaveBeenCalled()

    const records = hubRecords()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      level: 'error',
      ns: 'crash',
      msg: 'error boundary caught',
      src: 'renderer',
    })
    expect(records[0].fields).toMatchObject({ source: 'error-boundary', seq: 1, info: 'component event handler' })
    expect(records[0].err?.message).toBe('boom')
    expect(records[0].err?.stack).toContain('boom')
  })

  it('maps each capture point to its own stable msg', () => {
    recordCrash('vue-error-handler', new Error('a'))
    recordCrash('window-error', new Error('b'))
    recordCrash('unhandled-rejection', new Error('c'))
    expect(hubRecords().map(record => record.msg)).toEqual(['vue error', 'window error', 'unhandled rejection'])
  })

  it('dedupes repeated vue warns — one ring entry AND one log record', () => {
    recordCrash('vue-warn', 'Invalid prop: foo')
    recordCrash('vue-warn', 'Invalid prop: foo')
    recordCrash('vue-warn', 'Invalid prop: foo')

    expect(getCrashLogEntries()).toHaveLength(1)
    const records = hubRecords()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ level: 'warn', msg: 'vue warn' })
    expect(records[0].fields).toMatchObject({ message: 'Invalid prop: foo', source: 'vue-warn' })
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('puts a Vue warn trace into fields.stack instead of extra lines', () => {
    recordCrash('vue-warn', 'Invalid prop: bar', { info: 'at <ChatPanel>' })
    const record = hubRecords()[0]
    expect(record.fields?.info).toBe('at <ChatPanel>')
    // 非 Error 没有 err,正文进 fields —— 一条记录,不是多行。
    expect(record.err).toBeUndefined()
  })

  it('dump includes every entry and clear empties the log', () => {
    recordCrash('error-boundary', new Error('one'))
    recordCrash('vue-error-handler', new Error('two'))
    const dump = dumpCrashLog()
    expect(dump).toContain('one')
    expect(dump).toContain('two')

    clearCrashLog()
    expect(getCrashLogEntries()).toHaveLength(0)
    expect(dumpCrashLog()).toBe('[crash-log] empty')
  })

  it('tolerates a missing localStorage entirely', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(() => recordCrash('window-error', new Error('no storage'))).not.toThrow()
    expect(getCrashLogEntries()).toEqual([])
  })

  it('installGlobalCrashCapture wires vue handlers and is window-safe in node', () => {
    const app = { config: {} as Record<string, unknown> }
    installGlobalCrashCapture(app as unknown as Parameters<typeof installGlobalCrashCapture>[0])
    expect(typeof app.config.errorHandler).toBe('function')
    expect(typeof app.config.warnHandler).toBe('function')

    ;(app.config.errorHandler as (e: unknown, i: null, info: string) => void)(new Error('from handler'), null, 'render')
    const entries = getCrashLogEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ source: 'vue-error-handler', message: 'from handler', info: 'render' })
  })
})
