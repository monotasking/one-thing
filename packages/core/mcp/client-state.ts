import {
  toJsonSchemaObject,
  toJsonValue,
  type JsonArray,
  type JsonObject,
  type JsonValue,
} from '../json.js'
import { normalizeMCPContent } from './content.js'
import {
  mcpTaskHandleFromResult,
  mcpTaskIsTerminal,
  mcpTaskProvenanceText,
  pollMCPTaskWithAdapters,
  type CoreMCPTask,
  type CoreMCPTaskHandle,
} from './tasks.js'
import type {
  MCPConnectionStatus,
  MCPPromptInfo,
  MCPResourceInfo,
  MCPServerConfig,
  MCPServerState,
  MCPToolCallResult,
  MCPToolInfo,
  MCPTransportType,
} from './types.js'
import { toLogger, type CompatLogger } from '../logging/index.js'

/** @deprecated 统一为 `Logger`(§8.3 区 ①);过渡期仍收老鸭子形状。 */
export type CoreMCPLogger = CompatLogger

export interface RawMCPTool {
  name?: unknown
  description?: unknown
  inputSchema?: unknown
}

export interface RawMCPResource {
  uri?: unknown
  name?: unknown
  description?: unknown
  mimeType?: unknown
}

export interface RawMCPPrompt {
  name?: unknown
  description?: unknown
  arguments?: unknown
}

export interface RawMCPToolCallResult {
  content?: unknown
  isError?: unknown
}

export type CoreMCPTransportPlan =
  | {
      transport: 'stdio'
      command: string
      args: string[]
      env?: Record<string, string>
      cwd?: string
      timeoutMs: number
      logMessage: string
    }
  | {
      transport: 'sse' | 'http'
      url: string
      headers?: Record<string, string>
      timeoutMs: number
      logMessage: string
    }

export interface CoreMCPClientOperations {
  listTools(): Promise<{ tools?: unknown }>
  listResources(): Promise<{ resources?: unknown }>
  listPrompts(): Promise<{ prompts?: unknown }>
  callTool(
    input: { name: string; arguments: JsonObject },
    options?: {
      signal?: AbortSignal
      /**
       * The caller's cached definition of this tool (P2-5): on a 2026-07-28
       * Streamable HTTP connection the SDK mirrors it into the spec-required
       * `Mcp-Method`/`Mcp-Name` (and `Mcp-Param-*`) headers and uses its
       * outputSchema to validate the result. Legacy connections ignore it.
       */
      toolDefinition?: {
        name: string
        description?: string
        inputSchema?: unknown
      }
    },
  ): Promise<unknown>
  readResource(input: { uri: string }): Promise<{ contents?: unknown }>
  getPrompt(input: { name: string; arguments?: Record<string, string> }): Promise<{ messages?: unknown }>
  /**
   * P3-1 Tasks (2025-11-25 wire era only): read task state via `tasks/get`.
   * Only implementable on SDK clients that can send the schema-overload
   * request; absent → task handles fall back to the P2-4 notice.
   */
  getMCPTask?(taskId: string): Promise<CoreMCPTask>
  /** P3-1: fetch the payload of a COMPLETED task via `tasks/result`. */
  getMCPTaskPayload?(taskId: string): Promise<unknown>
  /** P3-1: `tasks/cancel` — invoked best-effort on abort/timeout. */
  cancelMCPTask?(taskId: string): Promise<unknown>
  /**
   * P3-1: does the server let tools/call run as tasks
   * (`capabilities.tasks.requests.tools.call`)? Legacy-era only — a
   * 2026-07-28 peer never advertises it.
   */
  supportsMCPTasks?(): boolean
}

export interface CoreMCPRefreshCapabilitiesResult {
  tools: MCPToolInfo[]
  resources: MCPResourceInfo[]
  prompts: MCPPromptInfo[]
}

