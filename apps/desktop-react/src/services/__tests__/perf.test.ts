import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PERF_BUDGET, overBudget } from '../../perf-budget'
import {
  PERF_COUNT_KEY_CAP,
  PERF_RING_CAPACITY,
  PERF_SPAN_MIN_MS,
  __pushPerfForTests,
  __resetPerfCountThrottleForTests,
  __resetPerfForTests,
  collectScripts,
  describeTarget,
  dumpPerf,
  eventPhases,
  formatPerfDetail,
  loafPhases,
  perfCount,
  perfMark,
  perfReport,
  perfSpan,
  perfObserverCost,
  startPerfProbe,
  stopPerfProbe,
  collectTargetText,
  TARGET_SCAN_NODE_CAP,
  __resetPerfQueueForTests,
} from '../perf'
import { notify } from '../notify'

/*
 * `notify` 在这个文件里被替身掉:这一批要断的正是**它被叫了几次**
 * (09-10 的正反馈里,一帧慢会让它被叫三十次)。环、日志、HUD 那三条出口
 * 都是真的,只有「说给用户听」这一口是替身。
 */
vi.mock('../notify', () => ({ notify: vi.fn(() => 'nid') }))
const notifyMock = vi.mocked(notify)

beforeEach(() => {
  __resetPerfForTests()
  __resetPerfQueueForTests()
  notifyMock.mockClear()
})

describe('预算表', () => {
  it('判据是「严格超过」而不是「大于等于」—— 正好卡在线上的那一帧算过', () => {
    expect(overBudget('longFrame', PERF_BUDGET.longFrameMs)).toBe(false)
    expect(overBudget('longFrame', PERF_BUDGET.longFrameMs + 1)).toBe(true)
    expect(overBudget('interaction', PERF_BUDGET.interactionP95Ms)).toBe(false)
    expect(overBudget('interaction', PERF_BUDGET.interactionP95Ms + 1)).toBe(true)
  })

  it('event 的订阅阈值低于交互预算 —— 否则刚好超预算的那些交互根本不会被观察到', () => {
    expect(PERF_BUDGET.eventDurationThresholdMs).toBeLessThan(PERF_BUDGET.interactionP95Ms)
  })

  it('冷开预算不低于高频交互预算 —— 分档的意义就是一次性重交互允许比往复动作慢', () => {
    // 08-30 收紧:高频档按健康读数锚定(61ms + 余量),冷开档留在 RAIL 100。
    // 两档若倒挂,说明表被改乱了 —— 「切一下 tab」不可能比「冷画四百张卡」更宽裕。
    expect(PERF_BUDGET.coldOpenMs).toBeGreaterThanOrEqual(PERF_BUDGET.interactionP95Ms)
  })

  it('打点的进环门槛低于长帧线 —— 否则「哪段函数吃掉半帧」永远看不到', () => {
    expect(PERF_SPAN_MIN_MS).toBeLessThan(PERF_BUDGET.longFrameMs)
  })
})

describe('LoAF 脚本归因', () => {
  const fake = (
    invoker: string,
    duration: number,
    extra: Record<string, unknown> = {},
  ) => ({ invoker, duration, name: 'script', ...extra }) as unknown as PerformanceEntry

  it('全量收,按自身耗时降序 —— 不再截三条(说明问题的常常不是最长那段)', () => {
    const out = collectScripts([
      fake('a', 5),
      fake('b', 90),
      fake('c', 30),
      fake('d', 60),
      fake('e', 1),
    ])
    expect(out.map((s) => s.invoker)).toEqual(['b', 'd', 'c', 'a', 'e'])
    expect(out).toHaveLength(5)
  })

  it('没有归因(跨域时浏览器给空)时给空数组,不给 undefined —— 消费处不用再判一次', () => {
    expect(collectScripts(undefined)).toEqual([])
    expect(collectScripts([])).toEqual([])
  })

  it('invoker 缺席时退到 invokerType / name,不产出 undefined 字样', () => {
    const noInvoker = { duration: 12, invokerType: 'user-callback', name: 'x' }
    expect(collectScripts([noInvoker as unknown as PerformanceEntry])[0].invoker).toBe(
      'user-callback',
    )
  })

  it('空 sourceURL 折成 undefined,不留空串;at 一并缺席', () => {
    const out = collectScripts([fake('a', 1, { sourceURL: '' })])[0]
    expect(out.source).toBeUndefined()
    expect(out.at).toBeUndefined()
  })

  it('源位置拼成 `sourceURL:字符偏移`,函数名单独一格', () => {
    const out = collectScripts([
      fake('TimerHandler:setTimeout', 40, {
        sourceURL: 'http://localhost:5175/src/App.tsx',
        sourceFunctionName: 'tick',
        sourceCharPosition: 1287,
      }),
    ])[0]
    expect(out.at).toBe('http://localhost:5175/src/App.tsx:1287')
    expect(out.fn).toBe('tick')
    expect(out.invokerType).toBeUndefined()
  })

  it('给不出字符偏移(-1 / 缺席)时只留 URL —— 不拼一个假的 :-1', () => {
    expect(
      collectScripts([fake('a', 1, { sourceURL: 'x.js', sourceCharPosition: -1 })])[0].at,
    ).toBe('x.js')
    expect(collectScripts([fake('a', 1, { sourceURL: 'x.js' })])[0].at).toBe('x.js')
  })
})

