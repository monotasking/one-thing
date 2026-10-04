import { describe, expect, it } from 'vitest'
import { HeadlessMCPManager, type MCPClientLike } from '../mcp-kernel-manager.js'
import { CoreMCPClientRuntime } from '../client-runtime.js'
import { createMCPServerState, markMCPServerConnected } from '../client-state.js'
import type { MCPServerConfig, MCPServerState, MCPToolInfo } from '@shared/mcp/types.js'

function tool(serverId: string, name: string): MCPToolInfo {
  return { name, serverId, inputSchema: { type: 'object' } }
}

/** Client stand-in whose connect resolves only when the test says so. */
function createFakeClient(
  serverId: string,
  toolNames: string[],
  options: { connectGate?: Promise<void> } = {},
): MCPClientLike & { connectCount: number } {
  let state: MCPServerState = createMCPServerState({
    id: serverId,
    name: serverId,
    transport: 'stdio',
    enabled: true,
  })

  return {
    connectCount: 0,
    get state() { return state },
    get status() { return state.status },
    async connect() {
      this.connectCount += 1
      if (options.connectGate) await options.connectGate
      state = markMCPServerConnected({ ...state, tools: toolNames.map(name => tool(serverId, name)) })
    },
    async disconnect() {
      state = { ...state, status: 'disconnected', tools: [] }
    },
    async updateConfig(config: MCPServerConfig) {
      state = { ...state, config }
    },
    async callTool() { return { success: true } },
    async readResource() { return { success: true } },
    async getPrompt() { return { success: true } },
    async refreshCapabilities() {},
  }
}

describe('HeadlessMCPManager', () => {
  it('projects capabilities in a stable order regardless of connect order', async () => {
    // Connection completion order decides the client map's key order; without
    // sorting, the same config yields a differently-ordered tool list per boot,
    // which reshuffles the catalog and costs prompt-cache hits.
    const settings = {
      enabled: true,
      servers: [
        { id: 'zebra', name: 'zebra', transport: 'stdio' as const, enabled: true },
        { id: 'alpha', name: 'alpha', transport: 'stdio' as const, enabled: true },
      ],
    }

    const managerA = new HeadlessMCPManager(config =>
      createFakeClient(config.id, config.id === 'zebra' ? ['b_tool', 'a_tool'] : ['c_tool']))
    await managerA.initialize(settings)

    const managerB = new HeadlessMCPManager(config =>
      createFakeClient(config.id, config.id === 'zebra' ? ['b_tool', 'a_tool'] : ['c_tool']))
    await managerB.initialize({ ...settings, servers: [...settings.servers].reverse() })

    const identify = (manager: HeadlessMCPManager) =>
      manager.getAllTools().map(item => `${item.serverId}/${item.name}`)

    expect(identify(managerA)).toEqual(['alpha/c_tool', 'zebra/a_tool', 'zebra/b_tool'])
    expect(identify(managerB)).toEqual(identify(managerA))
  })

  it('serializes mutations so an early request cannot interleave with initialize', async () => {
    // Hosts start MCP without blocking boot while their IPC/HTTP surface is
    // already live, so "add a server" routinely lands mid-initialize.
    let releaseConnect = (): void => {}
    const gate = new Promise<void>(resolve => { releaseConnect = () => resolve() })

    const manager = new HeadlessMCPManager(config =>
      createFakeClient(config.id, ['slow_tool'], config.id === 'slow' ? { connectGate: gate } : {}))

    const initializing = manager.initialize({
      enabled: true,
      servers: [{ id: 'slow', name: 'slow', transport: 'stdio', enabled: true }],
    })

    // Arrives while initialize is still waiting on the connect.
    const updating = manager.updateSettings({
      enabled: true,
      servers: [
        { id: 'slow', name: 'slow', transport: 'stdio', enabled: true },
        { id: 'added', name: 'added', transport: 'stdio', enabled: true },
      ],
    })

    releaseConnect()
    await Promise.all([initializing, updating])

    // Both servers survive: the update did not overwrite settings mid-flight.
    expect(manager.getServerStates().map(state => state.config.id).sort()).toEqual(['added', 'slow'])
    expect(manager.getSettings().servers).toHaveLength(2)
  })
})

describe('CoreMCPClientRuntime auto-reconnect', () => {
  function createReconnectingRuntime(options: { enabled?: boolean } = {}) {
    const scheduled: Array<{ run: () => void; delayMs: number }> = []
    let dropConnection = (): void => {}
    let connectAttempts = 0

    const runtime = new CoreMCPClientRuntime<never, never>({
      config: {
        id: 'server-1',
        name: 'Server 1',
        transport: 'stdio',
        enabled: options.enabled ?? true,
        command: 'node',
      },
      adapters: {
        createTransport: () => ({}) as never,
        createClient: () => ({}) as never,
        connectClient: async () => { connectAttempts += 1 },
        refreshCapabilities: async () => ({ tools: [], resources: [], prompts: [] }),
        closeClient: async () => {},
        closeTransport: async () => {},
        observeDisconnect: (_client, _transport, onDisconnect) => { dropConnection = onDisconnect },
        logger: { log: () => {}, warn: () => {}, error: () => {} },
      },
      scheduleReconnect: (run, delayMs) => {
        scheduled.push({ run, delayMs })
        return { cancel: () => { scheduled.length = 0 } }
      },
    })

    return {
      runtime,
      scheduled,
      drop: () => dropConnection(),
      get connectAttempts() { return connectAttempts },
    }
  }

  it('reconnects with backoff after the connection drops on its own', async () => {
    const harness = createReconnectingRuntime()
    await harness.runtime.connect()
    expect(harness.runtime.status).toBe('connected')

    harness.drop()

    expect(harness.runtime.status).toBe('error')
    expect(harness.runtime.state.error).toContain('Connection lost')
    expect(harness.scheduled).toHaveLength(1)
    expect(harness.scheduled[0].delayMs).toBe(1_000)

    harness.scheduled[0].run()
    await Promise.resolve()
    await Promise.resolve()
    expect(harness.connectAttempts).toBe(2)
  })

  it('does not reconnect after an intentional disconnect', async () => {
    const harness = createReconnectingRuntime()
    await harness.runtime.connect()
    await harness.runtime.disconnect()

    // A close event fired by the transport during our own teardown must not be
    // mistaken for a drop — otherwise turning a server off turns it back on.
    harness.drop()
    expect(harness.scheduled).toHaveLength(0)
    expect(harness.runtime.status).toBe('disconnected')
  })

  it('does not reconnect a server whose config is disabled', async () => {
    const harness = createReconnectingRuntime({ enabled: false })
    await harness.runtime.connect()
    harness.drop()

    expect(harness.scheduled).toHaveLength(0)
  })
})