export interface CoreMCPConnectAdapters<TClient, TTransport> {
  createTransport(plan: CoreMCPTransportPlan): TTransport | Promise<TTransport>
  createClient(): TClient
  connectClient(client: TClient, transport: TTransport): Promise<void>
  refreshCapabilities(serverId: string, client: TClient, logger?: CoreMCPLogger): Promise<CoreMCPRefreshCapabilitiesResult>
  /**
   * Read the protocol revision the SDK negotiated for this connection
   * (`2026-07-28`, `2025-11-25`, …). Optional — hosts on the v2 MCP client
   * wire `client.getNegotiatedProtocolVersion()` here so the result lands in
   * `MCPServerState.protocolVersion` for the UI to show.
   */
  getNegotiatedProtocolVersion?(client: TClient): string | undefined
  onStateChange?: (state: MCPServerState) => void
  logger?: CoreMCPLogger
  now?: () => number
}

export interface ConnectMCPClientWithAdaptersOptions<TClient, TTransport> {
  state: MCPServerState
  client: TClient | null
  transport: TTransport | null
  baseEnv: Record<string, string | undefined>
  adapters: CoreMCPConnectAdapters<TClient, TTransport>
}

export interface ConnectMCPClientResult<TClient, TTransport> {
  state: MCPServerState
  client: TClient | null
  transport: TTransport | null
  alreadyConnected: boolean
}

export interface DisconnectMCPClientAdapters<TClient, TTransport> {
  closeClient(client: TClient): Promise<void>
  closeTransport(transport: TTransport): Promise<void>
  logger?: CoreMCPLogger
}

export interface DisconnectMCPClientWithAdaptersOptions<TClient, TTransport> {
  state: MCPServerState
  client: TClient | null
  transport: TTransport | null
  adapters: DisconnectMCPClientAdapters<TClient, TTransport>
}

export interface DisconnectMCPClientResult {
  state: MCPServerState
  client: null
  transport: null
}

export interface UpdateMCPClientConfigAdapters<TClient, TTransport>
  extends CoreMCPConnectAdapters<TClient, TTransport>,
    DisconnectMCPClientAdapters<TClient, TTransport> {}

export interface UpdateMCPClientConfigWithAdaptersOptions<TClient, TTransport> {
  state: MCPServerState
  client: TClient | null
  transport: TTransport | null
  config: MCPServerConfig
  baseEnv: Record<string, string | undefined>
  adapters: UpdateMCPClientConfigAdapters<TClient, TTransport>
}

export interface UpdateMCPClientConfigResult<TClient, TTransport> {
  state: MCPServerState
  client: TClient | null
  transport: TTransport | null
  wasConnected: boolean
  reconnected: boolean
}

export function mcpClientNotConnectedResult<TResult extends { success: boolean; error?: string }>(
  error = 'Client not connected',
): TResult {
  return {
    success: false,
    error,
  } as TResult
}

export async function runMCPConnectedClientOperation<TClient, TResult extends { success: boolean; error?: string }>(
  client: TClient | null,
  operation: (client: TClient) => Promise<TResult>,
  notConnectedResult: TResult = mcpClientNotConnectedResult<TResult>(),
): Promise<TResult> {
  if (!client) return notConnectedResult
  return operation(client)
}

export function createMCPServerState(
  config: MCPServerConfig,
  status: MCPConnectionStatus = 'disconnected',
  error?: string,
): MCPServerState {
  return {
    config,
    status,
    error,
    tools: [],
    resources: [],
    prompts: [],
  }
}

export function setMCPServerStatus(
  state: MCPServerState,
  status: MCPConnectionStatus,
  options: { error?: string; connectedAt?: number } = {},
): MCPServerState {
  return {
    ...state,
    status,
    error: options.error,
    connectedAt: options.connectedAt,
  }
}

export function markMCPServerConnected(
  state: MCPServerState,
  connectedAt: number = Date.now(),
): MCPServerState {
  return {
    ...state,
    status: 'connected',
    error: undefined,
    connectedAt,
  }
}

export function markMCPServerDisconnected(state: MCPServerState): MCPServerState {
  return {
    ...state,
    status: 'disconnected',
    error: undefined,
    tools: [],
    resources: [],
    prompts: [],
    connectedAt: undefined,
    protocolVersion: undefined,
  }
}

export function markMCPServerError(state: MCPServerState, error: unknown): MCPServerState {
  return {
    ...state,
    status: 'error',
    error: errorMessage(error, 'Unknown connection error'),
  }
}

export function mcpConnectTimeoutMs(transport: MCPTransportType): number {
  // Local stdio processes may cold-start (npx download); remote transports
  // (SSE legacy, Streamable HTTP) get the shorter network budget.
  return transport === 'stdio' ? 60000 : 30000
}