describe('LoAF 渲染阶段拆分', () => {
  const loaf = (fields: Record<string, number>) =>
    ({ startTime: 100, duration: 80, ...fields }) as unknown as PerformanceEntry & {
      renderStart?: number
      styleAndLayoutStart?: number
    }

  it('两段都量到**帧尾**为止,所以 render ≥ style+layout', () => {
    // 100 起,180 止;renderStart 150 → 30ms;styleAndLayoutStart 165 → 15ms。
    const out = loafPhases(loaf({ renderStart: 150, styleAndLayoutStart: 165 }))
    expect(out.renderMs).toBe(30)
    expect(out.styleAndLayoutMs).toBe(15)
  })

  it('浏览器没报起点(0 / 缺席)时那一段缺席 —— 不拿 0 冒充「零耗时」', () => {
    expect(loafPhases(loaf({ renderStart: 0 })).renderMs).toBeUndefined()
    expect(loafPhases(loaf({})).styleAndLayoutMs).toBeUndefined()
  })

  it('起点落在帧尾之后(读数错乱)时也缺席,不产出负数', () => {
    expect(loafPhases(loaf({ renderStart: 999 })).renderMs).toBeUndefined()
  })
})

describe('交互三段拆分', () => {
  const event = (fields: Record<string, number>) =>
    ({ startTime: 1000, duration: 96, ...fields }) as unknown as PerformanceEntry & {
      processingStart?: number
      processingEnd?: number
    }

  it('input delay / processing / presentation 三段由四个时间点推得,和 ≈ duration', () => {
    const out = eventPhases(event({ processingStart: 1008, processingEnd: 1078 }))
    expect(out).toEqual({ inputDelayMs: 8, processingMs: 70, presentationMs: 18 })
    expect(out.inputDelayMs! + out.processingMs! + out.presentationMs!).toBe(96)
  })

  it('processingStart/End 缺席时整组缺席 —— 不猜', () => {
    expect(eventPhases(event({ processingStart: 1008 }))).toEqual({})
    expect(eventPhases(event({}))).toEqual({})
  })

  it('时间点错乱时夹到 0,不产出负毫秒', () => {
    const out = eventPhases(event({ processingStart: 990, processingEnd: 2000 }))
    expect(out.inputDelayMs).toBe(0)
    expect(out.presentationMs).toBe(0)
  })
})

describe('describeTarget', () => {
  const el = (html: string) => {
    const host = document.createElement('div')
    host.innerHTML = html
    return host.firstElementChild
  }

  /*
   * 下面两例里的 `<button …>` 是**喂给 `innerHTML` 的一段字符串**,不是 JSX ——
   * `describeTarget` 收的是一个真 DOM 节点,它要的正是「一颗光秃秃的 button
   * 长什么样」。这里没有任何组件可以消费:换成 `ui/Button` 既渲染不出这段
   * HTML,也就测不到那条「testid 优先、其次 aria-label」的判据。
   * 门是逐字扫标签的,认不出字符串与 JSX 的区别,所以逐处摘掉并写明理由。
   *
   * ui-consume-allow: bare-button-text — HTML 字符串夹具,喂 innerHTML 的被测输入,不是 JSX
   * ui-consume-allow: bare-button-icon — 同上,`<button aria-label>×</button>` 是被测的 DOM 形状本身
   */
  it('testid 优先 —— 门与测试就是拿它定位的,复现代价最低', () => {
    expect(describeTarget(el('<button data-testid="dock-tile-sessions" aria-label="会话">x</button>')))
      .toBe('button[data-testid="dock-tile-sessions"]')
  })

  it('没有 testid 退到 aria-label', () => {
    expect(describeTarget(el('<button aria-label="关闭">×</button>'))).toBe(
      'button[aria-label="关闭"]',
    )
  })

  it('都没有就用可见文字,空白折成单个空格', () => {
    expect(describeTarget(el('<span>  切换  到\n 终端 </span>'))).toBe('span "切换 到 终端"')
  })

  it('文字也没有就只给标签名 —— 总比一个 undefined 强', () => {
    expect(describeTarget(el('<div></div>'))).toBe('div')
  })

  it('长文本截断加省略号,不把面板撑爆', () => {
    const long = 'x'.repeat(200)
    const out = describeTarget(el(`<span>${long}</span>`))!
    expect(out.length).toBeLessThan(60)
    expect(out).toContain('…')
  })

  it('不是元素(null / window / 纯对象)时缺席,不抛', () => {
    expect(describeTarget(null)).toBeUndefined()
    expect(describeTarget(undefined)).toBeUndefined()
    expect(describeTarget({})).toBeUndefined()
    expect(describeTarget('button')).toBeUndefined()
  })
})

