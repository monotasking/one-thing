import { describe, expect, it, vi } from 'vitest'
import type { CorePluginCommandContext } from '../plugin-api-types.js'
import {
  disableOnethingPluginForIpc,
  enableOnethingPluginForIpc,
  executeOnethingPluginCommandForIpc,
  listOnethingPluginCommandsForIpc,
  listOnethingPluginsForIpc,
  ONETHING_PLUGIN_SYSTEM_NOT_INITIALIZED,
  refreshOnethingPluginsForIpc,
} from '../plugin-ipc-operations.js'

function createManager() {
  const handler = vi.fn(async (_args: string, ctx: CorePluginCommandContext) => {
    ctx.notify('done')
  })

  return {
    getPlugins: vi.fn(() => [{
      definition: {
        id: 'demo',
        source: 'builtin',
        manifest: {
          name: 'Demo',
          version: '1.0.0',
          description: 'Demo plugin',
          author: 'onething',
        },
        enabled: true,
        dirPath: 'builtin://demo',
      },
      loaded: true,
      commands: ['/demo'],
    }]),
    enablePlugin: vi.fn(async () => undefined),
    disablePlugin: vi.fn(async () => undefined),
    refreshPlugins: vi.fn(async () => undefined),
    getPluginCommands: vi.fn(() => new Map([
      ['/demo', { name: '/demo', description: 'Run demo', usage: '/demo arg' }],
    ])),
    getCommandHandler: vi.fn(() => ({ name: '/demo', handler })),
    handler,
  }
}

describe('plugin IPC operations', () => {
  it('lists plugins and commands with renderer-safe projections', async () => {
    const manager = createManager()

    await expect(listOnethingPluginsForIpc({ manager })).resolves.toEqual({
      success: true,
      plugins: [{
        id: 'demo',
        source: 'builtin',
        name: 'Demo',
        version: '1.0.0',
        description: 'Demo plugin',
        author: 'onething',
        loaded: true,
        enabled: true,
        commands: ['/demo'],
        error: '',
        dirPath: 'builtin://demo',
        contributes: {
          commands: [],
          panels: [],
          hasSettingsSchema: false,
          uiSlots: [],
          theme: [],
          skin: [],
          background: null,
          ambient: null,
          permissions: [],
          activationEvents: [],
        },
        requestActions: [],
        configFields: [],
        configTitle: '',
        configValues: {},
        configUnsupportedReasons: [],
        configValuesAreDefaults: false,
        configEditable: false,
        minAppVersion: '',
        healthStatus: 'healthy',
        healthFailures: 0,
        healthReason: '',
        degradedSurfaces: [],
      }],
      // G 期:胜出背景搭清单响应这班车 —— 没插件声明背景时是 null。
      background: null,
      // G2:胜出氛围层同样搭这班车 —— 没插件声明氛围时是 null。
      ambient: null,
    })

    await expect(listOnethingPluginCommandsForIpc({ manager })).resolves.toEqual({
      success: true,
      commands: [{
        id: 'demo',
        name: '/demo',
        description: 'Run demo',
        usage: '/demo arg',
      }],
    })
  })

  it('routes plugin enablement mutations through the manager adapter', async () => {
    const manager = createManager()

    await expect(enableOnethingPluginForIpc({
      manager,
      pluginId: 'demo',
    })).resolves.toEqual({ success: true })
    await expect(disableOnethingPluginForIpc({
      manager,
      pluginId: 'demo',
    })).resolves.toEqual({ success: true })
    await expect(refreshOnethingPluginsForIpc({ manager })).resolves.toEqual({ success: true })

    expect(manager.enablePlugin).toHaveBeenCalledWith('demo')
    expect(manager.disablePlugin).toHaveBeenCalledWith('demo')
    expect(manager.refreshPlugins).toHaveBeenCalled()
  })

  it('normalizes missing plugin manager responses', async () => {
    await expect(listOnethingPluginsForIpc({ manager: null })).resolves.toEqual({
      success: false,
      error: ONETHING_PLUGIN_SYSTEM_NOT_INITIALIZED,
    })
  })

  it('executes plugin commands through manager and host adapters', async () => {
    const manager = createManager()
    const globalEvents: unknown[] = []

    await expect(executeOnethingPluginCommandForIpc({
      manager,
      commandName: 'demo',
      sessionId: 's1',
      getSession: vi.fn(() => ({ workingDirectory: '/repo' })),
      emitSessionCommand: vi.fn(),
      emitGlobalEvent: vi.fn(event => {
        globalEvents.push(event)
      }),
      exec: vi.fn(),
    })).resolves.toEqual({
      success: true,
      message: 'done',
    })

    expect(manager.getCommandHandler).toHaveBeenCalledWith('/demo')
    expect(manager.handler).toHaveBeenCalledWith('', expect.objectContaining({
      sessionId: 's1',
      cwd: '/repo',
    }))
    expect(globalEvents).toEqual([{
      type: 'plugin:notification',
      pluginId: 'command',
      message: 'done',
      level: 'info',
    }])
  })
})
