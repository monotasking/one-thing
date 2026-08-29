import { beforeEach, describe, expect, it } from 'vitest'
import { PERF_BUDGET, overBudget } from '../../perf-budget'
import { __resetPerfForTests, startPerfProbe, summarizeScripts } from '../perf'

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
})

describe('LoAF 归因摘要', () => {
  const fake = (invoker: string, duration: number, sourceURL?: string) =>
    ({ invoker, duration, sourceURL, name: 'script' }) as unknown as PerformanceEntry

  it('按自身耗时降序,最多留三段', () => {
    const out = summarizeScripts([
      fake('a', 5),
      fake('b', 90),
      fake('c', 30),
      fake('d', 60),
    ])
    expect(out.map((s) => s.invoker)).toEqual(['b', 'd', 'c'])
    expect(out).toHaveLength(3)
  })

  it('没有归因(跨域时浏览器给空)时给空数组,不给 undefined —— 消费处不用再判一次', () => {
    expect(summarizeScripts(undefined)).toEqual([])
    expect(summarizeScripts([])).toEqual([])
  })

  it('invoker 缺席时退到 invokerType / name,不产出 undefined 字样', () => {
    const noInvoker = { duration: 12, invokerType: 'user-callback', name: 'x' }
    expect(summarizeScripts([noInvoker as unknown as PerformanceEntry])[0].invoker).toBe(
      'user-callback',
    )
  })

  it('空 sourceURL 折成 undefined,不留空串', () => {
    expect(summarizeScripts([fake('a', 1, '')])[0].source).toBeUndefined()
  })
})

describe('探针的环境适配', () => {
  it('jsdom 没有 PerformanceObserver / 不支持这两种 entryType —— 整步跳过而不是抛', () => {
    expect(() => startPerfProbe()()).not.toThrow()
  })
})