describe('perfSpan', () => {
  it('低于阈值的不进环 —— 否则热路径上的打点会把环冲干净', () => {
    expect(perfSpan('cheap', () => 42)).toBe(42)
    expect(dumpPerf()).toHaveLength(0)
  })

  it('超过阈值的进环,kind = span,名字原样', () => {
    const slow = () => {
      const until = performance.now() + PERF_SPAN_MIN_MS + 4
      while (performance.now() < until) {
        /* 忙等:要的就是一段真的花了时间的同步代码 */
      }
      return 'done'
    }
    expect(perfSpan('busy', slow)).toBe('done')
    const [entry] = dumpPerf()
    expect(entry.kind).toBe('span')
    expect(entry.name).toBe('busy')
    expect(entry.ms).toBeGreaterThanOrEqual(PERF_SPAN_MIN_MS)
  })

  it('async:等 promise 落定才收表,量的是整段而不是同步那一截', async () => {
    const value = await perfSpan('async', async () => {
      await new Promise((resolve) => setTimeout(resolve, PERF_SPAN_MIN_MS + 12))
      return 'ok'
    })
    expect(value).toBe('ok')
    const [entry] = dumpPerf()
    expect(entry?.name).toBe('async')
    expect(entry.ms).toBeGreaterThanOrEqual(PERF_SPAN_MIN_MS)
  })

  it('同步抛出:原样抛,读数照收(一段抛出来的慢函数照样是慢函数)', () => {
    expect(() =>
      perfSpan('throws', () => {
        const until = performance.now() + PERF_SPAN_MIN_MS + 4
        while (performance.now() < until) {
          /* 忙等 */
        }
        throw new Error('炸了')
      }),
    ).toThrow('炸了')
    expect(dumpPerf()[0]?.name).toBe('throws')
  })

  it('async 拒绝:原样拒,读数照收', async () => {
    await expect(
      perfSpan('rejects', async () => {
        await new Promise((resolve) => setTimeout(resolve, PERF_SPAN_MIN_MS + 12))
        throw new Error('炸了')
      }),
    ).rejects.toThrow('炸了')
    expect(dumpPerf()[0]?.name).toBe('rejects')
  })

  it('快的 async 同样不进环 —— 阈值对两种形态是同一条线', async () => {
    await perfSpan('fast-async', async () => 'x')
    expect(dumpPerf()).toHaveLength(0)
  })
})

describe('perfMark', () => {
  it('落一条 ms=0 的 span —— 它回答「后面那条长帧是哪个动作引起的」', () => {
    perfMark('shelf.activate:right')
    expect(dumpPerf()).toEqual([
      expect.objectContaining({ kind: 'span', ms: 0, name: 'shelf.activate:right' }),
    ])
  })

  it('同时打进 performance.mark(gate-perf 的 trace 录着 blink.user_timing)', () => {
    const spy = vi.spyOn(performance, 'mark')
    perfMark('probe')
    expect(spy).toHaveBeenCalledWith('probe')
    spy.mockRestore()
  })

  it('performance.mark 抛了也不连累环 —— 少一个时间轴标记而已', () => {
    const spy = vi.spyOn(performance, 'mark').mockImplementation(() => {
      throw new Error('nope')
    })
    expect(() => perfMark('probe')).not.toThrow()
    expect(dumpPerf()).toHaveLength(1)
    spy.mockRestore()
  })
})

