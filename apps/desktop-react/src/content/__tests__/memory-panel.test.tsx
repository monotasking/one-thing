import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryPanel } from '../memory/MemoryPanel'
import { appendSample, groupByCategory, holderDetailParts, holderFill, meterScale, nearestIndex, pressureTone, sortProcesses, trendGeometry } from '../memory/memory-model'
import { PanelVisibilityContext } from '../visibility'
import { configureMemoryPort, memoryReportQuery } from '../../data/memory-source'
import { useStageStore } from '../../stage/store'
import type { MemoryReportResponse } from '@shared/ipc/memory'

/**
 * 内存监视器:读法(纯函数)各测各的;面板测三件 —— 按大小排的进程表、缓存行、
 * 看不见就不问、「释放缓存」走 trim 并把结果念出来。
 */

const MB = 1024 * 1024

function report(over: Partial<MemoryReportResponse> = {}): MemoryReportResponse {
  return {
    capturedAt: 1,
    totalBytes: 1700 * MB,
    partial: false,
    processes: [
      { pid: 2, kind: 'renderer', name: 'onething', bytes: 350 * MB },
      { pid: 1, kind: 'main', name: 'core', bytes: 630 * MB },
      { pid: 3, kind: 'browser', name: '哔哩哔哩', bytes: 215 * MB },
      { pid: 4, kind: 'gpu', name: 'GPU', bytes: null },
    ],
    holders: [
      { id: 'sessions.projections', label: '会话活投影', entries: 8, unit: 'sessions', bytes: 27 * MB, limit: { entries: 8, bytes: 64 * MB }, detail: { idle: 7 }, trimmable: true },
    ],
    budget: { softBytes: 1024 * MB, hardBytes: 1536 * MB },
    heap: { usedBytes: 157 * MB, totalBytes: 160 * MB, externalBytes: 16 * MB, arrayBuffersBytes: 1 * MB },
    ...over,
  }
}

describe('memory model', () => {
  const budget = { softBytes: 100, hardBytes: 200 }

  it('reads the pressure against the two lines, and says idle when nothing was measured', () => {
    expect(pressureTone({ totalBytes: 50, budget })).toBe('ok')
    expect(pressureTone({ totalBytes: 150, budget })).toBe('warn')
    expect(pressureTone({ totalBytes: 250, budget })).toBe('bad')
    expect(pressureTone({ totalBytes: null, budget })).toBe('idle')
  })

  it('keeps both budget ticks inside the meter, even far over the hard line', () => {
    const under = meterScale({ totalBytes: 50, budget })
    expect(under.max).toBe(240)
    expect(under.hard).toBeLessThan(1)
    const over = meterScale({ totalBytes: 1000, budget })
    expect(over.fill).toBeLessThan(1)
    expect(over.hard).toBeGreaterThan(0)
    expect(meterScale({ totalBytes: null, budget }).fill).toBeUndefined()
  })

  it('folds seven process kinds into four fixed-order categories, dropping empty ones', () => {
    const groups = groupByCategory(report().processes)
    expect(groups.map(group => group.category)).toEqual(['core', 'ui', 'web', 'system'])
    expect(groups[0].bytes).toBe(630 * MB)
    expect(groups.reduce((sum, group) => sum + group.share, 0)).toBeCloseTo(1)
    const noWeb = groupByCategory(report().processes.filter(row => row.kind !== 'browser'))
    expect(noWeb.map(group => group.category)).toEqual(['core', 'ui', 'system'])
  })

  it('sorts biggest first with unmeasured rows last, without touching the cached array', () => {
    const rows = report().processes
    expect(sortProcesses(rows).map(row => row.pid)).toEqual([1, 2, 3, 4])
    expect(rows[0].pid).toBe(2)
  })

  it('keeps a bounded, de-duplicated history and lays it out on time, with both budget lines in range', () => {
    let history = appendSample([], { at: 0, bytes: 10 }, 3)
    history = appendSample(history, { at: 0, bytes: 99 }, 3)
    expect(history).toHaveLength(1)
    for (const at of [1, 2, 3]) history = appendSample(history, { at: at * 1000, bytes: 10 }, 3)
    expect(history.map(sample => sample.at)).toEqual([1000, 2000, 3000])
    const geometry = trendGeometry(history, budget, 100, 50)!
    expect(geometry.points.map(point => point.x)).toEqual([0, 50, 100])
    // 两根参照线永远在图里(纵轴包住它们),数据在两线之外也一样。
    expect(geometry.hardY).toBeGreaterThan(0)
    expect(geometry.softY).toBeLessThan(50)
    expect(geometry.yMin).toBeLessThanOrEqual(10)
    expect(trendGeometry(history.slice(0, 1), budget, 100, 50)).toBeUndefined()
    expect(nearestIndex([0, 50, 100], 70)).toBe(1)
  })

  it('names known detail keys, keeps unknown ones raw, and only meters holders with a count limit', () => {
    expect(holderDetailParts({ detail: { idle: 7, novel: 1 } })).toEqual([
      { key: 'memory.detailIdle', raw: 'idle', value: '7' },
      { raw: 'novel', value: '1' },
    ])
    expect(holderFill({ entries: 4, limit: { entries: 8 } })).toBe(0.5)
    expect(holderFill({ entries: 4 })).toBeUndefined()
  })
})

describe('MemoryPanel', () => {
  const port = { report: vi.fn(async () => report()), trim: vi.fn(async () => ({ pressure: 'hard' as const, releasedEntries: 3, releasedBytes: 40 * MB, holders: [] })) }

  beforeEach(() => {
    useStageStore.setState({ locale: 'zh' })
    port.report.mockClear()
    port.trim.mockClear()
    configureMemoryPort(port)
    memoryReportQuery.reset()
  })
  afterEach(() => { configureMemoryPort(undefined) })

  const mount = (visible = true) => render(
    <PanelVisibilityContext.Provider value={{ visible, interactive: visible }}>
      <MemoryPanel />
    </PanelVisibilityContext.Provider>,
  )

  it('shows processes biggest first and the cache rows', async () => {
    mount()
    const rows = await screen.findAllByTestId('memory-process-row')
    // 分组次序固定(核心 / 界面 / 网页 / 系统),core 的内部名念成人话。
    expect(rows.map(row => within(row).getByTestId('memory-process-name').textContent)).toEqual(['主进程', 'onething', '哔哩哔哩', 'GPU'])
    expect(within(rows[3]).getByText('量不到')).toBeTruthy()
    expect(screen.getByTestId('memory-total').textContent).toBe('1.7GB')
    expect(screen.getByText('超过 hard 线')).toBeTruthy()
    expect(screen.getByRole('meter', { name: '内存占用与预算' }).getAttribute('aria-valuetext')).toBe('1.7 GB')
    expect(screen.getByRole('meter', { name: '会话活投影:已用 / 上限' }).getAttribute('data-tone')).toBe('accent')
    const holder = screen.getByTestId('memory-holder-row')
    expect(holder.textContent).toContain('8 / 8 个会话')
    expect(holder.textContent).toContain('空闲 7')
  })

  it('does not ask while the panel is not visible', async () => {
    mount(false)
    await act(async () => { await Promise.resolve() })
    expect(port.report).not.toHaveBeenCalled()
  })

  it('release runs a hard trim and reports what it freed', async () => {
    mount()
    await screen.findAllByTestId('memory-process-row')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '释放缓存' })) })
    expect(port.trim).toHaveBeenCalledWith('hard')
    expect(await screen.findByText(/刚才释放了 3 项/)).toBeTruthy()
  })
})
