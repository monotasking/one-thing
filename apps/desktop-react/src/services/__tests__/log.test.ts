import { beforeEach, describe, expect, it } from 'vitest'
import {
  LOG_RING_CAPACITY,
  __resetLogForTests,
  dumpLog,
  getLogger,
  installLogDumpHook,
  record,
} from '../log'

beforeEach(() => {
  __resetLogForTests()
})

describe('日志中枢', () => {
  it('四档各记一条,ns 与级别原样落进记录', () => {
    const log = getLogger('boot')
    log.debug('a')
    log.info('b')
    log.warn('c')
    log.error('d')
    expect(dumpLog().map((r) => [r.ns, r.level, r.msg])).toEqual([
      ['boot', 'debug', 'a'],
      ['boot', 'info', 'b'],
      ['boot', 'warn', 'c'],
      ['boot', 'error', 'd'],
    ])
  })

  it('环是定长的:写满之后掉的是**最旧**的那条,不是最新的', () => {
    const log = getLogger('ring')
    for (let i = 0; i < LOG_RING_CAPACITY + 25; i += 1) log.info(`m${i}`)
    const rows = dumpLog()
    expect(rows).toHaveLength(LOG_RING_CAPACITY)
    expect(rows[0].msg).toBe('m25')
    expect(rows[rows.length - 1].msg).toBe(`m${LOG_RING_CAPACITY + 24}`)
  })

  it('参数落成短样:Error 留 name/message,对象走 JSON', () => {
    getLogger('x').error('炸了', new TypeError('坏值'), { id: 7 })
    const [row] = dumpLog()
    expect(row.args[0]).toContain('TypeError: 坏值')
    expect(row.args[1]).toBe('{"id":7}')
  })

  it('超长参数被截断,但那条记录本身留住 —— 环不许被一个大对象撑爆', () => {
    getLogger('x').info('big', 'y'.repeat(5000))
    const [row] = dumpLog()
    expect(row.args[0].length).toBeLessThan(500)
    expect(row.args[0].endsWith('…')).toBe(true)
  })

  it('循环引用不炸(JSON.stringify 会抛,这里得接住)', () => {
    const loop: Record<string, unknown> = {}
    loop.self = loop
    expect(() => getLogger('x').info('circular', loop)).not.toThrow()
    expect(dumpLog()).toHaveLength(1)
  })

  it('dump 给的是快照:拿到手之后再记新的,不该改变已交出去的那份', () => {
    getLogger('x').info('one')
    const snapshot = dumpLog()
    getLogger('x').info('two')
    expect(snapshot).toHaveLength(1)
    expect(dumpLog()).toHaveLength(2)
  })

  it('window.__log.dump() 是同一个口', () => {
    installLogDumpHook()
    record('warn', 'probe', 'hi')
    expect(window.__log?.dump().map((r) => r.msg)).toEqual(['hi'])
  })
})