export function mcpConnectionTimeoutMessage(timeoutMs: number): string {
  return `Connection timeout after ${timeoutMs / 1000}s`
}

export function mcpToolCallTimeoutMessage(toolName: string, timeoutMs: number): string {
  return `MCP tool call "${toolName}" timed out after ${timeoutMs / 1000}s`
}

export function mcpTimeoutMessage(action: string, timeoutMs: number): string {
  return `${action} timed out after ${timeoutMs / 1000}s`
}

export function errorMessage(error: unknown, fallback = 'Unknown error'): string {
  return error instanceof Error ? error.message : String(error ?? fallback)
}

export function filterStringEnvironment(
  env: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

/**
 * Host variables an MCP child process may inherit.
 *
 * Deliberately tiny and secret-free. The transport SDK already supplies its own
 * safe base (HOME/PATH/SHELL/TERM/USER on POSIX); these are the ones whose
 * absence fails invisibly — a stdio server behind a corporate proxy silently
 * cannot reach the network, with no error that points at the env.
 *
 * Anything else a server needs is declared per-server in its `env` config.
 */
export const MCP_INHERITED_ENV_VARS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'LANG',
  'LC_ALL',
] as const

export function inheritableMCPEnvironment(
  baseEnv: Record<string, string | undefined>,
): Record<string, string> {
  const inherited: Record<string, string> = {}
  for (const key of MCP_INHERITED_ENV_VARS) {
    const value = baseEnv[key]
    if (value !== undefined) inherited[key] = value
  }
  return inherited
}

/**
 * NEVER spread the host environment wholesale here. Doing so handed every
 * third-party MCP child process the full `process.env` — provider API keys,
 * OAuth tokens, ONETHING_* config — and it did so only when the user happened
 * to set one unrelated custom variable, which made the leak both total and
 * invisible.
 */
export function mergeMCPEnvironment(
  baseEnv: Record<string, string | undefined>,
  customEnv?: Record<string, string>,
): Record<string, string> {
  return {
    ...inheritableMCPEnvironment(baseEnv),
    ...customEnv,
  }
}

export function buildMCPTransportPlan(
  config: MCPServerConfig,
  baseEnv: Record<string, string | undefined>,
): CoreMCPTransportPlan {
  const timeoutMs = mcpConnectTimeoutMs(config.transport)

  if (config.transport === 'stdio') {
    const { command, args = [], env, cwd } = config
    if (!command) {
      throw new Error('Command is required for stdio transport')
    }
    return {
      transport: 'stdio',
      command,
      args,
      env: mergeMCPEnvironment(baseEnv, env),
      cwd,
      timeoutMs,
      logMessage: `Connecting via stdio: ${command} ${args.join(' ')}`,
    }
  }

  const { url, headers } = config
  const transport = config.transport // 'sse' | 'http'
  if (!url) {
    throw new Error(`URL is required for ${transport === 'http' ? 'Streamable HTTP' : 'SSE'} transport`)
  }
  return {
    transport,
    url,
    headers,
    timeoutMs,
    logMessage: `Connecting via ${transport === 'http' ? 'Streamable HTTP' : 'SSE'}: ${url}`,
  }
}

export async function connectMCPClientWithAdapters<TClient, TTransport>(
  options: ConnectMCPClientWithAdaptersOptions<TClient, TTransport>,
): Promise<ConnectMCPClientResult<TClient, TTransport>> {
  const { adapters } = options
  const logger = toLogger(adapters.logger)
  const serverId = options.state.config.id

  if (options.state.status === 'connected') {
    logger.debug(`[MCP:${serverId}] Already connected`)
    return {
      state: options.state,
      client: options.client,
      transport: options.transport,
      alreadyConnected: true,
    }
  }

  let state = setMCPServerStatus(options.state, 'connecting')
  adapters.onStateChange?.(state)

  try {
    const plan = buildMCPTransportPlan(state.config, options.baseEnv)
    logger.debug(`[MCP:${serverId}] ${plan.logMessage}`)

    const transport = await adapters.createTransport(plan)
    const client = adapters.createClient()
    await withMCPTimeout(
      adapters.connectClient(client, transport),
      plan.timeoutMs,
      mcpConnectionTimeoutMessage(plan.timeoutMs),
    )

    const capabilities = await adapters.refreshCapabilities(serverId, client, logger)
    const protocolVersion = adapters.getNegotiatedProtocolVersion?.(client)
    state = markMCPServerConnected({
      ...state,
      tools: capabilities.tools,
      resources: capabilities.resources,
      prompts: capabilities.prompts,
      protocolVersion,
    }, (adapters.now ?? Date.now)())
    adapters.onStateChange?.(state)

    logger.debug(`[MCP:${serverId}] Connected successfully`)
    logger.debug(`[MCP:${serverId}] Tools: ${state.tools.length}, Resources: ${state.resources.length}, Prompts: ${state.prompts.length}`)
    return {
      state,
      client,
      transport,
      alreadyConnected: false,
    }
  } catch (error) {
    state = markMCPServerError(state, error)
    adapters.onStateChange?.(state)
    logger.error(`[MCP:${serverId}] Connection failed:`, undefined, error)
    throw error
  }
}

