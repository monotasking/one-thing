import { describe, expect, it, vi } from 'vitest'
import {
  ConsoleSink,
  createLogger,
  formatJsonLine,
  formatPretty,
  LevelFilter,
  LoggerRoot,
  MemoryRingSink,
  normalizeError,
  parseLogLevelSpec,
  type LogRecord,
} from '../index.js'

function collect(): { sink: { write(record: LogRecord): void }; records: LogRecord[] } {
  const records: LogRecord[] = []
  return { sink: { write: (record: LogRecord) => { records.push(record) } }, records }
}

describe('LevelFilter / ONETHING_LOG spec', () => {
  it('defaults to info when the spec is empty', () => {
    const filter = new LevelFilter('')
    expect(filter.defaultLevel).toBe('info')
    expect(filter.isEnabled('engine.stream', 'debug')).toBe(false)
    expect(filter.isEnabled('engine.stream', 'info')).toBe(true)
  })

  it('parses a default level plus namespace globs', () => {
    const parsed = parseLogLevelSpec('info,engine.*=debug,providers.deepseek=trace')
    expect(parsed.defaultLevel).toBe('info')
    expect(parsed.rules.map(rule => rule.pattern)).toEqual(['providers.deepseek', 'engine.*'])
    expect(parsed.invalid).toEqual([])
  })

  it('lets the most specific glob win and covers the prefix itself', () => {
    const filter = new LevelFilter('warn,engine.*=debug,engine.stream=trace')
    expect(filter.levelFor('engine')).toBe('debug')
    expect(filter.levelFor('engine.prompt')).toBe('debug')
    expect(filter.levelFor('engine.stream')).toBe('trace')
    expect(filter.levelFor('toolkit.runner')).toBe('warn')
    expect(filter.isEnabled('toolkit.runner', 'info')).toBe(false)
  })

  it('keeps unparsable entries instead of throwing', () => {
    const filter = new LevelFilter('info,nonsense,engine.*=louder')
    expect(filter.defaultLevel).toBe('info')
    expect(filter.invalidEntries).toEqual(['nonsense', 'engine.*=louder'])
  })

  it('re-reads the spec at runtime', () => {
    const filter = new LevelFilter('info')
    expect(filter.isEnabled('engine.stream', 'debug')).toBe(false)
    filter.setSpec('debug')
    expect(filter.isEnabled('engine.stream', 'debug')).toBe(true)
  })

  it('supports a bare * and mid-pattern wildcards', () => {
    expect(new LevelFilter('*=debug').levelFor('anything')).toBe('debug')
    expect(new LevelFilter('info,ipc.*.slow=trace').levelFor('ipc.tools.slow')).toBe('trace')
  })
})

describe('Logger', () => {
  it('merges child fields, newest wins', () => {
    const { sink, records } = collect()
    const root = new LoggerRoot({ level: 'debug', sinks: [sink], src: 'main' })
    const log = createLogger(root, 'engine.stream')
    const child = log.child({ sessionId: 's1', runId: 'r1' })
    child.child({ runId: 'r2' }).info('stream finished', { ms: 12 })

    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      level: 'info',
      ns: 'engine.stream',
      msg: 'stream finished',
      src: 'main',
      fields: { sessionId: 's1', runId: 'r2', ms: 12 },
    })
    expect(typeof records[0].time).toBe('number')
  })

  it('does not mutate the parent logger fields', () => {
    const { sink, records } = collect()
    const root = new LoggerRoot({ sinks: [sink] })
    const log = createLogger(root, 'sessions').child({ sessionId: 's1' })
    log.child({ extra: 1 }).info('a')
    log.info('b')
    expect(records[1].fields).toEqual({ sessionId: 's1' })
  })

  it('filters below the namespace level before touching sinks', () => {
    const write = vi.fn()
    const root = new LoggerRoot({ level: 'info,engine.*=debug', sinks: [{ write }] })
    createLogger(root, 'toolkit.runner').debug('dropped')
    createLogger(root, 'engine.stream').debug('kept')
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0][0].msg).toBe('kept')
  })

  it('accepts an Error as the second argument', () => {
    const { sink, records } = collect()
    const root = new LoggerRoot({ sinks: [sink] })
    createLogger(root, 'sessions').error('load failed', new Error('boom'))
    expect(records[0].err).toMatchObject({ name: 'Error', message: 'boom' })
    expect(records[0].fields).toBeUndefined()
  })

  it('honours a per-sink minLevel and survives a throwing sink', () => {
    const seen: LogRecord[] = []
    const onSinkError = vi.fn()
    const root = new LoggerRoot({
      level: 'trace',
      onSinkError,
      sinks: [
        { write: () => { throw new Error('sink down') } },
        { minLevel: 'warn', write: record => { seen.push(record) } },
      ],
    })
    const log = createLogger(root, 'ns')
    log.info('quiet')
    log.warn('loud')
    expect(seen.map(record => record.msg)).toEqual(['loud'])
    expect(onSinkError).toHaveBeenCalledTimes(2)
  })

  it('reports whether a level is enabled without building a record', () => {
    const root = new LoggerRoot({ level: 'warn' })
    const log = createLogger(root, 'ns')
    expect(log.isLevelEnabled('info')).toBe(false)
    expect(log.isLevelEnabled('error')).toBe(true)
  })
})

