import { describe, expect, it, vi } from 'vitest'
import { createSessionDeletion, SessionClosingError } from '../deletion.js'

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture() {
  const abortAndDrain = vi.fn(async (_id: string) => {})
  const flush = vi.fn(async (_id: string) => {})
  const remove = vi.fn(async (_id: string, ids: readonly string[]) => ({ deletedIds: [...ids] }))
  const targets = vi.fn((_id: string): readonly string[] => ['parent', 'child'])
  const layer = createSessionDeletion({ targets, abortAndDrain, flush, remove })
  return { layer, targets, abortAndDrain, flush, remove }
}

describe('session deletion lifetime', () => {
  it('authorizes the complete target set before any cancellation or mutation', () => {
    const f = fixture()
    const denied = new Error('not found')
    expect(() => f.layer.delete('parent', ['parent', 'child'], () => { throw denied })).toThrow(denied)
    expect(f.abortAndDrain).not.toHaveBeenCalled()
    expect(f.flush).not.toHaveBeenCalled()
    expect(f.remove).not.toHaveBeenCalled()
    expect(() => f.layer.assertAccepting('parent')).not.toThrow()
  })

  it('waits for execution and persistence, then seals writes until explicit recreation', async () => {
    const f = fixture()
    const run = deferred()
    const saved = deferred()
    const enteredFlush = deferred()
    f.abortAndDrain.mockImplementation(id => id === 'child' ? run.promise : Promise.resolve())
    f.flush.mockImplementation(() => { enteredFlush.resolve(); return saved.promise })
    const closing = f.layer.delete('parent', ['parent', 'child'], () => {})
    expect(() => f.layer.assertAccepting('child')).toThrow(SessionClosingError)
    expect(() => f.layer.assertWritable('child')).not.toThrow()
    expect(f.remove).not.toHaveBeenCalled()
    run.resolve()
    await enteredFlush.promise
    expect(f.remove).not.toHaveBeenCalled()
    f.remove.mockImplementation(async (_id, ids) => {
      expect(() => f.layer.assertWritable('child')).toThrow(SessionClosingError)
      return { deletedIds: [...ids] }
    })
    saved.resolve()
    await expect(closing).resolves.toEqual({ deletedIds: ['parent', 'child'] })
    expect(() => f.layer.assertWritable('child')).toThrow(SessionClosingError)
    f.layer.reopen('child')
    expect(() => f.layer.assertAccepting('child')).not.toThrow()
  })

  it('waits for every cancelled execution even when one fails; keeps the data', async () => {
    const f = fixture()
    const other = deferred()
    const failure = new Error('run cleanup failed')
    f.abortAndDrain.mockImplementation(id => id === 'parent' ? Promise.reject(failure) : other.promise)
    const closing = f.layer.delete('parent', ['parent', 'child'], () => {})
    const result = closing.then(() => 'success', error => error)
    let settled = false
    void result.then(() => { settled = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    other.resolve()
    expect((await result as AggregateError).errors).toContain(failure)
    expect(f.flush).not.toHaveBeenCalled()
    expect(f.remove).not.toHaveBeenCalled()
    expect(() => f.layer.reopen('parent')).toThrow(SessionClosingError)
  })

  it('does not delete after a failed checkpoint', async () => {
    const f = fixture()
    f.flush.mockRejectedValue(new Error('disk full'))
    await expect(f.layer.delete('parent', ['parent', 'child'], () => {})).rejects.toThrow('persistence drain')
    expect(f.remove).not.toHaveBeenCalled()
  })

  it('rejects a cascade that expands during asynchronous preparation', async () => {
    const f = fixture()
    const run = deferred()
    f.abortAndDrain.mockReturnValue(run.promise)
    const result = f.layer.delete('parent', ['parent', 'child'], () => {})
    f.targets.mockReturnValue(['parent', 'child', 'new-child'])
    run.resolve()
    await expect(result).rejects.toThrow('targets changed')
    expect(f.remove).not.toHaveBeenCalled()
  })

  it('rechecks authorization after the drain and before destruction', async () => {
    const f = fixture()
    const authorize = vi.fn().mockImplementationOnce(() => {}).mockImplementation(() => { throw new Error('owner changed') })
    await expect(f.layer.delete('parent', ['parent', 'child'], authorize)).rejects.toThrow('owner changed')
    expect(f.remove).not.toHaveBeenCalled()
  })

  it('shares duplicate work but rejects an overlapping deletion before cancelling it', async () => {
    const f = fixture()
    const waiting = deferred()
    f.abortAndDrain.mockReturnValue(waiting.promise)
    const first = f.layer.delete('parent', ['parent', 'child'], () => {})
    expect(f.layer.delete('parent', ['child', 'parent'], () => {})).toBe(first)
    f.targets.mockImplementation(id => id === 'child' ? ['child'] : ['parent', 'child'])
    expect(() => f.layer.delete('child', ['child'], () => {})).toThrow(SessionClosingError)
    waiting.resolve()
    await first
    expect(f.remove).toHaveBeenCalledTimes(1)
  })

  it('preserves physical deletion errors and exposes them to Backend shutdown', async () => {
    const f = fixture()
    const failure = new Error('unlink failed')
    f.remove.mockRejectedValue(failure)
    await expect(f.layer.delete('parent', ['parent', 'child'], () => {})).rejects.toBe(failure)
    await expect(f.layer.drain()).rejects.toThrow('pending deletions')
    expect(() => f.layer.assertWritable('parent')).toThrow(SessionClosingError)
  })
})