/**
 * P2-2 preflight probe ("server/discover" pre-check): connect a THROWAWAY
 * client to a candidate server and report what it actually is — negotiated
 * protocol revision, server identity, advertised capabilities — instead of
 * the old "add it and see". UnsupportedProtocolVersionError is parsed into
 * a structured `requiredProtocol` so the UI can say "此服务器要求协议 X".
 * State stores are untouched: nothing here persists anything.
 */
export interface CoreMCPProbeAdapters<TClient, TTransport> {
  createTransport(plan: CoreMCPTransportPlan): TTransport | Promise<TTransport>
  createClient(): TClient
  connectClient(client: TClient, transport: TTransport): Promise<void>
  closeClient(client: TClient): Promise<void>
  closeTransport(transport: TTransport): Promise<void>
  getNegotiatedProtocolVersion?(client: TClient): string | undefined
  getServerInfo?(client: TClient): { name?: string; version?: string } | undefined
  getServerCapabilities?(client: TClient): unknown
}

export interface CoreMCPProbeResult {
  ok: boolean
  protocolVersion?: string
  serverName?: string
  serverVersion?: string
  /** Advertised capability surface, e.g. ['tools(listChanged)','resources']. */
  capabilities?: string[]
  error?: string
  /** Set when the server demands a protocol revision we cannot speak. */
  requiredProtocol?: string
  /** Set when the server demands OAuth (the 401 path primed the flow). */
  authRequired?: boolean
}

const MCP_PROBE_TIMEOUT_MS = 15_000

function summarizeMCPProbeCapabilities(capabilities: unknown): string[] | undefined {
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) return undefined
  const summary: string[] = []
  for (const [key, value] of Object.entries(capabilities as Record<string, unknown>)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && (value as { listChanged?: unknown }).listChanged === true) {
      summary.push(`${key}(listChanged)`)
    } else {
      summary.push(key)
    }
  }
  return summary.length > 0 ? summary : undefined
}

export async function probeMCPServerWithAdapters<TClient, TTransport>(
  config: MCPServerConfig,
  baseEnv: Record<string, string | undefined>,
  adapters: CoreMCPProbeAdapters<TClient, TTransport>,
  injectedLogger?: CoreMCPLogger,
): Promise<CoreMCPProbeResult> {
  let client: TClient | undefined
  let transport: TTransport | undefined
  try {
    const plan = buildMCPTransportPlan(config, baseEnv)
    transport = await adapters.createTransport(plan)
    client = adapters.createClient()
    await withMCPTimeout(
      adapters.connectClient(client, transport),
      MCP_PROBE_TIMEOUT_MS,
      mcpConnectionTimeoutMessage(MCP_PROBE_TIMEOUT_MS),
    )

    const serverInfo = adapters.getServerInfo?.(client)
    return {
      ok: true,
      protocolVersion: adapters.getNegotiatedProtocolVersion?.(client),
      serverName: serverInfo?.name,
      serverVersion: serverInfo?.version,
      capabilities: summarizeMCPProbeCapabilities(adapters.getServerCapabilities?.(client)),
    }
  } catch (error) {
    const name = error && typeof error === 'object' ? (error as { name?: unknown }).name : undefined
    const message = errorMessage(error)
    if (name === 'UnsupportedProtocolVersionError') {
      const data = error && typeof error === 'object'
        ? (error as { data?: { supportedVersions?: unknown } }).data
        : undefined
      const supported = Array.isArray(data?.supportedVersions)
        ? data.supportedVersions.filter((v): v is string => typeof v === 'string')
        : []
      return {
        ok: false,
        error: message,
        requiredProtocol: supported[0] ?? message,
      }
    }
    if (name === 'UnauthorizedError' || /unauthorized/i.test(message)) {
      // The OAuth flow has been primed by the transport already — a probe
      // answering "login first" is a SUCCESS of the preflight's real job.
      return { ok: false, error: message, authRequired: true }
    }
    toLogger(injectedLogger).warn(`[MCP:${config.id}] Probe failed:`, undefined, error)
    return { ok: false, error: message }
  } finally {
    if (client) {
      try { await adapters.closeClient(client) } catch { /* probe best-effort */ }
    }
    if (transport) {
      try { await adapters.closeTransport(transport) } catch { /* probe best-effort */ }
    }
  }
}

