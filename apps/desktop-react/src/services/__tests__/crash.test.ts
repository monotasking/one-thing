import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __resetLogForTests, dumpLog } from '../log'
import { describeThrown, dumpCrashes, installCrashHandlers, recordCrash, shortWhere } from '../crash'
import { useNotifyStore } from '../notify-store'
import { useToastHub } from '../../ui/Toast'

let uninstall = () => undefined as void

beforeEach(() => {
  __resetLogForTests()
  useNotifyStore.setState({ items: [] })
  useToastHub.setState({ toasts: [], folded: 0 })
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

/**
 * 崩溃弹框的**呈现**(09-01 报障:「弹框正文是一条完整模块 URL,给机器看的」)。
 *
 * 三条断言对着整改的三格:短名 / 全量进详情 / 风暴合并成一条带计数。
 * 捕获那一侧(四个产地、日志环、window.__crash)一个字没动 —— 所以上面那几条
 * 老用例照旧全绿,是这一批「只改呈现层」的反证。
 */
describe('崩溃弹框:给人看的那一版', () => {
  const items = () => useNotifyStore.getState().items
  const toasts = () => useToastHub.getState().toasts

  it('完整模块 URL 只留文件名 —— 协议 / 端口 / HMR 时间戳一个都不帮人回答「哪儿坏了」', () => {
    expect(shortWhere('http://localhost:5199/src/components/DockTile.tsx?t=1756612345678')).toBe(
      'DockTile.tsx',
    )
    expect(shortWhere('/Users/x/src/composer/Composer.tsx#L20')).toBe('Composer.tsx')
  })

  it('本来就是人话的现场 id 原样返回 —— 短名不是「一律切一刀」', () => {
    expect(shortWhere('chat')).toBe('chat')
    expect(shortWhere('promise')).toBe('promise')
    expect(shortWhere('window')).toBe('window')
  })

  it('标题挂短名,完整 URL 与栈落进详情:全量那一份一个字节都不丢', () => {
    const url = 'http://localhost:5199/src/components/DockTile.tsx?t=1756612345678'
    recordCrash('window.onerror', url, new TypeError('读不到 undefined 的 tile'))
    const [record] = items()
    expect(record.title).toContain('DockTile.tsx')
    expect(record.title).not.toContain('?t=')
    expect(record.title).not.toContain('localhost')
    // 那句错留在正文:它一行说清「什么坏了」,是这条通知里最该被看见的一句。
    expect(record.body).toBe('TypeError: 读不到 undefined 的 tile')
    // 详情才是给排障的人看的那一份 —— 完整 URL 在第一行,栈跟在后面。
    expect(record.detail?.split('\n')[0]).toBe(url)
    expect(record.detail).toContain('TypeError: 读不到 undefined 的 tile')
    // 日志环收的仍然是原样的 where(排障要那条完整 URL,连时间戳都要)。
    expect(dumpLog()[0].args[0]).toContain(url)
  })

  it('HMR 里同一个错连炸五次:一条记录、一个框,次数记在框上', () => {
    // HMR 每次重载换一个 ?t= —— 修前这五次是五个互不相同的标题,五条记录五个框。
    for (let i = 0; i < 5; i += 1) {
      recordCrash(
        'window.onerror',
        `http://localhost:5199/src/components/DockTile.tsx?t=${1756612345678 + i}`,
        new TypeError('读不到 undefined 的 tile'),
      )
    }
    expect(items().length).toBe(1)
    expect(items()[0].count).toBe(5)
    expect(toasts().length).toBe(1)
    expect(toasts()[0].note).toBe('×5')
  })
})
