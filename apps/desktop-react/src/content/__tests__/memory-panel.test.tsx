import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryPanel } from '../memory/MemoryPanel'
import { budgetRatio, holderDetailText, pressureTone, shareOfLargest, sortProcesses } from '../memory/memory-model'
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
  it('reads the pressure against the two lines, and says idle when nothing was measured', () => {
    const budget = { softBytes: 100, hardBytes: 200 }
    expect(pressureTone({ totalBytes: 50, budget })).toBe('ok')
    expect(pressureTone({ totalBytes: 150, budget })).toBe('warn')
    expect(pressureTone({ totalBytes: 250, budget })).toBe('bad')
    expect(pressureTone({ totalBytes: null, budget })).toBe('idle')
    expect(budgetRatio({ totalBytes: 300, budget })).toBe(1)
    expect(budgetRatio({ totalBytes: null, budget })).toBeUndefined()
  })

  it('sorts biggest first with unmeasured rows last, without touching the cached array', () => {
    const rows = report().processes
    expect(sortProcesses(rows).map(row => row.pid)).toEqual([1, 2, 3, 4])
    expect(rows[0].pid).toBe(2)
    expect(shareOfLargest(sortProcesses(rows)).get(1)).toBe(1)
    expect(holderDetailText({ detail: { idle: 7, protected: 1 } })).toBe('idle=7 · protected=1')
    expect(holderDetailText({})).toBeUndefined()
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
    expect(rows.map(row => within(row).getAllByRole('cell')[0].textContent)).toEqual(['core', 'onething', '哔哩哔哩', 'GPU'])
    expect(within(rows[2]).getByText('网页')).toBeTruthy()
    expect(within(rows[3]).getByText('量不到')).toBeTruthy()
    expect(screen.getByTestId('memory-total').textContent).toContain('超过 hard 线')
    const holder = screen.getByTestId('memory-holder-row')
    expect(holder.textContent).toContain('8 个会话')
    expect(holder.textContent).toContain('idle=7')
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