export async function disconnectMCPClientWithAdapters<TClient, TTransport>(
  options: DisconnectMCPClientWithAdaptersOptions<TClient, TTransport>,
): Promise<DisconnectMCPClientResult> {
  const logger = toLogger(options.adapters.logger)
  const serverId = options.state.config.id

  if (options.client) {
    try {
      await options.adapters.closeClient(options.client)
    } catch (error) {
      logger.warn(`[MCP:${serverId}] Error during disconnect:`, undefined, error)
    }
  }

  if (options.transport) {
    try {
      await options.adapters.closeTransport(options.transport)
    } catch (error) {
      logger.warn(`[MCP:${serverId}] Error closing transport:`, undefined, error)
    }
  }

  const state = markMCPServerDisconnected(options.state)
  logger.debug(`[MCP:${serverId}] Disconnected`)
  return {
    state,
    client: null,
    transport: null,
  }
}

export async function updateMCPClientConfigWithAdapters<TClient, TTransport>(
  options: UpdateMCPClientConfigWithAdaptersOptions<TClient, TTransport>,
): Promise<UpdateMCPClientConfigResult<TClient, TTransport>> {
  const wasConnected = options.state.status === 'connected'
  // Converge to the state the config asks for, not to the one we happen to be
  // in. Mirroring the current state meant a client that existed but was not
  // connected never reconnected: toggling a server off and back on, or fixing a
  // wrong command after a failed connect, left it disconnected/red until the
  // user manually hit reconnect (the manager keeps the client in its map after
  // a disconnect, so the "no client yet -> connect" path did not catch it).
  const shouldConnect = options.config.enabled
  let state = options.state
  let client = options.client
  let transport = options.transport

  if (wasConnected) {
    const disconnected = await disconnectMCPClientWithAdapters({
      state,
      client,
      transport,
      adapters: options.adapters,
    })
    state = disconnected.state
    client = disconnected.client
    transport = disconnected.transport
  }

  state = {
    ...state,
    config: options.config,
  }

  if (shouldConnect) {
    try {
      const connected = await connectMCPClientWithAdapters({
        state,
        client,
        transport,
        baseEnv: options.baseEnv,
        adapters: options.adapters,
      })
      return {
        state: connected.state,
        client: connected.client,
        transport: connected.transport,
        wasConnected,
        reconnected: !connected.alreadyConnected,
      }
    } catch (error) {
      // A failed reconnect must not fail the config update itself — the new
      // config is already persisted by the caller, so throwing here would
      // report "save failed" for a save that actually happened. Surface it as
      // server state instead; connectMCPClientWithAdapters has already pushed
      // the error through onStateChange.
      return {
        state: markMCPServerError(state, error),
        client: null,
        transport: null,
        wasConnected,
        reconnected: false,
      }
    }
  }

  return {
    state,
    client,
    transport,
    wasConnected,
    reconnected: false,
  }
}

export function normalizeMCPToolInfos(serverId: string, tools: unknown): MCPToolInfo[] {
  if (!Array.isArray(tools)) return []
  return tools.flatMap(tool => {
    const normalized = normalizeMCPToolInfo(serverId, tool)
    return normalized ? [normalized] : []
  })
}

