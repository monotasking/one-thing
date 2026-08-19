import { SSEClientTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import {
  CoreMCPClientRuntime,
  probeMCPServerWithAdapters,
  refreshMCPClientCapabilities,
  type CoreMCPProbeResult,
  type MCPClientLike,
  type MCPConnectionStatus,
  type MCPServerConfig,
  type MCPServerState,
  type MCPToolCallResult,
} from '@onething/core/mcp'
import type { JsonArray, JsonObject, JsonValue } from '@onething/core'
import { getMCPClientIdentity } from '@onething/app/mcp/identity.js'
import {
  ONETHING_MCP_CLIENT_CAPABILITIES,
  OnethingMCPClient,
} from '@onething/app/mcp/client.js'
import { getMCPOAuthFlowManager } from '@onething/app/mcp/oauth/index.js'
import { notifyMCPCapabilitiesChanged } from '@onething/app/mcp/capabilities-changed.js'

type ServerMCPTransport = SSEClientTransport | StdioClientTransport | StreamableHTTPClientTransport

export interface ServerMCPClientOptions {
  allowStdio?: boolean
}

export class ServerMCPClient implements MCPClientLike {
  private readonly runtime: CoreMCPClientRuntime<OnethingMCPClient, ServerMCPTransport>

  constructor(config: MCPServerConfig, options: ServerMCPClientOptions = {}) {
    this.runtime = new CoreMCPClientRuntime<OnethingMCPClient, ServerMCPTransport>({
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
        createClient: () => new OnethingMCPClient(
          getMCPClientIdentity(),
          {
            capabilities: ONETHING_MCP_CLIENT_CAPABILITIES,
            // See app/mcp/client.ts: `auto` + a 10s probe cap so a silent
            // legacy server cannot stall connect for the default 60s.
            versionNegotiation: { mode: 'auto', probe: { timeoutMs: 10_000 } },
            // P2-1: same era-transparent list-changed wiring as
            // app/mcp/client.ts (auto-opened subscriptions/listen on modern
            // connections doubles as the re-subscribe on reconnect).
            listChanged: {
              tools: { autoRefresh: false, onChanged: () => { void this.handleCapabilitiesChanged() } },
              prompts: { autoRefresh: false, onChanged: () => { void this.handleCapabilitiesChanged() } },
              resources: { autoRefresh: false, onChanged: () => { void this.handleCapabilitiesChanged() } },
            },
          },
        ),
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
        logger: console,
      },
    })
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
      console.warn?.(`[MCP:${this.runtime.id}] Capability refresh after list-changed failed:`, error)
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

  async callTool(toolName: string, args: JsonObject): Promise<MCPToolCallResult> {
    return this.runtime.callTool(toolName, args)
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
    return await probeMCPServerWithAdapters<OnethingMCPClient, ServerMCPTransport>(
    config,
    process.env,
    {
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
          capabilities: ONETHING_MCP_CLIENT_CAPABILITIES,
          versionNegotiation: { mode: 'auto', probe: { timeoutMs: 10_000 } },
        },
      ),
      connectClient: (client, transport) => client.connect(transport),
      closeClient: client => client.close(),
      closeTransport: transport => transport.close(),
      getNegotiatedProtocolVersion: client => client.getNegotiatedProtocolVersion(),
      getServerInfo: client => client.getServerVersion(),
      getServerCapabilities: client => client.getServerCapabilities(),
    },
    )
  } finally {
    // See app/mcp/client.ts: drop the probe's ephemeral OAuth flow entry so
    // each probe click does not leave a zombie flow until process exit.
    getMCPOAuthFlowManager().clear(config.id)
  }
}
