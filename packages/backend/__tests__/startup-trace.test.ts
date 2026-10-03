import { beforeEach, describe, expect, it } from 'vitest'
import {
  formatStartupSummary,
  getStartupMarks,
  markStartup,
  markStartupProcessStart,
  resetStartupTrace,
} from '../perf/startup-trace.js'

describe('startup-trace', () => {
  beforeEach(() => {
    resetStartupTrace()
  })

  it('reports an empty trace', () => {
    expect(formatStartupSummary()).toBe('[Perf][Startup] no marks recorded')
  })

  it('formats consecutive deltas and total', () => {
    markStartup('a', 1000)
    markStartup('b', 1250)
    markStartup('c', 1300)
    expect(formatStartupSummary()).toBe('[Perf][Startup] a→b=250ms | b→c=50ms | total=300ms')
  })

  it('sorts marks recorded out of order', () => {
    markStartup('late', 2000)
    markStartup('early', 1000)
    expect(formatStartupSummary()).toBe('[Perf][Startup] early→late=1000ms | total=1000ms')
  })

  it('derives process start from uptime', () => {
    markStartupProcessStart(1.5, 10_000)
    markStartup('main-start', 10_000)
    expect(getStartupMarks()[0]).toEqual({ name: 'process-start', at: 8500 })
    expect(formatStartupSummary()).toBe(
      '[Perf][Startup] process-start→main-start=1500ms | total=1500ms',
    )
  })

  it('handles a single mark', () => {
    markStartup('only', 42)
    expect(formatStartupSummary()).toBe('[Perf][Startup] only | total=0ms')
  })

  it('resets recorded marks', () => {
    markStartup('a', 1)
    resetStartupTrace()
    expect(getStartupMarks()).toHaveLength(0)
  })
})
