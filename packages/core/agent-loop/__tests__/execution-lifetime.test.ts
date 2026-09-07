import { describe, expect, it, vi } from 'vitest'
import { createAgentExecutionLifetime } from '../execution-lifetime.js'
import { runAgentLoop } from '../runner.js'
import { AgentExecutionCheckpointError } from '../errors.js'
import type { AgentLoopOptions, AgentProvider, AgentTurnStreamEvent } from '../types.js'

function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
function options(provider: AgentProvider, abort: AbortController): AgentLoopOptions {
  return { sessionId: 's', messageId: 'm', provider, model: 'test', messages: [{ role: 'user', content: 'work' }], maxTurns: 1, abortSignal: abort.signal }
}
const capabilities: AgentProvider['capabilities'] = {
  capabilities: ['text-input', 'text-output'], inputModalities: ['text'], outputModalities: ['text'],
}

describe('actual agent execution lifetime behind abort races', () => {
  it('retains an uncooperative runTurn after the caller observes cancellation', async () => {
    const started = barrier()
    const release = barrier()
    const abort = new AbortController()
    const executionLifetime = createAgentExecutionLifetime()
    let finished = false
    const runTurn = vi.fn(async () => {
      started.resolve()
      await release.promise
      finished = true
      return { message: { role: 'assistant' as const, content: 'late' }, finishReason: 'stop' as const }
    })
    const run = runAgentLoop({ ...options({ id: 'test', capabilities, runTurn }, abort), executionLifetime })
    const cancelled = expect(run).rejects.toMatchObject({ name: 'AbortError' })
    await started.promise
    abort.abort()
    await cancelled
    let drained = false
    const draining = executionLifetime.drain().then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    release.resolve()
    await draining
    expect(finished).toBe(true)
    expect(runTurn).toHaveBeenCalledTimes(1)
  })

  it('owns pending iterator.next and iterator.return independently', async () => {
    const nextStarted = barrier()
    const returnStarted = barrier()
    const nextRelease = barrier()
    const returnRelease = barrier()
    const abort = new AbortController()
    const executionLifetime = createAgentExecutionLifetime()
    const iterator: AsyncIterableIterator<AgentTurnStreamEvent> = {
      [Symbol.asyncIterator]() { return this },
      async next() { nextStarted.resolve(); await nextRelease.promise; return { done: true, value: undefined } },
      async return() { returnStarted.resolve(); await returnRelease.promise; return { done: true, value: undefined } },
    }
    const run = runAgentLoop({ ...options({ id: 'test', capabilities, streamTurn: () => iterator }, abort), executionLifetime })
    const cancelled = expect(run).rejects.toMatchObject({ name: 'AbortError' })
    await nextStarted.promise
    abort.abort()
    await cancelled
    await returnStarted.promise
    let drained = false
    const draining = executionLifetime.drain().then(() => { drained = true })
    nextRelease.resolve()
    await Promise.resolve()
    expect(drained).toBe(false)
    returnRelease.resolve()
    await draining
    expect(drained).toBe(true)
  })

  it('surfaces a late checkpoint failure to the draining owner', async () => {
    const started = barrier()
    const release = barrier()
    const abort = new AbortController()
    const executionLifetime = createAgentExecutionLifetime()
    const failure = new AgentExecutionCheckpointError('late result', new Error('EIO'))
    const run = runAgentLoop({ ...options({ id: 'test', capabilities, runTurn: async () => {
      started.resolve()
      await release.promise
      throw failure
    } }, abort), executionLifetime })
    const cancelled = expect(run).rejects.toMatchObject({ name: 'AbortError' })
    await started.promise
    abort.abort()
    await cancelled
    release.resolve()
    await expect(executionLifetime.drain()).rejects.toBe(failure)
  })
})
