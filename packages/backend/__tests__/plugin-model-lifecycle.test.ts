import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { OnethingBackend } from '../backend.js'
import type { PluginAPI, PluginEntry, PluginCommandDefinition, PluginDefinition } from '../wiring/plugins/types.js'
import type { PluginState } from '../wiring/plugins/api.js'

const mocks = vi.hoisted(() => ({ generate: vi.fn(), manager: null as { shutdown(): Promise<void> } | null }))
vi.mock('../wiring/providers/index.js', async original => ({
  ...await original<typeof import('../wiring/providers/index.js')>(),
  generateChatResponse: mocks.generate,
}))
vi.mock('../wiring/plugins/manager.js', async original => ({
  ...await original<typeof import('../wiring/plugins/manager.js')>(),
  getPluginManager: () => mocks.manager,
}))

let directory: string
let previous: string | undefined
let backend: OnethingBackend | undefined
const releases: Array<() => void> = []

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'backend-plugin-model-'))
  previous = process.env.ONETHING_STORE_PATH
  process.env.ONETHING_STORE_PATH = path.join(directory, 'a')
  vi.resetModules()
  mocks.generate.mockReset()
  mocks.manager = null
})
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  await mocks.manager?.shutdown()
  await backend?.dispose()
  backend = undefined
  mocks.manager = null
  if (previous === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previous
  await fs.rm(directory, { recursive: true, force: true })
})

async function assemble(name: string) {
  const { createOnethingBackend } = await import('../backend.js')
  const result = await createOnethingBackend({
    storePath: path.join(directory, name),
    owner: 'daemon',
    toolRegistry: 'headless',
    host: {
      storePath: {}, sandbox: {}, auth: null, logging: null, shell: null, voice: null,
      terminal: null, skillsEnvironment: null, todoPlan: null, scratchpad: null, plugins: null,
      gateway: null, settings: null, evals: null, mcp: null, localTrust: null, speechOutput: null,
    },
  })
  backend = result
  const settings = await import('../stores/settings.js')
  const current = settings.getSettings()
  settings.updateSettingsInMemory({
    ...current,
    ai: { ...current.ai, provider: 'openai', providers: { openai: { model: 'gpt-x', apiKey: 'test-key', selectedModels: [] } } },
    tools: { ...current.tools, toolCallModel: undefined },
  })
  return result
}

async function createManager(instance: OnethingBackend, options: { entry?: (api: PluginAPI) => void | Promise<void>; waitForInitialize?: boolean } = {}) {
  const { CorePluginManager } = await import('@onething/core/plugins')
  const apiModule = await import('../wiring/plugins/api.js')
  const instances: PluginAPI[] = []
  const definition: PluginDefinition = {
    id: 'model-probe', manifest: { name: 'model-probe', version: '1.0.0' },
    dirPath: path.join(directory, 'plugins', 'model-probe'), entryPath: 'unused.js', enabled: true,
    entry: api => { instances.push(api); return options.entry?.(api) },
  }
  const manager = new CorePluginManager<PluginAPI, PluginEntry, PluginCommandDefinition, PluginState, PluginDefinition, object>({
    ensurePluginDirs() {}, scanPlugins: () => [definition], loadPluginEntry: async def => def.entry ?? null,
    createPluginAPI: id => apiModule.createPluginAPI(id, instance.eventBus, instance.engine, { declaredPermissions: ['llm:complete'] }),
    disposePlugin: apiModule.disposePlugin, drainPlugin: apiModule.drainPlugin,
    setPluginEnabled() {},
  })
  mocks.manager = manager
  const initialized = manager.initialize({})
  if (options.waitForInitialize !== false) await initialized
  return { manager, instances, initialized }
}

function blockProvider() {
  let finish!: (text: string) => void
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const result = new Promise<string>(resolve => { finish = resolve })
  mocks.generate.mockImplementationOnce(() => { entered(); return result })
  releases.push(() => finish('cleanup'))
  return { started, finish }
}

const request = { messages: [{ role: 'user' as const, content: 'summarize' }] }

