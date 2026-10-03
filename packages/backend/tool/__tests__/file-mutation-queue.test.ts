import { afterEach, describe, expect, it } from 'vitest'
import {
  clearFileMutationQueuesForTests,
  getFileMutationQueueSize,
  withFileMutationQueue,
  withFileReadAccess,
} from '../file-mutation-queue.js'

afterEach(() => {
  clearFileMutationQueuesForTests()
})

describe('runtime file-mutation-queue', () => {
  it('serializes operations for the same file', async () => {
    const events: string[] = []
    let releaseFirst!: () => void
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const first = withFileMutationQueue('/tmp/a.txt', async () => {
      events.push('first:start')
      await firstCanFinish
      events.push('first:end')
      return 'first'
    })

    const second = withFileMutationQueue('/tmp/a.txt', async () => {
      events.push('second:start')
      return 'second'
    })

    await Promise.resolve()
    expect(events).toEqual(['first:start'])

    releaseFirst()
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second'])
    expect(events).toEqual(['first:start', 'first:end', 'second:start'])
    expect(getFileMutationQueueSize()).toBe(0)
  })

  it('allows different files to run concurrently', async () => {
    const events: string[] = []
    let releaseFirst!: () => void
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const first = withFileMutationQueue('/tmp/a.txt', async () => {
      events.push('a:start')
      await firstCanFinish
      events.push('a:end')
    })

    const second = withFileMutationQueue('/tmp/b.txt', async () => {
      events.push('b:start')
    })

    await second
    expect(events).toEqual(['a:start', 'b:start'])

    releaseFirst()
    await first
    expect(events).toEqual(['a:start', 'b:start', 'a:end'])
    expect(getFileMutationQueueSize()).toBe(0)
  })

  it('continues after an operation fails', async () => {
    const events: string[] = []

    const first = withFileMutationQueue('/tmp/a.txt', async () => {
      events.push('first:start')
      throw new Error('boom')
    })

    const second = withFileMutationQueue('/tmp/a.txt', async () => {
      events.push('second:start')
      return 'ok'
    })

    await expect(first).rejects.toThrow('boom')
    await expect(second).resolves.toBe('ok')
    expect(events).toEqual(['first:start', 'second:start'])
    expect(getFileMutationQueueSize()).toBe(0)
  })

  it('queues a read behind an in-flight write on the same path', async () => {
    const events: string[] = []
    let fileContent = 'old'
    let releaseWrite!: () => void
    const writeCanFinish = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })

    const write = withFileMutationQueue('/tmp/a.txt', async () => {
      events.push('write:start')
      await writeCanFinish
      fileContent = 'new'
      events.push('write:end')
    })

    const read = withFileReadAccess('/tmp/a.txt', async () => {
      events.push(`read:${fileContent}`)
      return fileContent
    })

    await Promise.resolve()
    expect(events).toEqual(['write:start'])

    releaseWrite()
    await write
    await expect(read).resolves.toBe('new')
    expect(events).toEqual(['write:start', 'write:end', 'read:new'])
    expect(getFileMutationQueueSize()).toBe(0)
  })

  it('makes a later write wait for in-flight reads, while reads overlap freely', async () => {
    const events: string[] = []
    let releaseReads!: () => void
    const readsCanFinish = new Promise<void>((resolve) => {
      releaseReads = resolve
    })

    const readA = withFileReadAccess('/tmp/a.txt', async () => {
      events.push('readA:start')
      await readsCanFinish
      events.push('readA:end')
    })
    const readB = withFileReadAccess('/tmp/a.txt', async () => {
      events.push('readB:start')
      await readsCanFinish
      events.push('readB:end')
    })

    // Both readers overlap before either finishes.
    await Promise.resolve()
    expect(events).toEqual(['readA:start', 'readB:start'])

    const write = withFileMutationQueue('/tmp/a.txt', async () => {
      events.push('write:start')
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(events).not.toContain('write:start')

    releaseReads()
    await Promise.all([readA, readB, write])
    expect(events.indexOf('write:start')).toBeGreaterThan(events.indexOf('readA:end'))
    expect(events.indexOf('write:start')).toBeGreaterThan(events.indexOf('readB:end'))
    expect(getFileMutationQueueSize()).toBe(0)
  })

  it('reads on a different path do not wait for a write', async () => {
    const events: string[] = []
    let releaseWrite!: () => void
    const writeCanFinish = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })

    const write = withFileMutationQueue('/tmp/a.txt', async () => {
      events.push('write:start')
      await writeCanFinish
    })

    await withFileReadAccess('/tmp/b.txt', async () => {
      events.push('read:b')
    })
    expect(events).toEqual(['write:start', 'read:b'])

    releaseWrite()
    await write
    expect(getFileMutationQueueSize()).toBe(0)
  })

  it('keeps write order write→read→write for interleaved arrivals', async () => {
    const events: string[] = []
    let releaseFirstWrite!: () => void
    const firstWriteCanFinish = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve
    })

    const firstWrite = withFileMutationQueue('/tmp/a.txt', async () => {
      events.push('write1')
      await firstWriteCanFinish
    })
    const read = withFileReadAccess('/tmp/a.txt', async () => {
      events.push('read')
    })
    const secondWrite = withFileMutationQueue('/tmp/a.txt', async () => {
      events.push('write2')
    })

    releaseFirstWrite()
    await Promise.all([firstWrite, read, secondWrite])
    expect(events).toEqual(['write1', 'read', 'write2'])
    expect(getFileMutationQueueSize()).toBe(0)
  })
})
