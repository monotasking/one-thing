/**
 * MCP Client Wrapper
 *
 * Wraps the MCP SDK v2 client (`@modelcontextprotocol/client`) for easier
 * integration. Version negotiation runs in `auto` mode: 2026-07-28 servers
 * are probed via `server/discover`, legacy servers fall back to the 2025
 * `initialize` handshake byte-identically.
 */

import { Client, SSEClientTransport, StreamableHTTPClientTransport, specTypeSchemas } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import type {
  MCPServerConfig,
  MCPServerState,
  MCPToolCallResult,
  MCPConnectionStatus,
} from './types.js'
import {
  CoreMCPClientRuntime,
  mcpServerSupportsToolTasks,
  probeMCPServerWithAdapters,
  refreshMCPClientCapabilities,
  type CoreMCPProbeResult,
  type CoreMCPTask, type CoreMCPClientRuntimeOptions, type CoreMCPProbeAdapters,
} from '@onething/core/mcp'
import type { JsonArray, JsonObject, JsonValue } from '@onething/core'
import { getMCPOAuthFlowManager } from './oauth/index.js'
import { getMCPClientIdentity } from './identity.js'
import { notifyMCPCapabilitiesChanged } from './capabilities-changed.js'
import { consolePort, getLogger } from '../logging/index.js'
import type { ConsoleLikePort } from '@onething/runtime/logging'
import type { LegacyDuckLogger } from '@onething/core/logging'

const log = getLogger('mcp')
/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
const consoleLog: ConsoleLikePort & LegacyDuckLogger = consolePort(log)


type MCPTransport = StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport

/**
 * P3-1 Tasks: the v2 SDK deliberately offers NO task runtime (task methods
 * are 2025-11-25 wire vocabulary), but the generic schema overload of
 * `request()` still sends them — and the era gate only rejects them toward a
 * 2026-07-28 peer, which never advertises task support anyway. We subclass
 * the SDK Client with the three task methods core's poll loop calls through
 * `CoreMCPClientOperations`. The wire validators come from `specTypeSchemas`
 * (keyed by spec-type name) so we stay on the declared `@modelcontextprotocol/client`
 * dependency instead of reaching into `@modelcontextprotocol/core`.
 */
export class OnethingMCPClient extends Client {
  supportsMCPTasks(): boolean {
    return mcpServerSupportsToolTasks(this.getServerCapabilities())
  }

  async getMCPTask(taskId: string): Promise<CoreMCPTask> {
    return await this.request(
      { method: 'tasks/get', params: { taskId } },
      specTypeSchemas.GetTaskResult,
    ) as CoreMCPTask
  }

  async getMCPTaskPayload(taskId: string): Promise<unknown> {
    return await this.request(
      { method: 'tasks/result', params: { taskId } },
      specTypeSchemas.GetTaskPayloadResult,
    )
  }

  async cancelMCPTask(taskId: string): Promise<unknown> {
    return await this.request(
      { method: 'tasks/cancel', params: { taskId } },
      specTypeSchemas.CancelTaskResult,
    )
  }
}

/**
 * Advertised at initialize: we can follow tools/call task handles and cancel
 * them. Legacy-era servers may then answer tools/call with a task handle;
 * 2026-era peers ignore unknown capability keys (and never create tasks).
 */
export const ONETHING_MCP_CLIENT_CAPABILITIES = {
  tasks: {
    cancel: {},
    requests: { tools: { call: {} } },
  },
} as const

/**
 * MCP Client wrapper class
 */
export class MCPClient {
  private readonly runtime: CoreMCPClientRuntime<OnethingMCPClient, MCPTransport>

