import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  CorePluginBootstrapper,
  CorePluginManager,
  createBuiltinPluginDefinitions,
  ensureCorePluginsDir,
  executeCorePluginTool,
  getCorePluginSettingsPath,
  getCorePluginStorePath,
  getCorePluginsDir,
  getPluginEnabledWithAdapters,
  readPluginSettingsFile,
  writePluginSettingsFile,
  loadCorePluginEntry,
  scanCorePlugins,
  setPluginEnabledWithAdapters,
  type CorePluginToolContext,
  type CorePluginToolResult,
  type CorePluginManagerHost,
  type CorePluginLoaderLogger,
  type CorePluginStateLike,
} from '@onething/core/plugins'
import type { CorePluginDefinition } from '@onething/core/plugins'
import type { PluginSettings } from '@onething/core/plugins'

interface TestAPI {
  registerCommand(name: string): void
}

type TestEntry = (api: TestAPI) => void | Promise<void>
type TestDefinition = CorePluginDefinition<TestEntry>
interface TestCommand {
  name: string
}
interface TestState extends CorePluginStateLike<TestCommand> {
  disposed: boolean
}

function createTestLogger(): CorePluginLoaderLogger & { messages: string[] } {
  const messages: string[] = []
  return {
    messages,
    log: (...args: unknown[]) => messages.push(args.map(String).join(' ')),
    warn: (...args: unknown[]) => messages.push(args.map(String).join(' ')),
    error: (...args: unknown[]) => messages.push(args.map(String).join(' ')),
  }
}

