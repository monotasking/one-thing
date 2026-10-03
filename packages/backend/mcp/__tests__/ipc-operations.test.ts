import { describe, expect, it, vi } from 'vitest'
import {
  addOnethingMCPServerForIpc,
  callOnethingMCPToolForIpc,
  getOnethingMCPServersForIpc,
  listOnethingMCPToolsForIpc,
  readOnethingMCPConfigFileForIpc,
} from '../ipc-operations.js'
import type { OnethingMCPSettingsLike } from '../server-orchestration.js'

interface TestServerConfig {
  id?: string
  name: string
  enabled?: boolean
}

interface TestServerState {
  config: TestServerConfig
  status: string
  tools: unknown[]
  resources: unknown[]
  prompts: unknown[]
}

function createServerAdapters(settings: OnethingMCPSettingsLike<TestServerConfig>) {
  const manager = {
    connectServer: vi.fn(),
    disconnectServer: vi.fn(),
    refreshServer: vi.fn(),
    removeServer: vi.fn(),
    updateSettings: vi.fn(),
    getServerState: vi.fn(() => undefined),
  }

  return {
    manager,
    getSettings: vi.fn(() => settings),
    saveSettings: vi.fn(),
    registerTools: vi.fn(),
  }
}

describe('MCP IPC operations', () => {
  it('lists server states and normalizes listing failures', async () => {
    const logger = { error: vi.fn() }
    const servers: TestServerState[] = [{
      config: { id: 's1', name: 'Server' },
      status: 'connected',
      tools: [],
      resources: [],
      prompts: [],
    }]

    await expect(getOnethingMCPServersForIpc({
      getServerStates: () => servers,
    })).resolves.toEqual({
      success: true,
      servers,
    })

    await expect(getOnethingMCPServersForIpc({
      getServerStates: () => {
        throw new Error('boom')
      },
      logger,
    })).resolves.toEqual({
      success: false,
      error: 'boom',
    })
    expect(logger.error).toHaveBeenCalled()
  })

  it('routes server mutations through runtime orchestration and catches adapter failures', async () => {
    const adapters = createServerAdapters({ enabled: true, servers: [] })

    await expect(addOnethingMCPServerForIpc({
      ...adapters,
      config: { id: 'server-1', name: 'Local', enabled: false },
    })).resolves.toEqual({
      success: true,
      server: {
        config: { id: 'server-1', name: 'Local', enabled: false },
        status: 'disconnected',
        tools: [],
        resources: [],
        prompts: [],
      },
    })
    expect(adapters.saveSettings).toHaveBeenCalledWith({
      enabled: true,
      servers: [{ id: 'server-1', name: 'Local', enabled: false }],
    })
    expect(adapters.manager.connectServer).not.toHaveBeenCalled()

    const logger = { error: vi.fn() }
    await expect(addOnethingMCPServerForIpc({
      ...adapters,
      config: { id: 'server-2', name: 'Broken', enabled: false },
      saveSettings: () => {
        throw new Error('save failed')
      },
      logger,
    })).resolves.toEqual({
      success: false,
      error: 'save failed',
    })
    expect(logger.error).toHaveBeenCalled()
  })

  it('projects capability operations and catches tool call failures', async () => {
    await expect(listOnethingMCPToolsForIpc({
      getAllTools: () => [{ name: 'search' }],
    })).resolves.toEqual({
      success: true,
      tools: [{ name: 'search' }],
    })

    await expect(callOnethingMCPToolForIpc({
      serverId: 'server-1',
      toolName: 'search',
      args: { q: 'hello' },
      callTool: () => {
        throw new Error('call failed')
      },
    })).resolves.toEqual({
      success: false,
      error: 'call failed',
    })
  })

  it('reads MCP config files through host file adapters', async () => {
    await expect(readOnethingMCPConfigFileForIpc({
      filePath: '/tmp/mcp.json',
      fileExists: () => false,
      readTextFile: () => {
        throw new Error('should not read')
      },
    })).resolves.toEqual({
      success: false,
      error: 'File not found',
    })

    await expect(readOnethingMCPConfigFileForIpc({
      filePath: '/tmp/mcp.json',
      fileExists: () => true,
      readTextFile: () => '{"mcpServers":{"local":{}}}',
    })).resolves.toEqual({
      success: true,
      content: { mcpServers: { local: {} } },
    })

    await expect(readOnethingMCPConfigFileForIpc({
      filePath: '/tmp/mcp.json',
      fileExists: () => true,
      readTextFile: () => '{',
    })).resolves.toMatchObject({
      success: false,
    })
  })
})
