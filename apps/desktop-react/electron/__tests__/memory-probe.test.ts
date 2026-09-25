import { describe, expect, it } from 'vitest'
import { toMemoryProcessSamples } from '../memory-probe.js'

describe('shell memory probe', () => {
  it('maps app metrics to table rows in bytes, skipping the core process itself', () => {
    const rows = toMemoryProcessSamples([
      { pid: 10, type: 'Browser', memory: { workingSetSize: 100 } },
      { pid: 11, type: 'Tab', memory: { workingSetSize: 200 } },
      { pid: 12, type: 'Tab', memory: { workingSetSize: 300, privateBytes: 250 } },
      { pid: 13, type: 'GPU', memory: { workingSetSize: 0 } },
      { pid: 14, type: 'Utility', serviceName: 'network.mojom.NetworkService', memory: { workingSetSize: 50 } },
    ], [
      { pid: 11, role: 'shell', title: 'onething' },
      { pid: 12, role: 'browser', title: 'x'.repeat(200) },
    ], 10)
    expect(rows.map(row => [row.pid, row.kind, row.bytes])).toEqual([
      [11, 'renderer', 200 * 1024],
      [12, 'browser', 250 * 1024],
      [13, 'gpu', null],
      [14, 'utility', 50 * 1024],
    ])
    expect(rows[1].name.length).toBeLessThanOrEqual(81)
    expect(rows[3].name).toBe('network.mojom.NetworkService')
  })

  it('names a site-isolated iframe process after the tab it lives in, main frame winning a shared pid', () => {
    const rows = toMemoryProcessSamples([
      { pid: 20, type: 'Tab', memory: { workingSetSize: 10 } },
      { pid: 21, type: 'Tab', memory: { workingSetSize: 10 } },
    ], [
      { pid: 20, role: 'browser', title: 'bilibili', subframe: true },
      { pid: 20, role: 'browser', title: 'google' },
      { pid: 21, role: 'browser', title: 'bilibili', subframe: true },
    ], 1)
    expect(rows.map(row => [row.kind, row.name])).toEqual([['browser', 'google'], ['browser', 'bilibili · 子框架']])
  })
})
