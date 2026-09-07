import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CorePluginCredentialStrategyContext } from '@onething/core/plugins'
import type { OnethingBackend } from '../backend.js'

let directory: string
let backend: OnethingBackend | undefined
let previous: string | undefined
const releases: Array<() => void> = []
const policy = 'plugin:credential-probe:balance'
const candidates = [
  { id: 'a', label: 'A', authType: 'apiKey' as const, apiKey: 'test-a', source: 'user' },
  { id: 'b', label: 'B', authType: 'apiKey' as const, apiKey: 'test-b', source: 'user' },
]
const input = { policy, spaceId: 'work', providerId: 'openai', candidates }

function barrier<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

function observeDrain(scope: { drain(): Promise<void> }) {
  const entered = barrier<void>()
  const drain = scope.drain.bind(scope)
  let settled = false
  vi.spyOn(scope, 'drain').mockImplementation(() => {
    const actual = drain()
    entered.resolve()
    void actual.then(() => { settled = true }, () => { settled = true })
    return actual
  })
  return { entered: entered.promise, isSettled: () => settled }
}

beforeEach(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'backend-credential-owner-')))
  previous = process.env.ONETHING_STORE_PATH
  process.env.ONETHING_STORE_PATH = path.join(directory, 'a')
  vi.resetModules()
})

afterEach(async () => {
  releases.splice(0).forEach(release => release())
  await backend?.dispose()
  backend = undefined
  vi.restoreAllMocks()
  if (previous === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previous
  await fs.rm(directory, { recursive: true, force: true })
})

async function assemble(name: string) {
  const { createOnethingBackend } = await import('../backend.js')
  backend = await createOnethingBackend({ storePath: path.join(directory, name), owner: 'daemon', toolRegistry: 'headless', host: {
    storePath: {}, sandbox: {}, auth: null, logging: null, shell: null, voice: null,
    terminal: null, skillsEnvironment: null, todoPlan: null, scratchpad: null, plugins: null,
    gateway: null, settings: null, evals: null, mcp: null, localTrust: null,
  } })
  return backend
}

async function seedUsage(tokens: number) {
  const { getUsageLedger } = await import('../wiring/usage/index.js')
  const ledger = getUsageLedger()
  ledger.record({
    workspaceId: 'work', credentialId: 'a', providerId: 'openai', modelId: 'test-model',
    platform: 'api', source: 'credential-lifecycle', billing: 'api', usage: { input: tokens, output: 0 },
  })
  await ledger.flush()
  return ledger
}

async function bindings() {
  const registry = await import('../wiring/providers/credential-strategy.js')
  const credentials = await import('@onething/runtime/spaces/credentials')
  const health = await import('@onething/runtime/plugins/health')
  const { inspectStoreLock } = await import('@onething/runtime/storage/store-lock')
  registry.configureAppPluginCredentialStrategyHost()
  const choose = () => credentials.selectSpaceCredentialEntryDetailed(
    { entries: candidates, policy }, { spaceId: input.spaceId, providerId: input.providerId },
  )
  return { registry, health, inspectStoreLock, choose }
}

it('retains the lease while a detached decision reads the actual usage file and skips select after shutdown', { timeout: 60000 }, async () => {
  const instance = await assemble('a')
  const ledger = await seedUsage(7)
  const { registry, inspectStoreLock, choose } = await bindings()
  const scope = instance.credentialStrategies.createScope()
  const draining = observeDrain(scope)
  const select = vi.fn(() => 'b')
  registry.registerPluginCredentialStrategy('credential-probe', { name: 'balance', title: 'Balance', select }, scope)
  const [usageFile] = await ledger.listLedgerFiles()
  const entered = barrier<void>()
  const held = barrier<void>()
  releases.push(() => held.resolve())
  const readFile = fs.readFile.bind(fs)
  let readText = ''
  vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
    if (String(args[0]) === usageFile) {
      entered.resolve()
      await held.promise
      const result = await readFile(...args)
      readText = String(result)
      return result
    }
    return readFile(...args)
  })

  // This production synchronous entry returns before the usage read begins.
  expect(choose()).toMatchObject({ entry: { id: 'a' }, pluginPolicy: { applied: false } })
  await entered.promise
  let disposed = false
  const stopping = instance.dispose().then(() => { disposed = true })
  await draining.entered
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(scope.closed).toBe(true)
  expect(disposed).toBe(false)
  expect(draining.isSettled()).toBe(false)
  expect(inspectStoreLock({ storePath: path.join(directory, 'a') }).status).toBe('held')
  process.env.ONETHING_STORE_PATH = path.join(directory, 'unrelated')
  held.resolve()
  await stopping
  expect(select).not.toHaveBeenCalled()
  expect(readText).toContain('"input":7')
  expect(inspectStoreLock({ storePath: path.join(directory, 'a') }).status).toBe('absent')
  await expect(scope.run(select)).rejects.toThrow('closed')
})

