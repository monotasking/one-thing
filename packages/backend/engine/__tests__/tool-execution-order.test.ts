import { describe, expect, it } from 'vitest'
import {
  OrderedSideEffectQueue,
  needsOrderedSideEffectGate,
} from '../stream/tool-execution-order'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

describe('OrderedSideEffectQueue', () => {
  it('lets later permission phases run before earlier side effects are approved', async () => {
    const queue = new OrderedSideEffectQueue()
    const first = queue.createGate()
    const second = queue.createGate()
    const firstApproved = deferred<void>()
    const events: string[] = []

    const secondTask = (async () => {
      events.push('second:permission')
      await second.beforeSideEffect()
      events.push('second:side-effect')
      second.release()
    })()

    await tick()
    expect(events).toEqual(['second:permission'])

    const firstTask = (async () => {
      events.push('first:permission')
      await firstApproved.promise
      await first.beforeSideEffect()
      events.push('first:side-effect')
      first.release()
    })()

    await tick()
    expect(events).toEqual(['second:permission', 'first:permission'])

    firstApproved.resolve()
    await Promise.all([firstTask, secondTask])

    expect(events).toEqual([
      'second:permission',
      'first:permission',
      'first:side-effect',
      'second:side-effect',
    ])
  })

  it('classifies mutating or opaque tools as ordered side effects', () => {
    expect(needsOrderedSideEffectGate('edit')).toBe(true)
    expect(needsOrderedSideEffectGate('write')).toBe(true)
    expect(needsOrderedSideEffectGate('bash')).toBe(true)
    expect(needsOrderedSideEffectGate('variable')).toBe(true)
    expect(needsOrderedSideEffectGate('mcp:server:tool')).toBe(true)
    expect(needsOrderedSideEffectGate('mcp_server_tool')).toBe(true)
    expect(needsOrderedSideEffectGate('read')).toBe(false)
  })
})