it.each(['disable', 'shutdown'] as const)('%s owns a model started by an entry that has not finished loading', { timeout: 60000 }, async action => {
  const instance = await assemble('a')
  const blocked = blockProvider()
  let call!: ReturnType<PluginAPI['llm']['complete']>
  const { manager, instances, initialized } = await createManager(instance, {
    waitForInitialize: false,
    entry(api) { call = api.llm.complete(request); return call.then(() => {}) },
  })
  await blocked.started
  const rejected = expect(call).rejects.toMatchObject({ code: 'unsupported' })
  let closed = false
  const stopping = (action === 'disable' ? manager.disablePlugin('model-probe') : manager.shutdown()).then(() => { closed = true })
  await rejected
  expect(closed).toBe(false)
  await expect(instances[0].llm.complete(request)).rejects.toMatchObject({ code: 'unsupported' })
  blocked.finish('late entry')
  await stopping
  await initialized
  expect(manager.getPlugins().find(info => info.definition.id === 'model-probe')?.loaded ?? false).toBe(false)
})

it('plugin disable waits for the real model and serializes re-enable of the same id', { timeout: 60000 }, async () => {
  const instance = await assemble('a')
  const { manager, instances } = await createManager(instance)
  const old = instances[0]
  const blocked = blockProvider()
  const call = old.llm.complete(request)
  const rejected = expect(call).rejects.toMatchObject({ code: 'unsupported' })
  await blocked.started
  let disabled = false
  const disable = manager.disablePlugin('model-probe').then(() => { disabled = true })
  await rejected
  expect(disabled).toBe(false)
  await expect(old.llm.complete(request)).rejects.toMatchObject({ code: 'unsupported' })
  const enable = manager.enablePlugin('model-probe')
  await Promise.resolve()
  expect(instances).toHaveLength(1)
  blocked.finish('late')
  await disable
  await enable
  expect(instances).toHaveLength(2)
  mocks.generate.mockResolvedValueOnce('new state')
  await expect(instances[1].llm.complete(request)).resolves.toEqual({ text: 'new state' })
  await expect(old.llm.complete(request)).rejects.toMatchObject({ code: 'unsupported' })
})

it('Backend shutdown retains its lease and bills the original store until the real model settles', { timeout: 60000 }, async () => {
  const instance = await assemble('a')
  const { instances } = await createManager(instance)
  const old = instances[0]
  const { getUsageLedger, captureUsageRecorder } = await import('../wiring/usage/index.js')
  const ledger = getUsageLedger()
  const oldRecorder = captureUsageRecorder()
  const blocked = blockProvider()
  const call = old.llm.complete(request)
  const rejected = expect(call).rejects.toMatchObject({ code: 'unsupported' })
  await blocked.started
  const opts = mocks.generate.mock.calls[0][3]
  let disposed = false
  const shuttingDown = instance.dispose().then(() => { disposed = true })
  await rejected
  expect(disposed).toBe(false)
  const { inspectStoreLock } = await import('@onething/runtime/storage/store-lock')
  expect(inspectStoreLock({ storePath: path.join(directory, 'a') }).status).not.toBe('absent')
  await expect(old.llm.complete(request)).rejects.toThrow()
  const { createOnethingBackend } = await import('../backend.js')
  await expect(createOnethingBackend({ ...instance.options, storePath: path.join(directory, 'b') })).rejects.toThrow(/already assembled/i)
  // The provider ignores cancellation and reports its real spend before finishing.
  opts.onUsage({ inputTokens: 7, outputTokens: 2, totalTokens: 9 })
  blocked.finish('late')
  await shuttingDown
  backend = undefined
  expect(inspectStoreLock({ storePath: path.join(directory, 'a') }).status).toBe('absent')
  expect(await ledger.readRecordsInRange(0, Date.now() + 1000)).toMatchObject([{ source: 'plugin:model-probe', usage: { input: 7, output: 2 } }])
  await assemble('b')
  expect(() => oldRecorder({ providerId: 'openai', modelId: 'gpt-x', source: 'plugin:model-probe', usage: { inputTokens: 99, outputTokens: 99 } })).toThrow(/closed/)
  opts.onUsage({ inputTokens: 99, outputTokens: 99, totalTokens: 198 })
  await expect(old.llm.complete(request)).rejects.toMatchObject({ code: 'unsupported' })
  expect(await getUsageLedger().readRecordsInRange(0, Date.now() + 1000)).toEqual([])
})