export function normalizeMCPToolInfo(serverId: string, tool: RawMCPTool | unknown): MCPToolInfo | null {
  if (!tool || typeof tool !== 'object') return null
  const raw = tool as RawMCPTool
  if (typeof raw.name !== 'string' || !raw.name.trim()) return null

  return {
    name: raw.name,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    inputSchema: { ...toJsonSchemaObject(raw.inputSchema || { type: 'object' }), type: 'object' },
    serverId,
  }
}

export function normalizeMCPResourceInfos(serverId: string, resources: unknown): MCPResourceInfo[] {
  if (!Array.isArray(resources)) return []
  return resources.flatMap(resource => {
    const normalized = normalizeMCPResourceInfo(serverId, resource)
    return normalized ? [normalized] : []
  })
}

export function normalizeMCPResourceInfo(serverId: string, resource: RawMCPResource | unknown): MCPResourceInfo | null {
  if (!resource || typeof resource !== 'object') return null
  const raw = resource as RawMCPResource
  if (raw.uri === undefined) return null

  return {
    uri: String(raw.uri),
    name: typeof raw.name === 'string' ? raw.name : String(raw.uri),
    description: typeof raw.description === 'string' ? raw.description : undefined,
    mimeType: typeof raw.mimeType === 'string' ? raw.mimeType : undefined,
    serverId,
  }
}

export function normalizeMCPPromptInfos(serverId: string, prompts: unknown): MCPPromptInfo[] {
  if (!Array.isArray(prompts)) return []
  return prompts.flatMap(prompt => {
    const normalized = normalizeMCPPromptInfo(serverId, prompt)
    return normalized ? [normalized] : []
  })
}

export function normalizeMCPPromptInfo(serverId: string, prompt: RawMCPPrompt | unknown): MCPPromptInfo | null {
  if (!prompt || typeof prompt !== 'object') return null
  const raw = prompt as RawMCPPrompt
  if (typeof raw.name !== 'string' || !raw.name.trim()) return null

  return {
    name: raw.name,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    arguments: normalizeMCPPromptArguments(raw.arguments),
    serverId,
  }
}

export function normalizeMCPPromptArguments(args: unknown): MCPPromptInfo['arguments'] {
  if (!Array.isArray(args)) return undefined
  return args.flatMap(arg => {
    if (!arg || typeof arg !== 'object') return []
    const record = arg as { name?: unknown; description?: unknown; required?: unknown }
    if (typeof record.name !== 'string' || !record.name.trim()) return []
    return [{
      name: record.name,
      description: typeof record.description === 'string' ? record.description : undefined,
      required: record.required === true,
    }]
  })
}

export function normalizeMCPToolCallSuccessResult(raw: RawMCPToolCallResult | unknown): MCPToolCallResult {
  const record: Record<string, unknown> = raw && typeof raw === 'object'
    ? raw as Record<string, unknown>
    : {}
  const structuredContent = toJsonValue((record as { structuredContent?: unknown }).structuredContent)
  const content = normalizeMCPContent(Array.isArray(record.content)
    ? record.content.filter((item): item is object => item !== null && typeof item === 'object')
    : undefined)
  // P2-4 Tasks defense: see mcpTaskHandleNotice below.
  const taskNotice = mcpTaskHandleNotice(record)
  return {
    success: true,
    content: taskNotice
      ? [{ type: 'text' as const, text: taskNotice }, ...(content ?? [])]
      : content,
    ...(structuredContent !== undefined ? { structuredContent } : {}),
    isError: taskNotice ? true : record.isError === true,
  }
}

/**
 * P2-4 Tasks defense: a server may answer `tools/call` with an uninvited
 * task handle — either a `task` object on the result or the
 * `io.modelcontextprotocol/related-task` marker in `_meta`. Without this
 * guard the handle was silently dropped (or worse, JSON-stringified into
 * the transcript), and the model believed the call had FINISHED when it
 * had only been ACCEPTED. Render a readable notice instead, marked as an
 * error so nothing downstream treats the outcome as final.
 */
