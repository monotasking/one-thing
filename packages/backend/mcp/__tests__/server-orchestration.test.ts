import { describe, expect, it, vi } from 'vitest'
import {
  addOnethingMCPServer,
  connectOnethingMCPServer,
  removeOnethingMCPServer,
  updateOnethingMCPServer,
  type OnethingMCPServerConfigLike,
  type OnethingMCPSettingsLike,
} from '../server-orchestration.js'

interface TestMCPServerConfig extends OnethingMCPServerConfigLike {
  name: string
}

function createAdapters(settings: OnethingMCPSettingsLike<TestMCPServerConfig>) {
  const savedSettings: OnethingMCPSettingsLike<TestMCPServerConfig>[] = []
  const manager = {
    connectServer: vi.fn(),
    disconnectServer: vi.fn(),
    refreshServer: vi.fn(),
    removeServer: vi.fn(),
    updateSettings: vi.fn(),
    getServerState: vi.fn(),
  }

  return {
    savedSettings,
    manager,
    getSettings: vi.fn(() => settings),
    saveSettings: vi.fn((nextSettings: OnethingMCPSettingsLike<TestMCPServerConfig>) => {
      savedSettings.push(nextSettings)
    }),
    registerTools: vi.fn(),
  }
}

describe('MCP server orchestration', () => {
  it('adds a server, creates a missing id, saves settings, and connects enabled servers', async () => {
    const adapters = createAdapters({ enabled: true, servers: [] })
    adapters.manager.getServerState.mockReturnValue(undefined)

    await expect(addOnethingMCPServer({
      ...adapters,
      config: {
        name: 'Local MCP',
        enabled: true,
      },
      createId: () => 'server-1',
    })).resolves.toEqual({
      success: true,
      server: {
        config: {
          id: 'server-1',
          name: 'Local MCP',
          enabled: true,
        },
        status: 'disconnected',
        tools: [],
        resources: [],
        prompts: [],
      },
    })

    expect(adapters.savedSettings).toEqual([{
      enabled: true,
      servers: [{
        id: 'server-1',
        name: 'Local MCP',
        enabled: true,
      }],
    }])
    expect(adapters.manager.connectServer).toHaveBeenCalledWith({
      id: 'server-1',
      name: 'Local MCP',
      enabled: true,
    })
    expect(adapters.registerTools).toHaveBeenCalledTimes(1)
  })

  it('updates an existing server and refreshes manager settings', async () => {
    const adapters = createAdapters({
      enabled: true,
      servers: [
        { id: 'a', name: 'A', enabled: true },
        { id: 'b', name: 'B', enabled: true },
      ],
    })
    adapters.manager.getServerState.mockReturnValue({
      config: { id: 'b', name: 'B2', enabled: false },
      status: 'disconnected',
      tools: [],
      resources: [],
      prompts: [],
    })

    await expect(updateOnethingMCPServer({
      ...adapters,
      config: { id: 'b', name: 'B2', enabled: false },
    })).resolves.toMatchObject({
      success: true,
      server: {
        config: { id: 'b', name: 'B2', enabled: false },
      },
    })

    const nextSettings = {
      enabled: true,
      servers: [
        { id: 'a', name: 'A', enabled: true },
        { id: 'b', name: 'B2', enabled: false },
      ],
    }
    expect(adapters.saveSettings).toHaveBeenCalledWith(nextSettings)
    expect(adapters.manager.updateSettings).toHaveBeenCalledWith(nextSettings)
    expect(adapters.registerTools).toHaveBeenCalledTimes(1)
  })

  it('returns not found without saving when updating or connecting a missing server', async () => {
    const adapters = createAdapters({ enabled: true, servers: [] })

    await expect(updateOnethingMCPServer({
      ...adapters,
      config: { id: 'missing', name: 'Missing', enabled: true },
    })).resolves.toEqual({ success: false, error: 'Server not found' })
    await expect(connectOnethingMCPServer({
      ...adapters,
      serverId: 'missing',
    })).resolves.toEqual({ success: false, error: 'Server not found' })

    expect(adapters.saveSettings).not.toHaveBeenCalled()
    expect(adapters.manager.connectServer).not.toHaveBeenCalled()
    expect(adapters.registerTools).not.toHaveBeenCalled()
  })

  it('reports a failed connect instead of always succeeding', async () => {
    const adapters = createAdapters({
      enabled: true,
      servers: [{ id: 'server-1', name: 'Local MCP', enabled: true }],
    })
    // connectServer swallows connection errors on purpose (one bad server must
    // not break startup for the rest) — the failure only shows up in state.
    adapters.manager.getServerState.mockReturnValue({
      config: { id: 'server-1', name: 'Local MCP', enabled: true },
      status: 'error',
      error: 'spawn nonexistent-command ENOENT',
      tools: [],
      resources: [],
      prompts: [],
    })

    const result = await connectOnethingMCPServer({ ...adapters, serverId: 'server-1' })

    expect(result.success).toBe(false)
    expect(result.error).toBe('spawn nonexistent-command ENOENT')
    expect(adapters.manager.connectServer).toHaveBeenCalled()
  })

  it('removes a server after disconnecting it from the manager', async () => {
    const adapters = createAdapters({
      enabled: true,
      servers: [
        { id: 'keep', name: 'Keep', enabled: true },
        { id: 'remove', name: 'Remove', enabled: true },
      ],
    })

    await expect(removeOnethingMCPServer({
      ...adapters,
      serverId: 'remove',
    })).resolves.toEqual({ success: true })

    expect(adapters.manager.removeServer).toHaveBeenCalledWith('remove')
    expect(adapters.saveSettings).toHaveBeenCalledWith({
      enabled: true,
      servers: [{ id: 'keep', name: 'Keep', enabled: true }],
    })
    expect(adapters.registerTools).toHaveBeenCalledTimes(1)
  })
})