describe('normalizeError', () => {
  it('normalizes Error, cause chain, string and object shapes', () => {
    const error = new Error('outer', { cause: new TypeError('inner') })
    const normalized = normalizeError(error)
    expect(normalized).toMatchObject({ name: 'Error', message: 'outer' })
    expect(normalized?.stack).toContain('outer')
    expect(normalized?.cause).toMatchObject({ name: 'TypeError', message: 'inner' })

    expect(normalizeError('plain')).toEqual({ name: 'Error', message: 'plain' })
    expect(normalizeError({ name: 'HttpError', message: 'nope', status: 500 }))
      .toMatchObject({ name: 'HttpError', message: 'nope' })
    expect(normalizeError(undefined)).toBeUndefined()
    expect(normalizeError(null)).toBeUndefined()
    expect(normalizeError(42)).toEqual({ name: 'Error', message: '42' })
  })
})

describe('sinks', () => {
  it('writes one parseable JSON object per line', () => {
    const line = formatJsonLine({ time: 1, level: 'info', ns: 'a.b', msg: 'hi', fields: { n: 1 } })
    expect(line.endsWith('\n')).toBe(true)
    expect(line.slice(0, -1).includes('\n')).toBe(false)
    expect(JSON.parse(line)).toEqual({ time: 1, level: 'info', ns: 'a.b', msg: 'hi', fields: { n: 1 } })
  })

  it('survives circular fields', () => {
    const cyclic: Record<string, unknown> = { name: 'x' }
    cyclic.self = cyclic
    const line = formatJsonLine({ time: 1, level: 'warn', ns: 'a', msg: 'm', fields: cyclic })
    expect(() => JSON.parse(line)).not.toThrow()
    expect(line).toContain('[Circular]')
  })

  it('renders pretty lines with fields and the error stack', () => {
    const pretty = formatPretty({
      time: Date.UTC(2026, 7, 20, 3, 4, 5, 6),
      level: 'error',
      ns: 'engine.stream',
      msg: 'stream failed',
      fields: { sessionId: 's1' },
      err: { name: 'Error', message: 'boom', stack: 'Error: boom\n    at x' },
    })
    expect(pretty).toContain('ERROR engine.stream stream failed')
    expect(pretty).toContain('{"sessionId":"s1"}')
    expect(pretty).toContain('Error: boom')
    expect(pretty.split('\n').length).toBeGreaterThan(1)
  })

  it('routes ConsoleSink levels to the matching console method', () => {
    const target = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const sink = new ConsoleSink({ format: 'json', target })
    sink.write({ time: 1, level: 'debug', ns: 'a', msg: 'd' })
    sink.write({ time: 1, level: 'info', ns: 'a', msg: 'i' })
    sink.write({ time: 1, level: 'warn', ns: 'a', msg: 'w' })
    sink.write({ time: 1, level: 'fatal', ns: 'a', msg: 'f' })
    expect(target.debug).toHaveBeenCalledTimes(1)
    expect(target.info).toHaveBeenCalledTimes(1)
    expect(target.warn).toHaveBeenCalledTimes(1)
    expect(target.error).toHaveBeenCalledTimes(1)
    expect(() => JSON.parse(target.info.mock.calls[0][0] as string)).not.toThrow()
  })

  it('keeps the newest n records in the memory ring, oldest first', () => {
    const ring = new MemoryRingSink(3)
    for (const msg of ['a', 'b', 'c', 'd']) ring.write({ time: 1, level: 'info', ns: 'n', msg })
    expect(ring.dump().map(record => record.msg)).toEqual(['b', 'c', 'd'])
    expect(ring.size).toBe(3)
    ring.clear()
    expect(ring.dump()).toEqual([])
  })
})
