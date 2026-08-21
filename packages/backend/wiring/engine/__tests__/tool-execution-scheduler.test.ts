import { describe, expect, it } from 'vitest'
import { ToolExecutionScheduler } from '../stream/tool-execution-scheduler'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

describe('ToolExecutionScheduler', () => {
  it('blocks later read-only jobs behind a pending barrier', async () => {
    const scheduler = new ToolExecutionScheduler()
    const barrierDone = deferred<void>()
    const events: string[] = []

    const editJob = scheduler.enqueue(async () => {
      events.push('edit:start')
      await barrierDone.promise
      events.push('edit:end')
    }, { barrier: true })

    const readJob = scheduler.enqueue(async () => {
      events.push('read:start')
    })

    await tick()
    expect(events).toEqual(['edit:start'])

    barrierDone.resolve()
    await Promise.all([editJob, readJob])

    expect(events).toEqual(['edit:start', 'edit:end', 'read:start'])
  })

  it('lets read-only jobs in the same segment run concurrently before a barrier', async () => {
    const scheduler = new ToolExecutionScheduler()
    const read1Done = deferred<void>()
    const read2Done = deferred<void>()
    const events: string[] = []

    const read1 = scheduler.enqueue(async () => {
      events.push('read1:start')
      await read1Done.promise
      events.push('read1:end')
    })
    const read2 = scheduler.enqueue(async () => {
      events.push('read2:start')
      await read2Done.promise
      events.push('read2:end')
    })
    const edit = scheduler.enqueue(async () => {
      events.push('edit:start')
    }, { barrier: true })

    await tick()
    expect(events).toEqual(['read1:start', 'read2:start'])

    read2Done.resolve()
    await tick()
    expect(events).toEqual(['read1:start', 'read2:start', 'read2:end'])

    read1Done.resolve()
    await Promise.all([read1, read2, edit])

    expect(events).toEqual(['read1:start', 'read2:start', 'read2:end', 'read1:end', 'edit:start'])
  })

  it('runs non-barrier jobs after a barrier concurrently', async () => {
    const scheduler = new ToolExecutionScheduler()
    const events: string[] = []

    await scheduler.enqueue(async () => {
      events.push('edit')
    }, { barrier: true })

    await Promise.all([
      scheduler.enqueue(async () => { events.push('read1') }),
      scheduler.enqueue(async () => { events.push('read2') }),
    ])

    expect(events).toEqual(['edit', 'read1', 'read2'])
  })
})
