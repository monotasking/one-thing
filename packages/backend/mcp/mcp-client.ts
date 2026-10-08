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
} from '@shared/mcp/types.js'
import {
  CoreMCPClientRuntime,
  mcpServerSupportsToolTasks,
  probeMCPServerWithAdapters,
  refreshMCPClientCapabilities,
  type CoreMCPTask,
  type CoreMCPClientRuntimeOptions,
  type CoreMCPProbeAdapters,
  type MCPInFlightToolCall,
  type MCPToolCallCaller,
} from '@onething/backend/mcp/kernel'
import { type CoreMCPProbeResult } from '@shared/mcp/types'
import type { JsonArray, JsonObject, JsonValue } from '@shared/json'
import { getMCPOAuthFlowManager } from './oauth/mcp-oauth.js'
import { getMCPClientIdentity } from './mcp-identity.js'
import { notifyMCPCapabilitiesChanged } from './mcp-capabilities-changed.js'
import { answerMCPElicitation, type MCPElicitationPorts } from './mcp-elicitation.js'
import { consolePort, getLogger } from '../logging/logging.js'
import type { ConsoleLikePort } from '@onething/backend/logging'
import type { LegacyDuckLogger } from '@onething/backend/logging'

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
 *
 * `elicitation.form`(2026-10-08):服务器在一次调用途中可以反过来问人(空表单 = 同意 / 拒绝),
 * 由 `mcp-elicitation.ts` 画成权限卡。只有装了处理函数的客户端(`createOnethingMCPClient`)才
 * 声明它 —— 探测用的一次性客户端用 `ONETHING_MCP_PROBE_CAPABILITIES`,声明了却不答会让服务器
 * 收到一个 method-not-found。
 */
export const ONETHING_MCP_CLIENT_CAPABILITIES = {
  tasks: {
    cancel: {},
    requests: { tools: { call: {} } },
  },
  elicitation: { form: {} },
} as const

export const ONETHING_MCP_PROBE_CAPABILITIES = {
  tasks: ONETHING_MCP_CLIENT_CAPABILITIES.tasks,
} as const

export interface CreateOnethingMCPClientInput {
  readonly serverId: string
  readonly serverName: string
  /** P2-1:服务器推来 list-changed 时的回调(三张表共用一只)。 */
  readonly onListChanged: () => void
  /** 客户端运行时此刻在飞的调用;elicitation 据此找发问该落的会话。 */
  readonly inFlightCall: () => MCPInFlightToolCall | null
  /** 测试替身:权限卡与 grant 的两只口;缺省是进程里那一份 `Permission`。 */
  readonly elicitationPorts?: MCPElicitationPorts
}

/**
 * 装好 onething 这一侧全部约定的 SDK 客户端:能力表、版本协商、list-changed 回调,以及
 * `elicitation/create` 的处理函数(→ `answerMCPElicitation`)。桌面 / 后端进程的 `MCPClient` 与
 * server runtime 的 `ServerMCPClient` 都从这里造,两边对服务器的样子逐字相同。
 */
export function createOnethingMCPClient(input: CreateOnethingMCPClientInput): OnethingMCPClient {
  const client = new OnethingMCPClient(
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
        tools: { autoRefresh: false, onChanged: input.onListChanged },
        prompts: { autoRefresh: false, onChanged: input.onListChanged },
        resources: { autoRefresh: false, onChanged: input.onListChanged },
      },
    },
  )
  client.setRequestHandler('elicitation/create', request =>
    answerMCPElicitation(
      {
        serverId: input.serverId,
        serverName: input.serverName,
        params: request.params,
        inFlight: input.inFlightCall(),
      },
      input.elicitationPorts,
    ))
  return client
}

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
   * Call a tool. `caller` 是发起这次调用的会话坐标(见 `MCPToolCallCaller`)。
   */
  async callTool(
    toolName: string,
    args: JsonObject,
    options?: { timeoutMs?: number; caller?: MCPToolCallCaller },
  ): Promise<MCPToolCallResult> {
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