  constructor(config: MCPServerConfig) {
    const mCPClientRuntimeOptions: CoreMCPClientRuntimeOptions<OnethingMCPClient, MCPTransport> = {
      config,
      getBaseEnv: () => process.env,
      adapters: {
        createTransport: async (plan) => {
          if (plan.transport === 'stdio') {
            return new StdioClientTransport({
              command: plan.command,
              args: plan.args,
              env: plan.env,
              cwd: plan.cwd,
            })
          }
          // Remote transports carry an OAuth provider: on a 401 the SDK drives
          // discovery + PKCE + (DCR) registration through it, stashes the
          // authorization URL for the UI, and later refreshes tokens on its
          // own. Static headers still ride along for non-OAuth servers.
          const oauth = getMCPOAuthFlowManager()
          const authProvider = await oauth.prepareProvider(config.id, getMCPClientIdentity().name)
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
            // `auto` probes server/discover first and falls back to the 2025
            // initialize handshake. The default probe timeout is the standard
            // 60s request timeout — far too long to sit on when the server is
            // a legacy one that never answers unknown pre-initialize requests
            // (stdio: timeout means "legacy, fall back"; HTTP: timeout means
            // "outage, reject"). 10s is long enough for a healthy server to
            // answer, short enough not to wreck connect UX.
            versionNegotiation: { mode: 'auto', probe: { timeoutMs: 10_000 } },
            // P2-1: era-transparent list-changed tracking. Legacy era: the SDK
            // registers unsolicited `notifications/*/list_changed` handlers
            // (only when the server advertises the capability); modern era:
            // it auto-opens `subscriptions/listen` on every connect — which is
            // also the re-subscribe, since each (re)connect builds a fresh
            // Client. autoRefresh stays false: our runtime owns the refresh
            // (state merge + onStateChange) and the fan-out below regenerates
            // the model-facing catalog.
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
        // The SDK reports a dead connection on both objects: `onclose` when the
        // stream ends cleanly (stdio child exited), `onerror` when it dies
        // mid-flight. Core only needs to hear it once.
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
    this.runtime = new CoreMCPClientRuntime<OnethingMCPClient, MCPTransport>(mCPClientRuntimeOptions)
  }

  /**
   * Get current state
   */
  get state(): MCPServerState {
    return this.runtime.state
  }

  /**
   * Get server ID
   */
  get id(): string {
    return this.runtime.id
  }

  /**
   * P2-1: server pushed a list-changed notification. Re-read the capability
   * lists into state (the SDK only nudges us; autoRefresh stays off), then
   * fan out so the host regenerates the model-facing tools catalog.
   */
  private async handleCapabilitiesChanged(): Promise<void> {
    if (this.status !== 'connected') return
    try {
      await this.runtime.refreshCapabilities()
      notifyMCPCapabilitiesChanged(this.id)
    } catch (error) {
      log.warn('capability refresh after list-changed failed', { serverId: this.id }, error)
    }
  }

  /**
   * Get connection status
   */
  get status(): MCPConnectionStatus {
    return this.runtime.status
  }

  /**
   * Connect to the MCP server
   */
  async connect(): Promise<void> {
    await this.runtime.connect()
  }

  /**
   * Refresh capabilities (tools, resources, prompts)
   */
  async refreshCapabilities(): Promise<void> {
    await this.runtime.refreshCapabilities()
  }

  /**
   * Call a tool
   */
  async callTool(toolName: string, args: JsonObject, options?: { timeoutMs?: number }): Promise<MCPToolCallResult> {
    return this.runtime.callTool(toolName, args, options)
  }

   /**
   * Read a resource
   */
  async readResource(uri: string): Promise<{ success: boolean; content?: JsonValue; error?: string }> {
    return this.runtime.readResource(uri)
  }

   /**
   * Get a prompt
   */
  async getPrompt(name: string, args?: Record<string, string>): Promise<{ success: boolean; messages?: JsonArray; error?: string }> {
    return this.runtime.getPrompt(name, args)
  }

  /**
   * Disconnect from the server
   */
  async disconnect(): Promise<void> {
    await this.runtime.disconnect()
  }

  /**
   * Update configuration (reconnect if needed)
   */
  async updateConfig(config: MCPServerConfig): Promise<void> {
    await this.runtime.updateConfig(config)
  }
}

/**
 * P2-2 preflight probe: connect a throwaway client to a candidate config and
 * report protocol/identity/capabilities (or a structured failure) without
 * touching the manager, settings, or the model-facing catalog. OAuth servers
 * answer `authRequired`; "probe then add" does not double-register because
 * DCR registrations persist issuer-keyed in the credential store (the
 * probe's own ephemeral flow entry is dropped when the probe returns — the
 * dialog probes under a throwaway id).
 */
export async function probeMCPServerConfig(config: MCPServerConfig): Promise<CoreMCPProbeResult> {
  try {
    const mCPProbeAdapters: CoreMCPProbeAdapters<Client, MCPTransport> = {
      createTransport: async (plan) => {
        if (plan.transport === 'stdio') {
          return new StdioClientTransport({
            command: plan.command,
            args: plan.args,
            env: plan.env,
            cwd: plan.cwd,
          })
        }
        const oauth = getMCPOAuthFlowManager()
        const authProvider = await oauth.prepareProvider(config.id, getMCPClientIdentity().name)
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
    };
    return await probeMCPServerWithAdapters<Client, MCPTransport>(
    config,
    process.env,
    mCPProbeAdapters,
    )
  } finally {
    // Drop the probe's ephemeral OAuth flow entry (loopback registration +
    // stashed URL); without this every probe click leaves a zombie in the
    // flow manager until process exit. Durable credentials live in the
    // issuer-keyed store and are untouched by `clear`.
    getMCPOAuthFlowManager().clear(config.id)
  }
}
