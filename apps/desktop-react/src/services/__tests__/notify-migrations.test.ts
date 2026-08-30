import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CRASH_DEDUPE_MS, installCrashHandlers, recordCrash } from '../crash'
import { __resetLogForTests, dumpLog } from '../log'
import { useNotifyStore } from '../notify-store'
import { useToastHub } from '../../ui/Toast'
import { useStageStore } from '../../stage/store'
import { PERF_BUDGET } from '../../perf-budget'

/**
 * 迁移点的验收:**散装弹窗全没了,产地一律走 notify**。
 * 每个产地一条,断的是「它报出来的是什么级别、挂在哪个 source 下」——
 * 那正是命运表和面板过滤唯一吃的两件事。
 *
 * (SearchPanel 那一条在 search/components/SearchPanel.test.tsx 里,
 *  发送失败那一条在 data/chat-source.test.ts 里,连不上 core 那一条在
 *  platform/connection.test.ts 里 —— 都跟着各自的产地走,不集中在这个文件。)
 */
let uninstall = () => undefined as void

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  __resetLogForTests()
  useNotifyStore.setState({ items: [] })
  useToastHub.setState({ toasts: [], folded: 0 })
  uninstall = installCrashHandlers()
})

afterEach(() => {
  uninstall()
})

const items = () => useNotifyStore.getState().items

describe('崩溃 → notify(error)', () => {
  it('一次崩溃两处落点:日志环记现场,通知报给用户 —— 而且**不重复记日志**', () => {
    recordCrash('boundary', 'chat', new Error('面板炸了'))
    // 日志环里仍然只有一条(notify 自己一行日志都不写)
    expect(dumpLog().length).toBe(1)
    expect(items().map((x) => [x.level, x.source])).toEqual([['error', 'crash.boundary']])
  })

  it('body 是错误原文,detail 是栈 —— 面板点开那块衬块要能看到现场', () => {
    recordCrash('boundary', 'chat', new Error('面板炸了'))
    const [record] = items()
    expect(record.title).toBe('chat 出错了')
    expect(record.body).toBe('Error: 面板炸了')
    expect(record.detail?.split('\n').length).toBeGreaterThan(1)
    // 栈的首行本来就是那句话,所以详情里它**只出现一次**(真机上见过抄两遍的样子)
    expect(record.detail?.split('\n').filter((l) => l.includes('面板炸了')).length).toBe(1)
  })

  it('抛的东西没有栈时,详情退回那句话本身 —— 不留一块空衬块', () => {
    recordCrash('unhandledrejection', 'promise', '裸字符串')
    expect(items()[0].detail).toBe('裸字符串')
  })

  it('错误风暴合并成一条,屏幕上也只弹一次 —— 60s 窗口', () => {
    for (let i = 0; i < 50; i += 1) recordCrash('boundary', 'chat', new Error('每帧都炸'))
    expect(items().length).toBe(1)
    expect(items()[0].count).toBe(50)
    expect(useToastHub.getState().toasts.length).toBe(1)
    expect(CRASH_DEDUPE_MS).toBe(60_000)
  })

  it('两块面板同时炸掉仍然是两条 —— 合的是重复,不是「所有的崩溃」', () => {
    recordCrash('boundary', 'chat', new Error('a'))
    recordCrash('boundary', 'search', new Error('b'))
    expect(items().length).toBe(2)
  })

  it('三个产地各自挂各自的 source', () => {
    recordCrash('window.onerror', 'window', new Error('a'))
    recordCrash('unhandledrejection', 'promise', 'b')
    recordCrash('boundary', 'chat', new Error('c'))
    expect(items().map((x) => x.source).sort()).toEqual([
      'crash.boundary',
      'crash.unhandledrejection',
      'crash.window.onerror',
    ])
  })
})

describe('性能超预算 → notify(silent)', () => {
  /**
   * jsdom 没有 PerformanceObserver,所以探针在这台机器上根本起不来 ——
   * 装一个**只做转发**的假观察者,把一条真的 LoAF 条目喂进真的 push,
   * 走的仍然是产品代码那条路(不是把 push 导出来直接调)。
   */
  class FakeObserver {
    static supportedEntryTypes = ['long-animation-frame', 'event']
    static feed: ((entries: PerformanceEntry[]) => void) | undefined
    constructor(private cb: (list: { getEntries(): PerformanceEntry[] }) => void) {}
    observe(init: { type: string }) {
      if (init.type !== 'long-animation-frame') return
      FakeObserver.feed = (entries) => this.cb({ getEntries: () => entries })
    }
    disconnect() {
      FakeObserver.feed = undefined
    }
  }

  it('超预算的那一帧进存档但**一个字都不弹**,source 是 perf.longFrame', async () => {
    vi.resetModules()
    vi.stubGlobal('PerformanceObserver', FakeObserver)
    // resetModules 之后 perf 拿到的是一份新的 notify-store 实例,所以两边都重新取。
    const { startPerfProbe } = await import('../perf')
    const { useNotifyStore: freshCenter } = await import('../notify-store')
    const { useToastHub: freshHub } = await import('../../ui/Toast')
    freshCenter.setState({ items: [] })
    freshHub.setState({ toasts: [], folded: 0 })

    const stop = startPerfProbe()
    FakeObserver.feed?.([
      { duration: PERF_BUDGET.longFrameMs + 40, name: 'frame' } as PerformanceEntry,
    ])
    stop()
    vi.unstubAllGlobals()

    expect(freshHub.getState().toasts).toEqual([])
    const [record] = freshCenter.getState().items
    expect(record.level).toBe('silent')
    expect(record.source).toBe('perf.longFrame')
    /*
     * detail 就是**完整现场文本**(08-30 可观测性批把它从一句 JSON 升级成现场):
     * 首行是帧时长 + 阶段拆分,其后逐段脚本归因。这一帧是假喂的、没有 scripts,
     * 所以它必须明说「浏览器没给归因」而不是留一片空白 —— 空白会被读成「没查到」。
     */
    expect(record.detail).toContain(`frame ${PERF_BUDGET.longFrameMs + 40}ms`)
    expect(record.detail).toContain('没给脚本归因')
  })
})
