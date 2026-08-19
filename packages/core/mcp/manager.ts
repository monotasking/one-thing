import type {
  JsonArray,
  JsonObject,
  JsonValue,
} from '../json.js'
import type {
  MCPConnectionStatus,
  MCPPromptInfo,
  MCPResourceInfo,
  MCPServerConfig,
  MCPServerState,
  MCPSettings,
  MCPToolCallResult,
  MCPToolInfo,
} from './types.js'
import { getCoreLogger } from '../logging/index.js'

const log = getCoreLogger('core.mcp')


export interface MCPClientLike {
  readonly state: MCPServerState
  readonly status: MCPConnectionStatus
  connect(): Promise<void>
  disconnect(): Promise<void>
  updateConfig(config: MCPServerConfig): Promise<void>
  callTool(toolName: string, args: JsonObject): Promise<MCPToolCallResult>
  readResource(uri: string): Promise<{ success: boolean; content?: JsonValue; error?: string }>
  getPrompt(name: string, args?: Record<string, string>): Promise<{ success: boolean; messages?: JsonArray; error?: string }>
  refreshCapabilities(): Promise<void>
}

export type MCPClientFactory<TClient extends MCPClientLike> = (config: MCPServerConfig) => TClient

export class HeadlessMCPManager<TClient extends MCPClientLike = MCPClientLike> {
  protected clients: Map<string, TClient> = new Map()
  protected settings: MCPSettings = { enabled: true, servers: [] }
  protected initialized = false

  /**
   * Serializes every mutating operation.
   *
   * Hosts start MCP without blocking boot (desktop fires initializeMCP() and
   * forgets; the server does the same) while their IPC/HTTP surface is already
   * live. An "add server" arriving mid-initialize therefore interleaved with
   * it, and the two rewrote `settings` and the client map underneath each
   * other. Reads stay unqueued.
   */
  private opQueue: Promise<unknown> = Promise.resolve()

