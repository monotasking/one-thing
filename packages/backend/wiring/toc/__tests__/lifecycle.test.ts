import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentProvider } from '@onething/core/agent-loop'
import type { OnethingBackend } from '../../../backend.js'

function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

const provider = vi.hoisted(() => ({ runTurn: vi.fn<NonNullable<AgentProvider['runTurn']>>() }))
vi.mock('../../providers/utility-provider.js', () => ({
  createUtilityProvider: async () => ({
    providerId: 'test', model: 'toc-test', provider: {
      id: 'test', runTurn: provider.runTurn,
      capabilities: { capabilities: ['text-input', 'text-output'], inputModalities: ['text'], outputModalities: ['text'] },
    },
  }),
}))

let assembly: Promise<OnethingBackend> | undefined
let storeDir: string
let release = barrier()
beforeEach(() => {
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toc-lifecycle-'))
  vi.stubEnv('ONETHING_STORE_PATH', storeDir)
  release = barrier()
  assembly = undefined
  provider.runTurn.mockReset()
})

async function assembleBackend(): Promise<OnethingBackend> {
  const { createOnethingBackend } = await import('../../../backend.js')
  return createOnethingBackend({
    toolRegistry: 'headless',
    host: {
      storePath: {}, sandbox: {}, auth: null, logging: null, shell: null,
      voice: null, terminal: null, skillsEnvironment: null, todoPlan: null,
      scratchpad: null, plugins: null, gateway: null, settings: null,
      evals: null, mcp: null, localTrust: null, speechOutput: null,
    },
  })
}
afterEach(async () => {
  release.resolve()
  try {
    // A timed-out test must still own an assembly that finishes later.
    const result = assembly ? await Promise.allSettled([assembly]) : []
    if (result[0]?.status === 'fulfilled') await result[0].value.dispose()
  } finally {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    fs.rmSync(storeDir, { recursive: true, force: true })
  }
}, 60_000)

async function arm(backend: OnethingBackend) {
  const stores = await import('../../../stores/sessions.js')
  const { triggerManager } = await import('../../engine/triggers/index.js')
  const session = stores.createSession('s', 'TOC lifetime')
  backend.sessionLayer.commands.appendMessage('s', { message: {
    id: 'a1', role: 'assistant', content: 'Updated the parser and its callers', timestamp: 1000,
  } })
  const schedule = globalThis.setTimeout
  const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: Parameters<typeof setTimeout>[0], delay?: number, ...args: unknown[]) =>
    schedule(handler, delay === 45_000 ? 0 : delay, ...args)) as typeof setTimeout)
  try {
    await triggerManager.getTriggers().find(trigger => trigger.id === 'session-toc')!.execute({
      sessionId: 's', session, messages: [], lastUserMessage: 'Please rework the parser and its callers',
      lastAssistantMessage: 'Updated the parser and its callers', toolIterations: 2,
      providerId: 'test', providerConfig: { model: 'test', selectedModels: ['test'] }, settings: (await import('../../../stores/settings.js')).getSettings(),
    })
  } finally { timer.mockRestore() }
}

describe('TOC work in the actual Backend lifetime', () => {
  it.each(['shutdown', 'delete'] as const)('retains ownership until an in-flight provider settles during %s', { timeout: 60_000 }, async operation => {
    // Cold boot is part of this integration test, not a short setup hook.
    assembly = assembleBackend()
    const backend = await assembly
    const entered = barrier()
    let signal: AbortSignal | undefined
    provider.runTurn.mockImplementation(async request => {
      signal = request.abortSignal
      entered.resolve()
      await release.promise // Deliberately ignores cancellation until the remote reply arrives.
      return { message: { role: 'assistant', content: '{"action":"new","kind":"task","title":"Parser","detail":"Updated"}' }, finishReason: 'stop' }
    })
    await arm(backend)
    await entered.promise
    const pending = operation === 'shutdown'
      ? backend.requestShutdown('TOC lifetime test')
      : backend.sessionLayer.deletion.delete('s', ['s'], () => {})
    let settled = false
    const observed = pending.then(() => { settled = true })
    await vi.waitFor(() => expect(signal?.aborted).toBe(true))
    expect(settled).toBe(false)
    // This host takes no store mutex (2026-08-24 ruling): "still owns it" is
    // read off the Backend's own resource ledger, not off a lock directory.
    expect(backend.ownedLabels().length).toBeGreaterThan(0)
    expect(fs.existsSync(path.join(storeDir, 'sessions', 's'))).toBe(true)
    release.resolve()
    await observed
    expect(provider.runTurn).toHaveBeenCalledTimes(1)
    expect(fs.existsSync(path.join(storeDir, 'sessions', 's', 'segments.jsonl'))).toBe(false)
    if (operation === 'delete') expect(fs.existsSync(path.join(storeDir, 'sessions', 's'))).toBe(false)
    else expect(backend.ownedLabels()).toEqual([])
  })
})