describe('perfReport 聚合', () => {
  const push = (kind: 'span' | 'longFrame', name: string, ms: number) =>
    __pushPerfForTests({ ts: Date.now(), kind, name, ms })

  it('按 (kind, name) 分桶,给 count / p50 / p95 / max', () => {
    ;[10, 20, 30, 40, 50, 60, 70, 80, 90, 100].forEach((ms) => push('span', 'assemble', ms))
    const [row] = perfReport()
    expect(row).toEqual({ kind: 'span', name: 'assemble', count: 10, p50: 50, p95: 100, max: 100 })
  })

  it('kind 不同即不同桶 —— 同名的长帧与打点不许混算', () => {
    push('span', 'x', 10)
    push('longFrame', 'x', 20)
    expect(perfReport().map((r) => r.kind)).toEqual(['longFrame', 'span'])
  })

  it('按 max 降序 —— 读的人第一眼要看到最贵的那一行', () => {
    push('span', 'cheap', 9)
    push('span', 'pricey', 120)
    push('span', 'middling', 40)
    expect(perfReport().map((r) => r.name)).toEqual(['pricey', 'middling', 'cheap'])
  })

  it('单条读数时 p50/p95/max 都是它自己,不需要凑够样本', () => {
    push('span', 'lonely', 33)
    expect(perfReport()[0]).toMatchObject({ count: 1, p50: 33, p95: 33, max: 33 })
  })

  it('空环给空表,不给一行零', () => {
    expect(perfReport()).toEqual([])
  })
})

describe('喂一条假 LoAF 走 push 那条路', () => {
  it('超预算的长帧:现场文本里有每段脚本的 invoker + 源位置 + ms,以及阶段拆分', () => {
    const entry = {
      ts: Date.now(),
      kind: 'longFrame' as const,
      ms: 128,
      name: 'frame',
      blockingMs: 78,
      renderMs: 40,
      styleAndLayoutMs: 22,
      scripts: collectScripts([
        {
          invoker: 'BUTTON#tab.onclick',
          duration: 57,
          name: 'script',
          invokerType: 'event-listener',
          sourceURL: 'http://localhost:5175/src/components/EdgeShelf.tsx',
          sourceFunctionName: 'activate',
          sourceCharPosition: 4210,
        },
        {
          invoker: 'TimerHandler:setTimeout',
          duration: 31,
          name: 'script',
          sourceURL: 'http://localhost:5175/src/App.tsx',
        },
      ] as unknown as PerformanceEntry[]),
    }
    __pushPerfForTests(entry)

    expect(dumpPerf()).toHaveLength(1)
    const detail = formatPerfDetail(entry)
    expect(detail).toContain('frame 128ms · blocking 78ms · render 40ms · style+layout 22ms')
    expect(detail).toContain('1. BUTTON#tab.onclick 57ms (event-listener) fn=activate')
    expect(detail).toContain('EdgeShelf.tsx:4210')
    // 第二段也在 —— 「不再截三条」的意义就是第 N 段不许被吞。
    expect(detail).toContain('2. TimerHandler:setTimeout 31ms')
  })

  it('一段归因都没有时说清「浏览器没给」,而不是留一片空白', () => {
    const detail = formatPerfDetail({
      ts: 0,
      kind: 'longFrame',
      ms: 60,
      name: 'frame',
      scripts: [],
    })
    expect(detail).toContain('没给脚本归因')
  })

  it('交互的现场文本带 target 与三段拆分', () => {
    const detail = formatPerfDetail({
      ts: 0,
      kind: 'interaction',
      ms: 96,
      name: 'click',
      target: 'button[data-testid="dock-tile-sessions"]',
      interactionId: 12,
      inputDelayMs: 8,
      processingMs: 70,
      presentationMs: 18,
    })
    expect(detail).toContain('click 96ms')
    expect(detail).toContain('target button[data-testid="dock-tile-sessions"]')
    expect(detail).toContain('input delay 8ms · processing 70ms · presentation 18ms')
  })
})

describe('探针的环境适配', () => {
  it('jsdom 没有 PerformanceObserver / 不支持这两种 entryType —— 整步跳过而不是抛', () => {
    expect(() => startPerfProbe()()).not.toThrow()
  })
})


/* ══ P3:观察器不许自伤(09-01 性能分诊)════════════════════════════════════ */

/**
 * 装一台假的 `PerformanceObserver` + 假的 `requestIdleCallback`,于是可以:
 *  ① 把一批 LoAF 塞进回调,看回调**当场**做了什么(应该只是入队);
 *  ② 手动放行空闲,看归因/上报是不是那时候才发生。
 *
 * 不用真的 PerformanceObserver:jsdom 根本没有,而且真观察器的时机不可控 ——
 * 要验的正是「谁在什么时候干活」,时机必须是断言的一部分。
 */