export function mcpTaskHandleNotice(record: Record<string, unknown>): string | undefined {
  const handle = mcpTaskHandleFromResult(record)
  if (!handle) return undefined
  const statusPart = handle.status
    ? ` (status: ${handle.status}${handle.statusMessage ? ` — ${handle.statusMessage}` : ''})`
    : ''
  return (
    `[MCP task handle: the server accepted this call as background task "${handle.taskId}"${statusPart}, `
    + 'but does not advertise task-polling support (capabilities.tasks.requests.tools.call), '
    + 'so the eventual result will NOT arrive on its own — '
    + 'treat the operation as accepted-but-unresolved, not finished.]'
  )
}

export function normalizeMCPResourceReadContent(contents: unknown): JsonValue | undefined {
  return toJsonValue(contents)
}

export function normalizeMCPPromptMessages(messages: unknown): JsonArray | undefined {
  const value = toJsonValue(messages)
  return Array.isArray(value) ? value : undefined
}

export async function refreshMCPClientCapabilities(
  serverId: string,
  client: Pick<CoreMCPClientOperations, 'listTools' | 'listResources' | 'listPrompts'>,
  logger?: CoreMCPLogger,
): Promise<CoreMCPRefreshCapabilitiesResult> {
  let tools: MCPToolInfo[] = []
  let resources: MCPResourceInfo[] = []
  let prompts: MCPPromptInfo[] = []

  try {
    const toolsResult = await client.listTools()
    tools = normalizeMCPToolInfos(serverId, toolsResult.tools)
  } catch (error) {
    toLogger(logger).warn(`[MCP:${serverId}] Failed to list tools:`, undefined, error)
  }

  try {
    const resourcesResult = await client.listResources()
    resources = normalizeMCPResourceInfos(serverId, resourcesResult.resources)
  } catch (error) {
    toLogger(logger).warn(`[MCP:${serverId}] Failed to list resources:`, undefined, error)
  }

  try {
    const promptsResult = await client.listPrompts()
    prompts = normalizeMCPPromptInfos(serverId, promptsResult.prompts)
  } catch (error) {
    toLogger(logger).warn(`[MCP:${serverId}] Failed to list prompts:`, undefined, error)
  }

  return { tools, resources, prompts }
}

export async function withMCPTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export interface CoreMCPTaskFollowOptions {
  /** Poll budget for the task phase (default 10 min — see tasks.ts). */
  taskTimeoutMs?: number
  taskIntervalMs?: number
  signal?: AbortSignal
  onTaskStatus?: (task: CoreMCPTask, pollIndex: number) => void
}

/**
 * P3-1: a tools/call answered with a task handle is accepted-NOT-finished.
 * When the server advertises task support, follow the handle: poll
 * `tasks/get` to a terminal state, then `tasks/result` for the real payload.
 * Terminal failures surface as an isError result (the call itself succeeded
 * — the tool's work failed); local budget/abort surfaces as success:false.
 */
async function followMCPToolTask(
  client: Pick<CoreMCPClientOperations, 'getMCPTask' | 'getMCPTaskPayload' | 'cancelMCPTask'>,
  handle: CoreMCPTaskHandle,
  options?: CoreMCPTaskFollowOptions,
): Promise<MCPToolCallResult> {
  const initialTask: CoreMCPTask = {
    taskId: handle.taskId,
    // The handle may omit status or carry an already-terminal one; the poll
    // loop treats anything non-terminal as "keep polling" and refreshes via
    // tasks/get, so an unknown value here is safe.
    status: handle.status && mcpTaskIsTerminal(handle.status)
      ? handle.status as CoreMCPTask['status']
      : 'working',
    ...(handle.statusMessage ? { statusMessage: handle.statusMessage } : {}),
  }
  try {
    const outcome = await pollMCPTaskWithAdapters(initialTask, {
      getTask: taskId => client.getMCPTask!(taskId),
      getTaskPayload: taskId => client.getMCPTaskPayload!(taskId),
      cancelTask: taskId => client.cancelMCPTask!(taskId),
    }, {
      ...(options?.taskTimeoutMs !== undefined ? { timeoutMs: options.taskTimeoutMs } : {}),
      ...(options?.taskIntervalMs !== undefined ? { defaultIntervalMs: options.taskIntervalMs } : {}),
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.onTaskStatus ? { onStatus: options.onTaskStatus } : {}),
    })
    const provenance = mcpTaskProvenanceText(outcome)
    if (outcome.kind === 'completed') {
      // The payload is the original CallToolResult; normalize it like a
      // direct answer (a nested task handle inside still gets the P2-4
      // notice rather than a recursive follow — one level is enough).
      const normalized = normalizeMCPToolCallSuccessResult(outcome.payload)
      return {
        success: true,
        content: [{ type: 'text' as const, text: provenance }, ...(normalized.content ?? [])],
        ...(normalized.structuredContent !== undefined ? { structuredContent: normalized.structuredContent } : {}),
        isError: normalized.isError,
      }
    }
    if (outcome.kind === 'timeout' || outcome.kind === 'aborted') {
      return { success: false, error: provenance }
    }
    return { success: true, isError: true, content: [{ type: 'text' as const, text: provenance }] }
  } catch (error) {
    return { success: false, error: `MCP task "${handle.taskId}" follow-up failed: ${errorMessage(error)}` }
  }
}