  constructor(private readonly createClient: MCPClientFactory<TClient>) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.opQueue.then(operation, operation)
    this.opQueue = result.then(() => undefined, () => undefined)
    return result
  }

  async initialize(settings: MCPSettings): Promise<void> {
    return this.enqueue(() => this.initializeInternal(settings))
  }

  private async initializeInternal(settings: MCPSettings): Promise<void> {
    if (this.initialized) {
      log.info('mcp already initialized, updating settings')
      await this.updateSettingsInternal(settings)
      return
    }

    log.info('mcp initializing')
    this.settings = settings

    if (!settings.enabled) {
      log.info('mcp disabled')
      this.initialized = true
      return
    }

    const enabledServers = settings.servers.filter(server => server.enabled)
    log.info('mcp connecting to servers', { count: enabledServers.length })

    await Promise.allSettled(
      enabledServers.map(config => this.connectServerInternal(config)),
    )

    this.initialized = true
    log.info('mcp initialized')
  }

  async updateSettings(settings: MCPSettings): Promise<void> {
    return this.enqueue(() => this.updateSettingsInternal(settings))
  }

  private async updateSettingsInternal(settings: MCPSettings): Promise<void> {
    const oldSettings = this.settings
    this.settings = settings

    if (!settings.enabled) {
      await this.disconnectAllInternal()
      return
    }

    if (!oldSettings.enabled && settings.enabled) {
      const enabledServers = settings.servers.filter(server => server.enabled)
      await Promise.allSettled(
        enabledServers.map(config => this.connectServerInternal(config)),
      )
      return
    }

    const newServerIds = new Set(settings.servers.map(server => server.id))
    const oldServerIds = new Set(oldSettings.servers.map(server => server.id))

    for (const id of oldServerIds) {
      if (!newServerIds.has(id)) {
        await this.removeServerInternal(id)
      }
    }

    for (const config of settings.servers) {
      const client = this.clients.get(config.id)

      if (!client) {
        if (config.enabled) {
          await this.connectServerInternal(config)
        }
      } else {
        const oldConfig = oldSettings.servers.find(server => server.id === config.id)
        const configChanged = JSON.stringify(oldConfig) !== JSON.stringify(config)

        if (configChanged) {
          await client.updateConfig(config)
        }
      }
    }
  }

  async connectServer(config: MCPServerConfig): Promise<void> {
    return this.enqueue(() => this.connectServerInternal(config))
  }

  private async connectServerInternal(config: MCPServerConfig): Promise<void> {
    if (this.clients.has(config.id)) {
      await this.disconnectServerInternal(config.id)
    }

    const client = this.createClient(config)
    this.clients.set(config.id, client)

    try {
      await client.connect()
    } catch (error) {
      log.error('mcp server connect failed', { serverId: config.id }, error)
    }
  }

  async disconnectServer(serverId: string): Promise<void> {
    return this.enqueue(() => this.disconnectServerInternal(serverId))
  }

  private async disconnectServerInternal(serverId: string): Promise<void> {
    const client = this.clients.get(serverId)
    if (client) {
      await client.disconnect()
    }
  }

  async removeServer(serverId: string): Promise<void> {
    return this.enqueue(() => this.removeServerInternal(serverId))
  }

  private async removeServerInternal(serverId: string): Promise<void> {
    const client = this.clients.get(serverId)
    if (client) {
      await client.disconnect()
      this.clients.delete(serverId)
    }
  }

  async disconnectAll(): Promise<void> {
    return this.enqueue(() => this.disconnectAllInternal())
  }

  private async disconnectAllInternal(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.clients.keys()).map(id => this.disconnectServerInternal(id)),
    )
  }

  getServerStates(): MCPServerState[] {
    return Array.from(this.clients.values()).map(client => client.state)
  }

  getServerState(serverId: string): MCPServerState | undefined {
    return this.clients.get(serverId)?.state
  }

  /**
   * Stable ordering for every capability projection.
   *
   * The client map is keyed in connection-completion order (initialize connects
   * with Promise.allSettled), so two boots of the same config produced the tool
   * list in different orders — which reshuffles the generated tools catalog and
   * the model-facing tool set, costing prompt-cache hits for no reason. The
   * 2026-07-28 spec asks servers for deterministic `tools/list` order for the
   * same reason; this is the client-side half of it.
   */
  private sortedByServerAndName<T extends { serverId: string }>(
    items: T[],
    nameOf: (item: T) => string,
  ): T[] {
    return items.sort((a, b) =>
      a.serverId.localeCompare(b.serverId) || nameOf(a).localeCompare(nameOf(b)))
  }

  private collectConnected<T>(select: (state: MCPServerState) => T[]): T[] {
    const collected: T[] = []
    for (const client of this.clients.values()) {
      if (client.status === 'connected') {
        collected.push(...select(client.state))
      }
    }
    return collected
  }

  getAllTools(): MCPToolInfo[] {
    return this.sortedByServerAndName(
      this.collectConnected(state => state.tools),
      tool => tool.name,
    )
  }

  getAllResources(): MCPResourceInfo[] {
    return this.sortedByServerAndName(
      this.collectConnected(state => state.resources),
      resource => resource.uri,
    )
  }

  getAllPrompts(): MCPPromptInfo[] {
    return this.sortedByServerAndName(
      this.collectConnected(state => state.prompts),
      prompt => prompt.name,
    )
  }

  async callTool(serverId: string, toolName: string, args: JsonObject): Promise<MCPToolCallResult> {
    const client = this.clients.get(serverId)
    if (!client) {
      return {
        success: false,
        error: `Server "${serverId}" not found`,
      }
    }

    if (client.status !== 'connected') {
      return {
        success: false,
        error: `Server "${serverId}" is not connected`,
      }
    }

    return client.callTool(toolName, args)
  }

  async callToolByName(toolName: string, args: JsonObject): Promise<MCPToolCallResult> {
    for (const client of this.clients.values()) {
      if (client.status !== 'connected') continue

      const tool = client.state.tools.find(item => item.name === toolName)
      if (tool) {
        return client.callTool(toolName, args)
      }
    }

    return {
      success: false,
      error: `Tool "${toolName}" not found on any connected server`,
    }
  }

  async readResource(serverId: string, uri: string): Promise<{ success: boolean; content?: JsonValue; error?: string }> {
    const client = this.clients.get(serverId)
    if (!client) {
      return {
        success: false,
        error: `Server "${serverId}" not found`,
      }
    }

    return client.readResource(uri)
  }

  async getPrompt(serverId: string, name: string, args?: Record<string, string>): Promise<{ success: boolean; messages?: JsonArray; error?: string }> {
    const client = this.clients.get(serverId)
    if (!client) {
      return {
        success: false,
        error: `Server "${serverId}" not found`,
      }
    }

    return client.getPrompt(name, args)
  }

  async refreshServer(serverId: string): Promise<void> {
    return this.enqueue(async () => {
      const client = this.clients.get(serverId)
      if (client && client.status === 'connected') {
        await client.refreshCapabilities()
      }
    })
  }

  async reconnectServer(serverId: string): Promise<void> {
    return this.enqueue(async () => {
      const client = this.clients.get(serverId)
      if (client) {
        await client.disconnect()
        await client.connect()
      }
    })
  }

  get isEnabled(): boolean {
    return this.settings.enabled
  }

  getSettings(): MCPSettings {
    return { ...this.settings }
  }

  async shutdown(): Promise<void> {
    // Queued so an in-flight connect finishes (and gets torn down) instead of
    // resolving into a map we already cleared.
    return this.enqueue(async () => {
      log.info('mcp shutting down')
      await this.disconnectAllInternal()
      this.initialized = false
      log.info('mcp shut down')
    })
  }
}
