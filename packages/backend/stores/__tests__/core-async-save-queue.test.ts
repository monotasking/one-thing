import { describe, expect, it, vi } from 'vitest'
import { AsyncSaveQueue } from '@onething/core/storage'

describe('AsyncSaveQueue', () => {
  it('coalesces scheduled writes and flushes the latest value', async () => {
    vi.useFakeTimers()

    const values = new Map<string, { count: number }>()
    const writes: Array<{ id: string; value: { count: number } }> = []
    const queue = new AsyncSaveQueue<{ count: number }>({
      throttleMs: 300,
      getLatest: id => values.get(id),
      write: async (id, value) => {
        writes.push({ id, value })
      },
    })

    values.set('s1', { count: 1 })
    queue.schedule('s1')
    values.set('s1', { count: 2 })
    queue.schedule('s1')

    await queue.flush('s1')

    expect(writes).toEqual([{ id: 's1', value: { count: 2 } }])
    vi.useRealTimers()
  })

  it('honors a per-schedule lazy delay', async () => {
    vi.useFakeTimers()

    const values = new Map([['s1', { count: 1 }]])
    const writes: Array<{ id: string; value: { count: number } }> = []
    const queue = new AsyncSaveQueue<{ count: number }>({
      throttleMs: 300,
      getLatest: id => values.get(id),
      write: async (id, value) => {
        writes.push({ id, value })
      },
    })

    queue.schedule('s1', 5000)
    await vi.advanceTimersByTimeAsync(4900)
    expect(writes).toEqual([])
    await vi.advanceTimersByTimeAsync(100)
    expect(writes).toEqual([{ id: 's1', value: { count: 1 } }])
    vi.useRealTimers()
  })

  it('upgrades a pending lazy save when an urgent schedule arrives', async () => {
    vi.useFakeTimers()

    const values = new Map([['s1', { count: 1 }]])
    const writes: Array<{ id: string; value: { count: number } }> = []
    const queue = new AsyncSaveQueue<{ count: number }>({
      throttleMs: 300,
      getLatest: id => values.get(id),
      write: async (id, value) => {
        writes.push({ id, value })
      },
    })

    queue.schedule('s1', 5000)
    queue.schedule('s1')
    await vi.advanceTimersByTimeAsync(300)
    expect(writes).toEqual([{ id: 's1', value: { count: 1 } }])
    vi.useRealTimers()
  })

  it('does not postpone a pending urgent save when a lazy schedule arrives', async () => {
    vi.useFakeTimers()

    const values = new Map([['s1', { count: 1 }]])
    const writes: Array<{ id: string; value: { count: number } }> = []
    const queue = new AsyncSaveQueue<{ count: number }>({
      throttleMs: 300,
      getLatest: id => values.get(id),
      write: async (id, value) => {
        writes.push({ id, value })
      },
    })

    queue.schedule('s1')
    queue.schedule('s1', 5000)
    await vi.advanceTimersByTimeAsync(300)
    expect(writes).toEqual([{ id: 's1', value: { count: 1 } }])
    vi.useRealTimers()
  })

  it('cancels scheduled writes', async () => {
    vi.useFakeTimers()

    const values = new Map([['s1', { count: 1 }]])
    const writes: Array<{ id: string; value: { count: number } }> = []
    const queue = new AsyncSaveQueue<{ count: number }>({
      throttleMs: 300,
      getLatest: id => values.get(id),
      write: async (id, value) => {
        writes.push({ id, value })
      },
    })

    queue.schedule('s1')
    queue.cancel('s1')
    await vi.advanceTimersByTimeAsync(300)

    expect(writes).toEqual([])
    vi.useRealTimers()
  })

  it('retries a failed write with backoff until it succeeds', async () => {
    vi.useFakeTimers()

    let attempts = 0
    const values = new Map([['s1', { count: 1 }]])
    const queue = new AsyncSaveQueue<{ count: number }>({
      throttleMs: 300,
      retryBaseDelayMs: 500,
      getLatest: id => values.get(id),
      write: async () => {
        attempts += 1
        if (attempts < 3) throw new Error('disk busy')
      },
    })

    queue.schedule('s1')
    await vi.advanceTimersByTimeAsync(300) // first attempt fails
    expect(attempts).toBe(1)
    await vi.advanceTimersByTimeAsync(500) // retry 1 (fails)
    expect(attempts).toBe(2)
    await vi.advanceTimersByTimeAsync(1000) // retry 2 (succeeds)
    expect(attempts).toBe(3)
    // 成功后条目被清理
    expect(queue.getPendingIds()).toEqual([])
    vi.useRealTimers()
  })

  it('gives up after maxRetries and reports exhaustion', async () => {
    vi.useFakeTimers()

    const exhausted: string[] = []
    const queue = new AsyncSaveQueue<{ count: number }>({
      throttleMs: 300,
      maxRetries: 2,
      retryBaseDelayMs: 100,
      getLatest: () => ({ count: 1 }),
      write: async () => {
        throw new Error('permanent failure')
      },
      onRetryExhausted: id => exhausted.push(id),
    })

    queue.schedule('s1')
    await vi.advanceTimersByTimeAsync(300) // attempt 1
    await vi.advanceTimersByTimeAsync(100) // retry 1
    await vi.advanceTimersByTimeAsync(200) // retry 2 -> exhausted
    expect(exhausted).toEqual(['s1'])
    expect(queue.getPendingIds()).toEqual([])
    vi.useRealTimers()
  })

  it('removes idle entries after a successful timer-driven write', async () => {
    vi.useFakeTimers()

    const values = new Map([['s1', { count: 1 }]])
    const queue = new AsyncSaveQueue<{ count: number }>({
      throttleMs: 300,
      getLatest: id => values.get(id),
      write: async () => {},
    })

    queue.schedule('s1')
    expect(queue.getPendingIds()).toEqual(['s1'])
    await vi.advanceTimersByTimeAsync(300)
    // 定时驱动写入完成后应自行清理,不再无界增长
    expect(queue.getPendingIds()).toEqual([])
    vi.useRealTimers()
  })
})