export async function callMCPToolWithTimeout(
  client: Pick<CoreMCPClientOperations, 'callTool' | 'getMCPTask' | 'getMCPTaskPayload' | 'cancelMCPTask' | 'supportsMCPTasks'>,
  toolName: string,
  args: JsonObject,
  timeoutMs: number,
  toolDefinition?: { name: string; description?: string; inputSchema?: unknown },
  taskOptions?: CoreMCPTaskFollowOptions,
): Promise<MCPToolCallResult> {
  // Abort-driven, not a Promise.race: a raced timeout would resolve locally
  // while the server keeps running the tool — and the serialized call queue
  // (client-runtime) would release the lock onto a transport that still has
  // an in-flight request. Aborting instead makes the SDK reject the request
  // AND tell the server (Streamable HTTP: per-request stream abort; stdio /
  // SSE: `notifications/cancelled`), so the lock releases only when the call
  // is actually dead.
  const timeoutMessage = mcpToolCallTimeoutMessage(toolName, timeoutMs)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(timeoutMessage)), timeoutMs)
  try {
    const result = await client.callTool(
      {
        name: toolName,
        arguments: args,
      },
      { signal: controller.signal, ...(toolDefinition ? { toolDefinition } : {}) },
    )
    // P3-1: task handles are followed (polled) when the server advertises
    // task support; otherwise the P2-4 notice path stays as-is.
    const handle = result && typeof result === 'object' && !Array.isArray(result)
      ? mcpTaskHandleFromResult(result as Record<string, unknown>)
      : undefined
    const canFollow = handle !== undefined
      && client.supportsMCPTasks?.() === true
      && typeof client.getMCPTask === 'function'
      && typeof client.getMCPTaskPayload === 'function'
      && typeof client.cancelMCPTask === 'function'
    if (handle && canFollow) {
      return await followMCPToolTask(client, handle, taskOptions)
    }
    return normalizeMCPToolCallSuccessResult(result)
  } catch (error) {
    if (controller.signal.aborted) {
      return { success: false, error: timeoutMessage }
    }
    return {
      success: false,
      error: errorMessage(error),
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function readMCPResource(
  client: Pick<CoreMCPClientOperations, 'readResource'>,
  uri: string,
): Promise<{ success: boolean; content?: JsonValue; error?: string }> {
  try {
    const result = await client.readResource({ uri })
    return {
      success: true,
      content: normalizeMCPResourceReadContent(result.contents),
    }
  } catch (error) {
    return {
      success: false,
      error: mcpResourceReadErrorMessage(error, uri),
    }
  }
}

/**
 * Error-code alignment: the spec says a missing resource is reported as
 * JSON-RPC `-32602` (Invalid params). Surface that as "not found" instead
 * of the raw code dump.
 */
function mcpResourceReadErrorMessage(error: unknown, uri: string): string {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
  if (code === -32602) {
    return `Resource not found: ${uri}`
  }
  return errorMessage(error)
}

export async function getMCPPromptMessages(
  client: Pick<CoreMCPClientOperations, 'getPrompt'>,
  name: string,
  args?: Record<string, string>,
): Promise<{ success: boolean; messages?: JsonArray; error?: string }> {
  try {
    const result = await client.getPrompt({ name, arguments: args })
    return {
      success: true,
      messages: normalizeMCPPromptMessages(result.messages),
    }
  } catch (error) {
    return {
      success: false,
      error: errorMessage(error),
    }
  }
}
