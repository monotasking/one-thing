import { SSEClientTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import {
  CoreMCPClientRuntime,
  probeMCPServerWithAdapters,
  refreshMCPClientCapabilities,
  type MCPClientCallToolOptions,
  type MCPClientLike,
  type CoreMCPClientRuntimeOptions,
  type CoreMCPProbeAdapters,
} from '@onething/backend/mcp/kernel'
import {
  type CoreMCPProbeResult,
  type MCPConnectionStatus,
  type MCPServerConfig,
  type MCPServerState,
  type MCPToolCallResult,
} from '@shared/mcp/types'
import type { JsonArray, JsonObject, JsonValue } from '@shared/json'
import { getMCPClientIdentity } from '@onething/backend/mcp/mcp-identity'
import {
  ONETHING_MCP_PROBE_CAPABILITIES,
  OnethingMCPClient,
  createOnethingMCPClient,
} from '@onething/backend/mcp/mcp-client'
import { getMCPOAuthFlowManager } from '@onething/backend/mcp/oauth/mcp-oauth'
import { notifyMCPCapabilitiesChanged } from '@onething/backend/mcp/mcp-capabilities-changed'
import { consolePort, getLogger } from '@onething/backend/logging'
import type { ConsoleLikePort } from '@onething/backend/logging'
import type { LegacyDuckLogger } from '@onething/backend/logging'

const log = getLogger('server.mcp')
/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
const consoleLog: ConsoleLikePort & LegacyDuckLogger = consolePort(log)


type ServerMCPTransport = SSEClientTransport | StdioClientTransport | StreamableHTTPClientTransport

export interface ServerMCPClientOptions {
  allowStdio?: boolean
}

export class ServerMCPClient implements MCPClientLike {
  private readonly runtime: CoreMCPClientRuntime<OnethingMCPClient, ServerMCPTransport>

  constructor(config: MCPServerConfig, options: ServerMCPClientOptions = {}) {
    const mCPClientRuntimeOptions: CoreMCPClientRuntimeOptions<OnethingMCPClient, ServerMCPTransport> = {
      config,
      getBaseEnv: () => process.env,
      adapters: {
        createTransport: async (plan) => {
          if (plan.transport === 'stdio') {
            if (!options.allowStdio) {
              throw new Error('MCP stdio transport is disabled in the web server runtime.')
            }
            return new StdioClientTransport({
              command: plan.command,
              args: plan.args,
              env: plan.env,
              cwd: plan.cwd,
            })
          }

          // Same OAuth wiring as app/mcp/client.ts: remote transports carry
          // the issuer-keyed provider so a 401 drives discovery + PKCE + DCR
          // and later refreshes on its own. The flow manager singleton is
          // shared with the desktop path (same credential store).
          const identity = getMCPClientIdentity()
          const oauth = getMCPOAuthFlowManager()
          const authProvider = await oauth.prepareProvider(config.id, identity.name)

          if (plan.transport === 'http') {
            const transport = new StreamableHTTPClientTransport(new URL(plan.url), {
              requestInit: plan.headers ? { headers: plan.headers } : undefined,
              authProvider,
            })
            oauth.attachTransport(config.id, transport)
            return transport
          }

          const transport = new SSEClientTransport(new URL(plan.url), {
            requestInit: plan.headers ? { headers: plan.headers } : undefined,
            authProvider,
          })
          oauth.attachTransport(config.id, transport)
          return transport
        },
        // 与 `mcp-client.ts` 同一只工厂:能力表、版本协商、list-changed、elicitation 处理函数逐字相同。
        createClient: () => createOnethingMCPClient({
          serverId: config.id,
          serverName: config.name,
          onListChanged: () => { void this.handleCapabilitiesChanged() },
          inFlightCall: () => this.runtime.inFlightCall,
        }),
        connectClient: (client, transport) => client.connect(transport),
        refreshCapabilities: (serverId, client, logger) => refreshMCPClientCapabilities(serverId, client, logger),
        getNegotiatedProtocolVersion: client => client.getNegotiatedProtocolVersion(),
        closeClient: client => client.close(),
        closeTransport: transport => transport.close(),
        observeDisconnect: (client, transport, onDisconnect) => {
          let reported = false
          const report = () => {
            if (reported) return
            reported = true
            onDisconnect()
          }
          client.onclose = report
          transport.onclose = report
          transport.onerror = report
        },
        logger: consoleLog,
      },
    };
    this.runtime = new CoreMCPClientRuntime<OnethingMCPClient, ServerMCPTransport>(mCPClientRuntimeOptions)
  }

  get state(): MCPServerState {
    return this.runtime.state
  }

  get status(): MCPConnectionStatus {
    return this.runtime.status
  }

  /** P2-1: see app/mcp/client.ts — refresh state, then fan out to the host. */
  private async handleCapabilitiesChanged(): Promise<void> {
    if (this.status !== 'connected') return
    try {
      await this.runtime.refreshCapabilities()
      notifyMCPCapabilitiesChanged(this.runtime.id)
    } catch (error) {
      log.warn('capability refresh after list-changed failed', { serverId: this.runtime.id }, error)
    }
  }

  async connect(): Promise<void> {
    await this.runtime.connect()
  }

  async disconnect(): Promise<void> {
    await this.runtime.disconnect()
  }

  async updateConfig(config: MCPServerConfig): Promise<void> {
    await this.runtime.updateConfig(config)
  }

  async callTool(toolName: string, args: JsonObject, options?: MCPClientCallToolOptions): Promise<MCPToolCallResult> {
    return this.runtime.callTool(toolName, args, options)
  }

  async readResource(uri: string): Promise<{ success: boolean; content?: JsonValue; error?: string }> {
    return this.runtime.readResource(uri)
  }

  async getPrompt(name: string, args?: Record<string, string>): Promise<{ success: boolean; messages?: JsonArray; error?: string }> {
    return this.runtime.getPrompt(name, args)
  }

  async refreshCapabilities(): Promise<void> {
    await this.runtime.refreshCapabilities()
  }
}

/** P2-2: stdio-gated preflight probe for the web server host. */
export async function probeServerMCPConfig(
  config: MCPServerConfig,
  options: ServerMCPClientOptions = {},
): Promise<CoreMCPProbeResult> {
  try {
    const mCPProbeAdapters: CoreMCPProbeAdapters<OnethingMCPClient, ServerMCPTransport> = {
      createTransport: async (plan) => {
        if (plan.transport === 'stdio') {
          if (!options.allowStdio) {
            throw new Error('MCP stdio transport is disabled in the web server runtime.')
          }
          return new StdioClientTransport({
            command: plan.command,
            args: plan.args,
            env: plan.env,
            cwd: plan.cwd,
          })
        }
        const identity = getMCPClientIdentity()
        const oauth = getMCPOAuthFlowManager()
        const authProvider = await oauth.prepareProvider(config.id, identity.name)
        if (plan.transport === 'http') {
          const transport = new StreamableHTTPClientTransport(new URL(plan.url), {
            requestInit: plan.headers ? { headers: plan.headers } : undefined,
            authProvider,
          })
          oauth.attachTransport(config.id, transport)
          return transport
        }
        const transport = new SSEClientTransport(new URL(plan.url), {
          requestInit: plan.headers ? { headers: plan.headers } : undefined,
          authProvider,
        })
        oauth.attachTransport(config.id, transport)
        return transport
      },
      createClient: () => new OnethingMCPClient(
        getMCPClientIdentity(),
        {
          capabilities: ONETHING_MCP_PROBE_CAPABILITIES,
          versionNegotiation: { mode: 'auto', probe: { timeoutMs: 10_000 } },
        },
      ),
      connectClient: (client, transport) => client.connect(transport),
      closeClient: client => client.close(),
      closeTransport: transport => transport.close(),
      getNegotiatedProtocolVersion: client => client.getNegotiatedProtocolVersion(),
      getServerInfo: client => client.getServerVersion(),
      getServerCapabilities: client => client.getServerCapabilities(),
    };
    return await probeMCPServerWithAdapters<OnethingMCPClient, ServerMCPTransport>(
    config,
    process.env,
    mCPProbeAdapters,
    )
  } finally {
    // See app/mcp/client.ts: drop the probe's ephemeral OAuth flow entry so
    // each probe click does not leave a zombie flow until process exit.
    getMCPOAuthFlowManager().clear(config.id)
  }
}
