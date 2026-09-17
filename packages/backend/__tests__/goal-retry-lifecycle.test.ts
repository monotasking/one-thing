import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import type { OnethingBackend } from '../backend.js'

it('cancels a real Backend goal retry on shutdown and flushes pending usage before same-id reassembly', { timeout: 60000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'goal-owner-'))
  const previous = process.env.ONETHING_STORE_PATH
  let backend: OnethingBackend | undefined
  let releaseScan: (() => void) | undefined
  try {
    process.env.ONETHING_STORE_PATH = directory
    const { createOnethingBackend } = await import('../backend.js')
    const store = await import('../stores/sessions.js')
    const goals = await import('../wiring/goals/index.js')
    const kick = await import('../wiring/goals/kick.js')
    const kicks = vi.spyOn(kick, 'kickGoalRunIfIdle')
    const assemble = () => createOnethingBackend({ storePath: directory, owner: 'daemon', toolRegistry: 'headless', host: {
      storePath: {}, sandbox: {}, auth: null, logging: null, shell: null, voice: null,
      terminal: null, skillsEnvironment: null, todoPlan: null, scratchpad: null, plugins: null,
      gateway: null, settings: null, evals: null, mcp: null, localTrust: null, speechOutput: null,
    } })
    backend = await assemble()
    store.createSession('session', 'Goal')
    goals.createGoal('session', { objective: 'fixture' })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await backend.eventBus.emit('session', { type: 'stream:error', data: { error: 'ECONNRESET' } } as never)
    expect(goals.getGoal('session')?.errorRetryCount).toBe(1)
    goals.recordGoalUsage('session', { tokens: 37, seconds: 2 })
    await backend.dispose()
    backend = undefined
    await vi.advanceTimersByTimeAsync(45000)
    expect(kicks).not.toHaveBeenCalled()
    vi.useRealTimers()
    backend = await assemble()
    expect(goals.getGoal('session')?.tokensUsed).toBe(37)
    expect(goals.getGoal('session')?.timeUsedSeconds).toBe(2)
    // A fresh run's first usage must not include a previous instance's buffer.
    goals.recordGoalUsage('session', { tokens: 1 })
    goals.flushUsage('session')
    expect(goals.getGoal('session')?.tokensUsed).toBe(38)
    expect(kicks).not.toHaveBeenCalled()
    kicks.mockRestore()

    const auditDir = path.join(directory, 'file-mutations', new Date().toISOString().slice(0, 10))
    await fs.mkdir(auditDir, { recursive: true })
    await fs.writeFile(path.join(auditDir, 'mutation.json'), JSON.stringify({
      sessionId: 'session', timestamp: new Date().toISOString(), filePath: '/fixture/a.ts',
      beforeExists: true, afterExists: true, beforeContent: 'one', afterContent: 'one\ntwo',
    }))
    let entered!: () => void
    const scanEntered = new Promise<void>(resolve => { entered = resolve })
    const holdScan = new Promise<void>(resolve => { releaseScan = resolve })
    const readDirectory = fs.readdir
    const spy = vi.spyOn(fs, 'readdir').mockImplementation(((...args: Parameters<typeof fs.readdir>) => {
      const result = readDirectory(...args)
      if (String(args[0]) !== auditDir) return result
      return result.then(async entries => { entered(); await holdScan; return entries })
    }) as typeof fs.readdir)
    const completed = goals.updateGoalFromModel('session', 'complete')
    await scanEntered
    const stopping = backend.dispose()
    await Promise.resolve()
    const { inspectStoreLock } = await import('@onething/runtime/storage/store-lock')
    expect(inspectStoreLock({ storePath: directory }).status).toBe('held')
    releaseScan!()
    await stopping
    spy.mockRestore()
    backend = await assemble()
    expect(goals.getGoals('session').find(goal => goal.id === completed.id)?.fileChanges).toEqual([
      { path: '/fixture/a.ts', added: 1, removed: 0 },
    ])
  } finally {
    releaseScan?.()
    vi.useRealTimers()
    vi.restoreAllMocks()
    await backend?.dispose()
    if (previous === undefined) delete process.env.ONETHING_STORE_PATH
    else process.env.ONETHING_STORE_PATH = previous
    await fs.rm(directory, { recursive: true, force: true })
  }
})