describe('CorePluginManager', () => {
  it('creates built-in plugin definitions in core', () => {
    const entry: TestEntry = () => {}
    expect(createBuiltinPluginDefinitions<TestEntry>([{
      id: 'demo',
      manifest: { name: 'Demo', version: '1.0.0' },
      entry,
      enabled: true,
    }])).toEqual([{
      id: 'demo',
      source: 'builtin',
      manifest: { name: 'Demo', version: '1.0.0' },
      dirPath: 'builtin://demo',
      entryPath: 'builtin://demo/plugin-entry.js',
      entry,
      enabled: true,
    }])
  })

  it('plans plugin store paths and creates the plugin directory in core', () => {
    const homeDir = path.join(os.tmpdir(), 'core-plugin-loader-home')
    const pluginsDir = getCorePluginsDir({ homeDir })
    const messages: string[] = []

    try {
      fs.rmSync(homeDir, { recursive: true, force: true })
      expect(getCorePluginStorePath({ homeDir })).toBe(path.join(homeDir, '.headless-core'))
      expect(pluginsDir).toBe(path.join(homeDir, '.headless-core', 'plugins'))
      expect(getCorePluginSettingsPath({ homeDir })).toBe(path.join(homeDir, '.headless-core', 'plugin-settings.json'))

      ensureCorePluginsDir(pluginsDir, {
        log: message => messages.push(String(message)),
      })

      expect(fs.statSync(pluginsDir).isDirectory()).toBe(true)
      expect(messages).toEqual([`[PluginLoader] Created plugins directory: ${pluginsDir}`])
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true })
    }
  })

  it('scans built-in and user plugin definitions through core loader rules', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-plugin-scan-'))
    const pluginsDir = path.join(root, 'plugins')
    const userPluginDir = path.join(pluginsDir, 'user-plugin')
    const duplicateDir = path.join(pluginsDir, 'builtin-plugin')

    try {
      fs.mkdirSync(userPluginDir, { recursive: true })
      fs.writeFileSync(
        path.join(userPluginDir, 'plugin.json'),
        JSON.stringify({ name: 'User Plugin', version: '1.2.3', entry: 'entry.js' }),
        'utf-8',
      )
      fs.writeFileSync(path.join(userPluginDir, 'entry.js'), 'export default function plugin() {}', 'utf-8')
      fs.mkdirSync(duplicateDir, { recursive: true })
      fs.writeFileSync(path.join(duplicateDir, 'plugin-entry.js'), 'export default function duplicate() {}', 'utf-8')

      const builtin = createBuiltinPluginDefinitions<TestEntry>([{
        id: 'builtin-plugin',
        manifest: { name: 'Builtin', version: '1.0.0' },
        entry: () => {},
        enabled: true,
      }])
      const scanned = scanCorePlugins<TestEntry>({
        builtinPlugins: builtin,
        pluginsDir,
        getEnabled: id => id !== 'user-plugin-disabled',
      })

      expect(scanned.map(plugin => plugin.id)).toEqual(['builtin-plugin', 'user-plugin'])
      expect(scanned[1]).toMatchObject({
        source: 'user',
        manifest: { name: 'User Plugin', version: '1.2.3', entry: 'entry.js' },
        entryPath: path.join(userPluginDir, 'entry.js'),
        enabled: true,
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('executes plugin tools through a core host adapter', async () => {
    const metadataUpdates: Array<{ title?: string; metadata?: Partial<{ count: number }> }> = []
    const tool = {
      name: 'demo',
      description: 'Demo tool',
      parameters: {},
      async execute(
        args: { value: string },
        ctx: CorePluginToolContext<{ count: number }>,
      ): Promise<CorePluginToolResult<{ count: number }>> {
        expect(ctx.sessionId).toBe('session-1')
        expect(ctx.messageId).toBe('message-1')
        expect(ctx.toolCallId).toBe('')
        expect(ctx.workingDirectory).toBe('/repo')
        ctx.metadata({ title: 'Running demo', metadata: { count: args.value.length } })
        return {
          title: 'Done',
          output: `value=${args.value}`,
          metadata: { count: args.value.length },
        }
      },
    }

    await expect(executeCorePluginTool(tool, { value: 'abc' }, {
      sessionId: 'session-1',
      messageId: 'message-1',
      workingDirectory: '/repo',
      metadata: update => metadataUpdates.push(update),
    })).resolves.toEqual({
      title: 'Done',
      output: 'value=abc',
      metadata: { count: 3 },
    })
    expect(metadataUpdates).toEqual([
      { title: 'Running demo', metadata: { count: 3 } },
    ])
  })

  it('loads, disables, enables, and exposes plugin commands', async () => {
    const enabled: Record<string, boolean> = {}
    const stateByPlugin = new Map<string, TestState>()
    const definitions: TestDefinition[] = [{
      id: 'demo',
      manifest: { name: 'Demo', version: '1.0.0' },
      dirPath: '/plugins/demo',
      entryPath: '/plugins/demo/plugin-entry.ts',
      enabled: true,
      entry(api) {
        api.registerCommand('/demo')
      },
    }]

    const host: CorePluginManagerHost<TestDefinition, TestEntry, TestAPI, TestState, TestCommand, { ready: boolean }> = {
      ensurePluginDirs() {},
      scanPlugins: () => definitions,
      loadPluginEntry: async definition => definition.entry ?? null,
      createPluginAPI(pluginId) {
        const state: TestState = { commands: new Map(), disposed: false }
        stateByPlugin.set(pluginId, state)
        return {
          state,
          api: {
            registerCommand(name) {
              state.commands.set(name, { name })
            },
          },
        }
      },
      disposePlugin(state) {
        state.disposed = true
      },
      setPluginEnabled(pluginId, value) {
        enabled[pluginId] = value
      },
    }

    const manager = new CorePluginManager<TestAPI, TestEntry, TestCommand, TestState, TestDefinition, { ready: boolean }>(host)
    await manager.initialize({ ready: true })

    expect(manager.getPlugins()[0]).toMatchObject({ loaded: true, commands: ['/demo'] })
    expect(manager.getCommandHandler('/demo')).toEqual({ name: '/demo' })

    await manager.disablePlugin('demo')
    expect(enabled.demo).toBe(false)
    expect(manager.getPlugins()[0]).toMatchObject({ loaded: false, commands: [] })

    await manager.enablePlugin('demo')
    expect(enabled.demo).toBe(true)
    expect(manager.getCommandHandler('/demo')).toEqual({ name: '/demo' })
  })

  it('bootstraps plugin managers idempotently in core', async () => {
    const calls: string[] = []
    let created = 0
    const bootstrapper = new CorePluginBootstrapper<{
      id: number
      initialized?: boolean
    }, { eventBus: string }>({
      ensurePluginDirs: () => calls.push('ensure'),
      createManager: () => {
        created += 1
        return { id: created }
      },
      initializeManager: async (manager, context) => {
        manager.initialized = true
        calls.push(`initialize:${manager.id}:${context.eventBus}`)
      },
    })

    expect(bootstrapper.getManager()).toBeNull()
    const first = await bootstrapper.bootstrap({ eventBus: 'bus-1' })
    const second = await bootstrapper.bootstrap({ eventBus: 'bus-2' })

    expect(first).toBe(second)
    expect(first).toEqual({ id: 1, initialized: true })
    expect(bootstrapper.getManager()).toBe(first)
    expect(bootstrapper.isBootstrapped()).toBe(true)
    expect(calls).toEqual(['ensure', 'initialize:1:bus-1'])

    bootstrapper.resetForTests()
    expect(bootstrapper.getManager()).toBeNull()
    expect(bootstrapper.isBootstrapped()).toBe(false)
  })

  it('keeps the plugin manager instance when bootstrap initialization fails', async () => {
    const errors: unknown[][] = []
    const bootstrapper = new CorePluginBootstrapper<{ id: string }, { ready: boolean }>({
      createManager: () => ({ id: 'manager' }),
      initializeManager: async () => {
        throw new Error('init failed')
      },
      logger: {
        error: (...args: unknown[]) => errors.push(args),
      },
    })

    const manager = await bootstrapper.bootstrap({ ready: false })
    expect(manager).toEqual({ id: 'manager' })
    expect(bootstrapper.getManager()).toBe(manager)
    expect(errors[0]?.[0]).toBe('[PluginManager] Bootstrap failed:')
    expect(await bootstrapper.bootstrap({ ready: true })).toBe(manager)
  })

  /**
   * plugin-settings 现在装着用户手工配的插件配置(R3),半截 JSON 的代价从
   * "启停位丢了"升级成"用户配置全没了"。
   */
  it('writes plugin settings atomically and quarantines an unreadable file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-settings-safety-'))
    const settingsPath = path.join(root, 'plugin-settings.json')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      writePluginSettingsFile(settingsPath, {
        enabled: { demo: true },
        config: { demo: { label: 'precious' } },
      })
      expect(readPluginSettingsFile(settingsPath)).toEqual({
        enabled: { demo: true },
        config: { demo: { label: 'precious' } },
      })
      // 原子写:落地后目录里不该留下 .tmp 孤儿。
      expect(fs.readdirSync(root).filter(name => name.endsWith('.tmp'))).toEqual([])

      // 半截 JSON:读要把它挪走,而不是返回 {} 让下一次写入以空为基底整份重写。
      fs.writeFileSync(settingsPath, '{"enabled": {"demo": tru', 'utf-8')
      expect(readPluginSettingsFile(settingsPath)).toEqual({})
      expect(fs.existsSync(settingsPath)).toBe(false)
      const quarantined = fs.readdirSync(root).filter(name => name.includes('.corrupt-'))
      expect(quarantined).toHaveLength(1)
      expect(fs.readFileSync(path.join(root, quarantined[0]), 'utf-8')).toContain('tru')

      // 顶层不是对象的也算坏文件(否则 settings.enabled 之类会在别处炸)。
      fs.writeFileSync(settingsPath, '[]', 'utf-8')
      expect(readPluginSettingsFile(settingsPath)).toEqual({})
      expect(fs.readdirSync(root).filter(name => name.includes('.corrupt-')).length).toBeGreaterThanOrEqual(1)
    } finally {
      error.mockRestore()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('reads and writes plugin enabled settings through core adapters', () => {
    let settings: PluginSettings = {
      enabled: {
        demo: false,
        kept: true,
      },
    }
    const writes: PluginSettings[] = []

    expect(getPluginEnabledWithAdapters('demo', true, {
      readSettings: () => settings,
    })).toBe(false)
    expect(getPluginEnabledWithAdapters('missing', true, {
      readSettings: () => settings,
    })).toBe(true)

    const next = setPluginEnabledWithAdapters('demo', true, {
      readSettings: () => settings,
      writeSettings: value => {
        settings = value
        writes.push(value)
      },
    })

    expect(next).toEqual({
      enabled: {
        demo: true,
        kept: true,
      },
    })
    expect(writes).toEqual([next])
  })

  it('loads plugin entries through core loader adapters', async () => {
    const logger = createTestLogger()
    const entry: TestEntry = () => {}
    const builtin: TestDefinition = {
      id: 'builtin',
      manifest: { name: 'Builtin', version: '1.0.0' },
      dirPath: 'builtin://builtin',
      entryPath: 'builtin://builtin/plugin-entry.js',
      enabled: true,
      entry,
    }

    await expect(loadCorePluginEntry(builtin, {
      importEntry: async () => {
        throw new Error('should not import built-in entry')
      },
      logger,
    })).resolves.toBe(entry)

    const user: TestDefinition = {
      id: 'demo',
      manifest: { name: 'Demo', version: '1.0.0' },
      dirPath: '/plugins/demo',
      entryPath: '/plugins/demo/plugin-entry.js',
      enabled: true,
    }
    const importedEntry: TestEntry = () => {}

    await expect(loadCorePluginEntry(user, {
      importEntry: async entryPath => {
        expect(entryPath).toBe('/plugins/demo/plugin-entry.js')
        return { default: importedEntry }
      },
      logger,
    })).resolves.toBe(importedEntry)

    await expect(loadCorePluginEntry({
      ...user,
      id: 'invalid',
    }, {
      importEntry: async () => ({ default: { not: 'a function' } }),
      logger,
    })).resolves.toBeNull()
  })
})
