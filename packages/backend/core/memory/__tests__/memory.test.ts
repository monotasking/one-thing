import { describe, expect, it, vi } from 'vitest'
import { MemoryGovernor, MemoryRegistry, type MemoryHolder } from '../index.js'

function holder(id: string, entries: number, trim?: MemoryHolder['trim']): MemoryHolder {
  return { id, label: id, usage: () => ({ entries, unit: 'items' }), ...(trim ? { trim } : {}) }
}

describe('MemoryRegistry', () => {
  it('reports every registered holder and forgets it after unregister', async () => {
    const registry = new MemoryRegistry(() => 42)
    const off = registry.registerHolder(holder('a.one', 3))
    registry.registerHolder(holder('b.two', 5, () => ({ releasedEntries: 5 })))
    const report = await registry.report()
    expect(report.capturedAt).toBe(42)
    expect(report.holders.map(row => [row.id, row.entries, row.trimmable])).toEqual([['a.one', 3, false], ['b.two', 5, true]])
    off()
    expect(registry.holderIds()).toEqual(['b.two'])
  })

  it('rejects a duplicate id — two holders under one name is a wiring bug', () => {
    const registry = new MemoryRegistry()
    registry.registerHolder(holder('dup', 1))
    expect(() => registry.registerHolder(holder('dup', 1))).toThrow(/already registered/)
  })

  it('a throwing holder does not take the table down, for usage or for trim', async () => {
    const registry = new MemoryRegistry()
    registry.registerHolder({ id: 'bad', label: 'bad', usage: () => { throw new Error('boom') }, trim: () => { throw new Error('nope') } })
    registry.registerHolder(holder('good', 2, () => ({ releasedEntries: 2, releasedBytes: 10 })))
    const report = await registry.report()
    expect(report.holders.find(row => row.id === 'bad')?.error).toBe('boom')
    const trim = await registry.trim('hard')
    expect(trim.releasedEntries).toBe(2)
    expect(trim.releasedBytes).toBe(10)
    expect(trim.holders.find(row => row.id === 'bad')?.error).toBe('nope')
  })

  it('sums probe bytes, dedupes pids (first probe wins) and flags unmeasured rows as partial', async () => {
    const registry = new MemoryRegistry()
    registry.registerProbe({ id: 'self', sample: () => [{ pid: 1, kind: 'main', name: 'core', bytes: 100 }] })
    registry.registerProbe({ id: 'host', sample: () => [
      { pid: 1, kind: 'main', name: 'dup', bytes: 999 },
      { pid: 2, kind: 'renderer', name: 'win', bytes: 50 },
      { pid: 3, kind: 'gpu', name: 'gpu', bytes: null },
    ] })
    const sampled = await registry.sampleProcesses()
    expect(sampled.totalBytes).toBe(150)
    expect(sampled.partial).toBe(true)
    expect(sampled.processes.map(row => row.name)).toEqual(['core', 'win', 'gpu'])
  })
})

describe('MemoryGovernor', () => {
  function setup(bytes: { value: number }, now: { value: number }) {
    const registry = new MemoryRegistry()
    registry.registerProbe({ id: 'self', sample: () => [{ pid: 1, kind: 'main', name: 'core', bytes: bytes.value }] })
    const trim = vi.fn((pressure: 'soft' | 'hard') => ({ releasedEntries: pressure === 'hard' ? 2 : 1 }))
    registry.registerHolder({ id: 'h', label: 'h', usage: () => ({ entries: 0, unit: 'x' }), trim })
    const onTrim = vi.fn()
    const governor = new MemoryGovernor({
      registry,
      budget: { softBytes: 100, hardBytes: 200 },
      fallbackBytes: () => 0,
      intervalMs: 0,
      cooldownMs: 1000,
      now: () => now.value,
      onTrim,
    })
    return { governor, trim, onTrim }
  }

  it('does nothing under budget, soft-trims over soft, hard-trims over hard', async () => {
    const bytes = { value: 50 }
    const now = { value: 0 }
    const { governor, trim, onTrim } = setup(bytes, now)
    expect(await governor.tick()).toEqual({ bytes: 50, pressure: null, trimmed: false })
    bytes.value = 150
    expect((await governor.tick()).trimmed).toBe(true)
    expect(trim).toHaveBeenLastCalledWith('soft')
    now.value = 5000
    bytes.value = 250
    expect(await governor.tick()).toMatchObject({ pressure: 'hard', trimmed: true })
    expect(trim).toHaveBeenLastCalledWith('hard')
    expect(onTrim).toHaveBeenCalledTimes(2)
  })

  it('respects the cooldown — still over budget right after a trim does not trim again', async () => {
    const bytes = { value: 250 }
    const now = { value: 0 }
    const { governor, trim } = setup(bytes, now)
    await governor.tick()
    now.value = 500
    expect(await governor.tick()).toMatchObject({ pressure: 'hard', trimmed: false })
    now.value = 1500
    expect((await governor.tick()).trimmed).toBe(true)
    expect(trim).toHaveBeenCalledTimes(2)
  })

  it('falls back to the injected reading when no probe measured anything', async () => {
    const registry = new MemoryRegistry()
    const governor = new MemoryGovernor({ registry, budget: { softBytes: 10, hardBytes: 20 }, fallbackBytes: () => 15, intervalMs: 0 })
    expect(await governor.tick()).toMatchObject({ bytes: 15, pressure: 'soft', trimmed: true })
  })
})