it('returns fallback on a real timeout but retains shutdown ownership of a select that ignores abort', { timeout: 60000 }, async () => {
  const instance = await assemble('a')
  const { registry, inspectStoreLock } = await bindings()
  const scope = instance.credentialStrategies.createScope()
  const draining = observeDrain(scope)
  const entered = barrier<void>()
  const held = barrier<string>()
  releases.push(() => held.resolve('a'))
  let signal!: AbortSignal
  registry.registerPluginCredentialStrategy('credential-probe', {
    name: 'balance', title: 'Balance', select: ctx => {
      signal = ctx.signal!
      entered.resolve()
      return held.promise // Deliberately ignore cancellation, as an external plugin can.
    },
  }, scope)
  const response = registry.refreshCredentialStrategyDecision({ ...input, timeoutMs: 15 })
  await entered.promise
  await expect(response).resolves.toBeUndefined()
  expect(signal.aborted).toBe(true)
  let disposed = false
  const stopping = instance.dispose().then(() => { disposed = true })
  await draining.entered
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(disposed).toBe(false)
  expect(draining.isSettled()).toBe(false)
  expect(inspectStoreLock({ storePath: path.join(directory, 'a') }).status).toBe('held')
  held.resolve('b')
  await stopping
  expect(inspectStoreLock({ storePath: path.join(directory, 'a') }).status).toBe('absent')
})

it('reopens the same policy in a different store without old decisions, usage, failure metadata or callbacks', { timeout: 60000 }, async () => {
  const first = await assemble('a')
  const oldLedger = await seedUsage(7)
  const { registry, health, inspectStoreLock, choose } = await bindings()
  const oldScope = first.credentialStrategies.createScope()
  const draining = observeDrain(oldScope)
  const contexts: CorePluginCredentialStrategyContext[] = []
  const entered = barrier<void>()
  const held = barrier<string>()
  releases.push(() => held.resolve('a'))
  const unregister = registry.registerPluginCredentialStrategy('credential-probe', {
    name: 'balance', title: 'Balance', select: ctx => {
      contexts.push(ctx)
      if (contexts.length === 1) return 'b'
      entered.resolve()
      return held.promise
    },
  }, oldScope)
  await expect(registry.refreshCredentialStrategyDecision(input)).resolves.toBe('b')
  expect(contexts[0].entries[0].usage.inputTokens).toBe(7)
  registry.notePluginCredentialFailure('a', 'quota-exhausted')
  expect(choose()).toMatchObject({ entry: { id: 'b' }, pluginPolicy: { applied: true } })
  await entered.promise
  const success = vi.spyOn(health, 'reportPluginRuntimeSuccess')
  const failure = vi.spyOn(health, 'reportPluginRuntimeFailure')
  const stopping = first.dispose()
  await draining.entered
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(draining.isSettled()).toBe(false)
  expect(inspectStoreLock({ storePath: path.join(directory, 'a') }).status).toBe('held')
  held.resolve('not-a-valid-credential')
  await stopping
  expect(failure).not.toHaveBeenCalled()
  expect(success).not.toHaveBeenCalled()

  const second = await assemble('b')
  const newLedger = await seedUsage(2)
  const newScope = second.credentialStrategies.createScope()
  const newContexts: CorePluginCredentialStrategyContext[] = []
  const next = vi.fn((ctx: CorePluginCredentialStrategyContext) => { newContexts.push(ctx); return 'a' })
  registry.registerPluginCredentialStrategy('credential-probe', { name: 'balance', title: 'Balance', select: next }, newScope)
  // The old cached decision chose B; the new installation starts cold.
  expect(choose()).toMatchObject({ entry: { id: 'a' }, pluginPolicy: { applied: false } })
  await registry.flushPluginCredentialStrategyRefreshForTests()
  expect(newContexts[0].entries[0]).toMatchObject({ usage: { inputTokens: 2 } })
  expect(newContexts[0].entries[0].lastErrorKind).toBeUndefined()
  expect(oldLedger.getLedgerDir()).not.toBe(newLedger.getLedgerDir())
  expect(await oldLedger.readRecordsInRange(0, Date.now() + 1000)).toMatchObject([{ usage: { input: 7 } }])
  expect(await newLedger.readRecordsInRange(0, Date.now() + 1000)).toMatchObject([{ usage: { input: 2 } }])
  const healthBefore = structuredClone(health.getPluginRuntimeHealth('credential-probe'))
  unregister()
  await first.dispose()
  const forbidden = vi.fn(() => 'b')
  await expect(oldScope.run(forbidden)).rejects.toThrow('closed')
  expect(forbidden).not.toHaveBeenCalled()
  expect(() => registry.registerPluginCredentialStrategy('credential-probe', { name: 'balance', title: 'Old', select: forbidden }, oldScope)).toThrow('closed')
  expect(health.getPluginRuntimeHealth('credential-probe')).toEqual(healthBefore)
  expect(registry.listPluginCredentialStrategies()).toMatchObject([{ policy, title: 'Balance' }])
  expect(choose()).toMatchObject({ entry: { id: 'a' }, pluginPolicy: { applied: true } })
  await registry.flushPluginCredentialStrategyRefreshForTests()
})
