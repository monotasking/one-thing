import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PERF_BUDGET, overBudget } from '../../perf-budget'
import {
  PERF_SPAN_MIN_MS,
  __pushPerfForTests,
  __resetPerfForTests,
  collectScripts,
  describeTarget,
  dumpPerf,
  eventPhases,
  formatPerfDetail,
  loafPhases,
  perfMark,
  perfReport,
  perfSpan,
  startPerfProbe,
} from '../perf'

beforeEach(() => {
  __resetPerfForTests()
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
