import { describe, expect, it, vi } from 'vitest'
import { VariableRegistry } from '@onething/runtime/variables/registry'
import type { ContextVariable } from '@onething/runtime/variables'
import { EventBus } from '../../../events/event-bus.js'
import { createVariableSnapshotBridge } from '../snapshot-bridge.js'

describe('variable snapshot bridge ownership', () => {
  it('closes queued refresh admission before reading a later store', async () => {
    const registry = new VariableRegistry()
    let changed!: () => void
    registry.register({ id: 'test', claims: () => false, list: () => [], onExternalChange: listener => { changed = listener; return () => {} } })
    const sessions = vi.fn(() => ['a'])
    const bus = new EventBus()
    const stop = createVariableSnapshotBridge(registry, bus, sessions, error => { throw error })
    changed()
    await stop()
    expect(sessions).not.toHaveBeenCalled()
    registry.reset()
    bus.shutdown()
  })

  it('drains a real pending provider and prevents a late refresh from reaching a replacement bus', async () => {
    const registry = new VariableRegistry()
    const a = new EventBus()
    const b = new EventBus()
    const seenA = vi.fn()
    const seenB = vi.fn()
    a.onAnySessionAny(seenA, 'test-a')
    b.onAnySessionAny(seenB, 'test-b')
    let changed!: () => void
    let release!: (value: ContextVariable[]) => void
    const pending = new Promise<ContextVariable[]>(resolve => { release = resolve })
    registry.register({ id: 'test', claims: () => false, list: () => pending, onExternalChange: listener => { changed = listener; return () => {} } })
    const stop = createVariableSnapshotBridge(registry, a, () => ['session'], error => { throw error })
    changed()
    await Promise.resolve()
    const closing = stop()
    let stopped = false
    void closing.then(() => { stopped = true })
    await Promise.resolve()
    expect(stopped).toBe(false)
    const stopB = createVariableSnapshotBridge(new VariableRegistry(), b, () => ['session'], error => { throw error })
    release([])
    await closing
    expect(seenA).not.toHaveBeenCalled()
    expect(seenB).not.toHaveBeenCalled()
    await stopB()
    registry.reset()
    a.shutdown()
    b.shutdown()
  })
})