function installFakeObserver() {
  const callbacks: ((list: { getEntries(): PerformanceEntry[] }) => void)[] = []
  const idle: ((deadline?: { timeRemaining(): number }) => void)[] = []

  class FakeObserver {
    static supportedEntryTypes = ['long-animation-frame', 'event']
    constructor(private cb: (list: { getEntries(): PerformanceEntry[] }) => void) {
      callbacks.push(cb)
    }
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal('PerformanceObserver', FakeObserver)
  vi.stubGlobal('requestIdleCallback', (cb: (d?: { timeRemaining(): number }) => void) => {
    idle.push(cb)
    return idle.length
  })
  ;(window as unknown as { requestIdleCallback: unknown }).requestIdleCallback =
    globalThis.requestIdleCallback

  return {
    /** 喂一批 LoAF 给**第一个**观察器(long-animation-frame 那路)。 */
    feedLoaf(entries: PerformanceEntry[]) {
      callbacks[0]?.({ getEntries: () => entries })
    },
    /** 喂一批 Event Timing 条目给**第二个**观察器(event 那路)。 */
    feedEvent(entries: PerformanceEntry[]) {
      callbacks[1]?.({ getEntries: () => entries })
    },
    /** 放行排着的空闲任务;不给 deadline = 当作时间管够。 */
    runIdle(timeRemaining = 50) {
      const queued = idle.splice(0, idle.length)
      queued.forEach((cb) => cb({ timeRemaining: () => timeRemaining }))
    },
    idleCount: () => idle.length,
  }
}

function loaf(ms: number, scripts = 1): PerformanceEntry {
  return {
    entryType: 'long-animation-frame',
    name: 'long-animation-frame',
    startTime: 0,
    duration: ms,
    blockingDuration: ms - 50,
    renderStart: ms * 0.8,
    styleAndLayoutStart: ms * 0.9,
    scripts: Array.from({ length: scripts }, (_, i) => ({
      name: 'script',
      entryType: 'script',
      startTime: 0,
      duration: ms / scripts,
      invoker: `handler-${i}`,
      invokerType: 'event-listener',
      sourceURL: 'http://localhost/src/whatever.ts',
      sourceFunctionName: `fn${i}`,
      sourceCharPosition: 100 + i,
      toJSON: () => ({}),
    })),
    toJSON: () => ({}),
  } as unknown as PerformanceEntry
}

describe('观察器回调只入队,归因与上报挪到空闲', () => {
  it('回调当场**一条都不落账** —— 环还是空的,活儿全排进了空闲', () => {
    const fake = installFakeObserver()
    startPerfProbe()
    fake.feedLoaf([loaf(120), loaf(80)])

    // 这就是这一批的全部主张:回调返回时,归因/序列化/通知一件都没发生。
    expect(dumpPerf()).toHaveLength(0)
    expect(perfObserverCost().pending).toBe(2)
    expect(fake.idleCount()).toBe(1) // 两条读数只排一个任务,不是两个

    fake.runIdle()
    expect(dumpPerf()).toHaveLength(2)
    expect(dumpPerf()[0].scripts?.[0].at).toContain('whatever.ts:100')

    stopPerfProbe()
    vi.unstubAllGlobals()
  })

  it('用它自己量自己:回调耗时 p99 有读数,且远低于一帧', () => {
    const fake = installFakeObserver()
    startPerfProbe()
    for (let i = 0; i < 60; i += 1) fake.feedLoaf([loaf(60 + i)])
    const cost = perfObserverCost()

    expect(cost.count).toBe(60)
    // 回调里只有「算下标 + 写三个数组格」,任何机器上都该在 1ms 以内。
    expect(cost.p99).toBeLessThan(1)
    expect(cost.max).toBeLessThan(1)

    stopPerfProbe()
    vi.unstubAllGlobals()
  })

  it('一次空闲最多落一批,剩下的再排一次 —— 空闲片自己不许变成长任务', () => {
    const fake = installFakeObserver()
    startPerfProbe()
    fake.feedLoaf(Array.from({ length: 40 }, () => loaf(60)))

    fake.runIdle()
    expect(dumpPerf().length).toBeLessThanOrEqual(16)
    expect(perfObserverCost().pending).toBeGreaterThan(0)
    expect(fake.idleCount()).toBe(1) // 还有剩就再排一次

    fake.runIdle()
    fake.runIdle()
    expect(perfObserverCost().pending).toBe(0)
    expect(dumpPerf()).toHaveLength(40)

    stopPerfProbe()
    vi.unstubAllGlobals()
  })

  it('空闲片用完就收手,不硬把这一批做完 —— **第一条也不例外**', () => {
    const fake = installFakeObserver()
    startPerfProbe()
    fake.feedLoaf(Array.from({ length: 16 }, () => loaf(60)))
    /*
     * 09-10 改判:从前这里写的是「至少硬做一条」,断言落 1 条。可这些读数正是
     * 主线程最忙时产生的,`timeout` 逼出来的那次落账剩余时间常常就是 0 ——
     * 「至少一条」在最坏的时刻变成插队干活,而一条落账要解析归因 + 拼现场文本。
     * 现在每一条都问一次 deadline,不够就一条都不做,整批排到下一次。
     */
    fake.runIdle(0.5) // 剩余时间不够:一条都不该落
    expect(dumpPerf()).toHaveLength(0)
    expect(perfObserverCost().pending).toBe(16)
    expect(fake.idleCount()).toBe(1) // 但一定重排,读数不会丢

    fake.runIdle() // 时间管够,照落
    expect(dumpPerf()).toHaveLength(16)

    stopPerfProbe()
    vi.unstubAllGlobals()
  })

  it('`timeRemaining` 恒 0 时一条不做,并且重排下一次 —— 不插队干活', () => {
    const fake = installFakeObserver()
    startPerfProbe()
    fake.feedLoaf(Array.from({ length: 5 }, () => loaf(60)))

    fake.runIdle(0)
    expect(dumpPerf()).toHaveLength(0)
    expect(perfObserverCost().pending).toBe(5)
    expect(fake.idleCount()).toBe(1)

    stopPerfProbe()
    vi.unstubAllGlobals()
  })

  it('队列满了丢最老的**并说出来** —— 不假装读数是全的', () => {
    const fake = installFakeObserver()
    startPerfProbe()
    fake.feedLoaf(Array.from({ length: 300 }, () => loaf(60)))
    const cost = perfObserverCost()
    expect(cost.dropped).toBe(300 - 256)
    expect(cost.pending).toBe(256)

    stopPerfProbe()
    vi.unstubAllGlobals()
  })

  it('反证:若回调里就地落账(旧写法),环在回调返回时就已经满了', () => {
    // 对照组 —— 直接走 push 那条路(旧实现的形状),证明上面那条
    // 「回调返回时环是空的」不是因为环坏了。
    __pushPerfForTests({ ts: 0, kind: 'longFrame', ms: 120, name: 'frame', scripts: [] })
    expect(dumpPerf()).toHaveLength(1)
  })
})

/* ══ P4:入队那道闸 + 一批只吵一次(09-10 真机自伤)═══════════════════════ */

/** 一条 Event Timing 条目。`interactionId` 0 = 不是一次交互(hover 族就是这一形)。 */
function evt(name: string, ms: number, interactionId = 0): PerformanceEntry {
  return {
    entryType: 'event',
    name,
    startTime: 0,
    duration: ms,
    processingStart: 1,
    processingEnd: 2,
    interactionId,
    target: null,
    toJSON: () => ({}),
  } as unknown as PerformanceEntry
}

describe('入队那道闸:只有真交互进得来,同一次交互只留一条', () => {
  it('一次划过嵌套容器的 30 条 hover 条目,一条都不进队(也不排空闲任务)', () => {
    const fake = installFakeObserver()
    startPerfProbe()

    const hover = ['pointerover', 'pointerout', 'pointerenter', 'pointerleave', 'mouseover', 'mouseout']
    fake.feedEvent(
      Array.from({ length: 30 }, (_, i) => evt(hover[i % hover.length], 60 + i, 0)),
    )

    expect(perfObserverCost().pending).toBe(0)
    expect(perfObserverCost().filtered).toBe(30)
    // 一条都没进来,连一次空闲任务都不该排 —— 那才是「不自伤」的完整含义。
    expect(fake.idleCount()).toBe(0)

    stopPerfProbe()
    vi.unstubAllGlobals()
  })

  it('interactionId 为 0 的**非** hover 事件同样拦住 —— 判据是分组号,不是名单', () => {
    const fake = installFakeObserver()
    startPerfProbe()
    fake.feedEvent([evt('scroll', 90, 0), evt('wheel', 80, 0)])
    expect(perfObserverCost().pending).toBe(0)
    expect(perfObserverCost().filtered).toBe(2)
    stopPerfProbe()
    vi.unstubAllGlobals()
  })

  it('同一个 interactionId 的三条只留一条,留**最长**那条(与 INP 同口径)', () => {
    const fake = installFakeObserver()
    startPerfProbe()
    // 浏览器对一次点击给三条同号条目:按下 / 抬起 / click。
    fake.feedEvent([evt('pointerdown', 50, 7), evt('pointerup', 96, 7), evt('click', 71, 7)])

    expect(perfObserverCost().pending).toBe(1)
    expect(perfObserverCost().filtered).toBe(2)

    fake.runIdle()
    const rows = dumpPerf()
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('pointerup')
    expect(rows[0].ms).toBe(96)

    stopPerfProbe()
    vi.unstubAllGlobals()
  })

  it('不同 interactionId 各占一格 —— 去重只在同一次交互内部', () => {
    const fake = installFakeObserver()
    startPerfProbe()
    fake.feedEvent([evt('click', 60, 1), evt('keydown', 61, 2), evt('click', 62, 3)])
    expect(perfObserverCost().pending).toBe(3)
    expect(perfObserverCost().filtered).toBe(0)
    stopPerfProbe()
    vi.unstubAllGlobals()
  })

  it('落账之后同号再来的算新的一条 —— 去重表不许把陈登记留成黑洞', () => {
    const fake = installFakeObserver()
    startPerfProbe()
    fake.feedEvent([evt('click', 60, 9)])
    fake.runIdle()
    expect(dumpPerf()).toHaveLength(1)

    fake.feedEvent([evt('click', 70, 9)])
    fake.runIdle()
    expect(dumpPerf()).toHaveLength(2)

    stopPerfProbe()
    vi.unstubAllGlobals()
  })
})

describe('describeTarget 有界:不读 textContent', () => {
  it('一万个文本节点的容器,只走到上限就停 —— 而且一次 textContent 都不读', () => {
    const host = document.createElement('div')
    for (let i = 0; i < 10000; i += 1) host.appendChild(document.createTextNode('x'))

    // 这一条是**反证的正面**:旧写法整段就是一句 `el.textContent`。
    const textContentGet = vi.spyOn(Node.prototype, 'textContent', 'get')
    const out = describeTarget(host)
    expect(textContentGet).not.toHaveBeenCalled()
    textContentGet.mockRestore()

    expect(out?.startsWith('div "')).toBe(true)
    // 走过的节点数有上界(根 + 若干孩子),与那一万个没关系。
    expect(collectTargetText(host).visited).toBeLessThanOrEqual(TARGET_SCAN_NODE_CAP)
  })

  it('压栈也照剩余额度截 —— 否则「把一万个孩子推进栈」本身就是那笔钱', () => {
    const host = document.createElement('div')
    for (let i = 0; i < 5000; i += 1) host.appendChild(document.createTextNode('y'))
    // 收 8 个节点的额度:根 + 7 个孩子,一个不多。
    expect(collectTargetText(host, 8).visited).toBe(8)
  })

  it('深树同样按文档序收,收够字符就停', () => {
    const host = document.createElement('div')
    host.innerHTML = '<span>前</span><b>中</b><i>后</i>'
    expect(collectTargetText(host).text).toBe('前中后')
  })
})

describe('一批落账只吵一次(通知不许自伤)', () => {
  it('12 条超预算长帧 → notify 一次,标题带「另有 N 条」,清单在 detail 里', () => {
    const fake = installFakeObserver()
    startPerfProbe()
    fake.feedLoaf(Array.from({ length: 12 }, (_, i) => loaf(60 + i)))
    fake.runIdle()

    // 12 条读数照旧全进环(记账那一半一条不少)……
    expect(dumpPerf()).toHaveLength(12)
    // ……但只说了一句话。
    expect(notifyMock).toHaveBeenCalledTimes(1)
    const said = notifyMock.mock.calls[0][0]
    expect(said.level).toBe('silent')
    expect(said.source).toBe('perf.longFrame')
    expect(said.title).toContain('11') // 最重那条 + 本批另有 11 条
    expect(said.title).toContain('71') // 最重那条就是 60+11
    // detail 首段是最重那条的完整现场,后面缀同批其余各一行。
    expect(said.detail).toContain('frame 71ms')
    expect(said.detail).toContain('frame 60ms')

    stopPerfProbe()
    vi.unstubAllGlobals()
  })

  it('20 条(跨两批)是 2 次,不是 20 次 —— 正反馈的那一环被掐在这里', () => {
    const fake = installFakeObserver()
    startPerfProbe()
    fake.feedLoaf(Array.from({ length: 20 }, (_, i) => loaf(60 + i)))
    fake.runIdle()
    fake.runIdle()
    expect(dumpPerf()).toHaveLength(20)
    expect(notifyMock).toHaveBeenCalledTimes(2)

    stopPerfProbe()
    vi.unstubAllGlobals()
  })

  it('长帧与交互在同一批里各说各的 —— 每个 kind 至多一条', () => {
    const fake = installFakeObserver()
    startPerfProbe()
    fake.feedLoaf([loaf(80), loaf(90)])
    fake.feedEvent([evt('click', 120, 4), evt('keydown', 130, 5)])
    fake.runIdle()

    expect(notifyMock).toHaveBeenCalledTimes(2)
    expect(notifyMock.mock.calls.map((c) => c[0].source).sort()).toEqual([
      'perf.interaction',
      'perf.longFrame',
    ])

    stopPerfProbe()
    vi.unstubAllGlobals()
  })

  it('批外那条路(手工打点)照旧逐条 —— 人自己埋的点,一次调用一次回音', () => {
    __pushPerfForTests({ ts: 0, kind: 'longFrame', ms: 120, name: 'frame', scripts: [] })
    __pushPerfForTests({ ts: 0, kind: 'longFrame', ms: 130, name: 'frame', scripts: [] })
    expect(notifyMock).toHaveBeenCalledTimes(2)
  })

  it('批里没有超预算的读数就一个字都不说', () => {
    const fake = installFakeObserver()
    startPerfProbe()
    fake.feedLoaf([loaf(40), loaf(30)]) // 都在长帧线以下
    fake.runIdle()
    expect(dumpPerf()).toHaveLength(2)
    expect(notifyMock).not.toHaveBeenCalled()

    stopPerfProbe()
    vi.unstubAllGlobals()
  })
})

/**
 * **`perfCount`:「理论不可能」的计数器进可见面**(09-02,设计审查条 13)。
 *
 * 三条纪律各一条用例:永不抛、节流去重、键带现场。
 */
describe('perfCount(自愈路上的记账)', () => {
  beforeEach(() => {
    __resetPerfForTests()
    __resetPerfCountThrottleForTests()
  })

  it('记一笔进同一个环 —— HUD 与通知中心读的就是它', () => {
    perfCount('stream.water.gap', { session: 's1', message: 'a1', total: 3 })
    const entries = dumpPerf()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'span', ms: 0, name: 'stream.water.gap' })
    expect(entries[0].detail).toBe('session=s1 message=a1 total=3')
    expect(formatPerfDetail(entries[0])).toBe('stream.water.gap · session=s1 message=a1 total=3')
  })

  it('节流去重:同一个键连着来只记一笔', () => {
    // 缺段是**成串**发生的(一条丢了,后面每一条都对不上偏移)——
    // 不节流的话 200 格的环会被同一件事冲干净,别的读数全丢。
    for (let i = 0; i < 50; i += 1) perfCount('stream.water.gap', { session: 's1', message: 'a1' })
    expect(dumpPerf()).toHaveLength(1)
  })

  it('键带现场:换会话 / 换消息各记各的', () => {
    perfCount('stream.water.gap', { session: 's1', message: 'a1' })
    perfCount('stream.water.gap', { session: 's1', message: 'a2' })
    perfCount('stream.water.gap', { session: 's2', message: 'a1' })
    expect(dumpPerf()).toHaveLength(3)
  })

  it('永不抛 —— 它的调用点全在自愈分支里', () => {
    const hostile = { get bad() { throw new Error('boom') } } as unknown as Record<string, string>
    expect(() => perfCount('stream.block.violation', hostile)).not.toThrow()
  })
})

describe('perfCount 的节流表是有界的', () => {
  it('键满了整份丢 —— 键里带消息 id,长会话上它只增', () => {
    __resetPerfForTests()
    __resetPerfCountThrottleForTests()
    for (let i = 0; i < PERF_COUNT_KEY_CAP + 5; i += 1) {
      perfCount('stream.water.gap', { message: `m${i}` })
    }
    // 丢过一次之后照旧记账,不会因为满了就哑掉(环自己只留最后 200 格)。
    const entries = dumpPerf()
    expect(entries.length).toBe(PERF_RING_CAPACITY)
    expect(entries[entries.length - 1].detail).toBe(`message=m${PERF_COUNT_KEY_CAP + 4}`)
  })
})
