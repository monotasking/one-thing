import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __resetLogForTests, dumpLog } from '../log'
import { describeThrown, dumpCrashes, installCrashHandlers, recordCrash } from '../crash'

let uninstall = () => undefined as void

beforeEach(() => {
  __resetLogForTests()
  uninstall = installCrashHandlers()
})

afterEach(() => {
  uninstall()
})

describe('抛出物描述', () => {
  it('Error 留 name/message 与 stack', () => {
    const d = describeThrown(new RangeError('越界'))
    expect(d.message).toBe('RangeError: 越界')
    expect(d.stack).toContain('RangeError')
  })

  it('抛字符串 / 抛对象 / 抛 undefined 都得接住,不抛二次错', () => {
    expect(describeThrown('裸字符串').message).toBe('裸字符串')
    expect(describeThrown({ code: 42 }).message).toBe('{"code":42}')
    expect(describeThrown(undefined).message).toBe('undefined')
  })
})

describe('崩溃捕获', () => {
  it('recordCrash 落进日志环,ns 带 crash. 前缀,where 在参数里', () => {
    recordCrash('boundary', 'files', new Error('面板炸了'))
    const [row] = dumpLog()
    expect(row.ns).toBe('crash.boundary')
    expect(row.level).toBe('error')
    expect(row.msg).toBe('Error: 面板炸了')
    expect(row.args[0]).toContain('"where":"files"')
  })

  it('window.onerror 的错进环', () => {
    window.dispatchEvent(
      new ErrorEvent('error', { message: '没人接的错', error: new Error('没人接的错') }),
    )
    expect(dumpCrashes().map((r) => r.ns)).toContain('crash.window.onerror')
  })

  it('dump 只给崩溃条,别的日志不混进来', () => {
    recordCrash('boundary', 'chat', new Error('x'))
    expect(dumpLog()).toHaveLength(1)
    expect(dumpCrashes()).toHaveLength(1)
    // 一条普通日志进环之后,crash dump 的条数不该跟着涨。
    window.__log?.dump()
    expect(dumpCrashes()).toHaveLength(1)
  })

  it('window.__crash.dump() 是同一个口', () => {
    recordCrash('unhandledrejection', 'promise', 'boom')
    expect(window.__crash?.dump().map((r) => r.msg)).toEqual(['boom'])
  })

  it('重复装监听是幂等的 —— 同一个错不许记两遍', () => {
    installCrashHandlers()
    installCrashHandlers()
    window.dispatchEvent(new ErrorEvent('error', { message: '一次', error: new Error('一次') }))
    expect(dumpCrashes()).toHaveLength(1)
  })
})
