import { afterEach, expect, it, vi } from 'vitest'
import { GoalRetryScheduler } from '../retry-scheduler.js'

afterEach(() => { vi.useRealTimers() })

it('cancels old Backend timers and keeps a new scheduler with the same session independent', async () => {
  vi.useFakeTimers()
  const oldKick = vi.fn()
  const nextKick = vi.fn()
  const old = new GoalRetryScheduler(oldKick, vi.fn())
  old.schedule('same-session', 1)
  old.quiesce()
  await old.drain()
  const replacement = new GoalRetryScheduler(nextKick, vi.fn())
  replacement.schedule('same-session', 1)
  old.schedule('same-session', 1)
  await vi.advanceTimersByTimeAsync(5000)
  expect(oldKick).not.toHaveBeenCalled()
  expect(nextKick).toHaveBeenCalledExactlyOnceWith('same-session')
  replacement.quiesce()
  await replacement.drain()
})

it('retains an already-fired kick until the actual asynchronous work settles', async () => {
  vi.useFakeTimers()
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const kick = vi.fn(() => waiting)
  const retries = new GoalRetryScheduler(kick, vi.fn())
  retries.schedule('session', 1)
  await vi.advanceTimersByTimeAsync(5000)
  expect(kick).toHaveBeenCalledOnce()
  retries.quiesce()
  let drained = false
  const stopping = retries.drain().then(() => { drained = true })
  await Promise.resolve()
  expect(drained).toBe(false)
  release()
  await stopping
  expect(drained).toBe(true)
})
