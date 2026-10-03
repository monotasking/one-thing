import type { JsonObject, JsonSchemaObject, JsonValue } from '../json.js'

export type MCPTransportType = 'stdio' | 'sse' | 'http'

export interface MCPServerConfig {
  id: string
  name: string
  transport: MCPTransportType
  enabled: boolean
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
}

export type MCPConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface MCPServerState {
  config: MCPServerConfig
  status: MCPConnectionStatus
  error?: string
  tools: MCPToolInfo[]
  resources: MCPResourceInfo[]
  prompts: MCPPromptInfo[]
  connectedAt?: number
  /**
   * Protocol revision negotiated with the server (e.g. `2026-07-28`,
   * `2025-11-25`). Populated after a successful connect when the SDK-level
   * client reports one; cleared on disconnect. Surfaced in the UI so a user
   * can tell a legacy server from a modern one.
   */
  protocolVersion?: string
  /**
   * OAuth surface for the settings UI. `required` carries the authorization
   * URL the user must open to log in; `authorized` carries the issuer we
   * hold credentials for. Merged at read time by the app-layer manager.
   */
  oauth?: MCPServerOAuthState
}

export interface MCPServerOAuthState {
  status: 'required' | 'authorized'
  authorizationUrl?: string
  issuer?: string
}

export interface MCPToolInfo {
  name: string
  description?: string
  inputSchema: {
    type: 'object'
    properties?: Record<string, JsonSchemaObject>
    required?: string[]
  }
  serverId: string
}

export interface MCPResourceInfo {
  uri: string
  name: string
  description?: string
  mimeType?: string
  serverId: string
}

export interface MCPPromptInfo {
  name: string
  description?: string
  arguments?: Array<{
    name: string
    description?: string
    required?: boolean
  }>
  serverId: string
}

export interface MCPToolCallRequest {
  serverId: string
  toolName: string
  arguments: JsonObject
}

export interface MCPToolCallResult {
  success: boolean
  content?: Array<{
    type: 'text' | 'image' | 'audio' | 'resource' | 'resource_link'
    text?: string
    data?: string
    mimeType?: string
    /** Embedded-resource / resource_link target. */
    uri?: string
    /** resource_link display name / description. */
    name?: string
    description?: string
  }>
  /**
   * SEP-2106 structured tool output, passed through untouched (any JSON).
   * Tools with an outputSchema put their machine-readable result here; the
   * `content` array stays the human-readable rendering of the same call.
   */
  structuredContent?: JsonValue
  /**
   * Readable rendering of `content`, with binary parts summarised.
   *
   * The agent loop turns a tool result into message text via `toolOutputToText`,
   * which falls back to `JSON.stringify(data)` unless the payload carries an
   * `output` string. Without this field an image part's base64 was stringified
   * into the tool message *in addition to* being attached as a real image part
   * — the same payload billed twice.
   */
  output?: string
  error?: string
  isError?: boolean
}

export interface MCPSettings {
  enabled: boolean
  servers: MCPServerConfig[]
  /**
   * Hybrid flat-mode threshold (roadmap 决策点 #1): when the total number of
   * connected MCP tools is at or below this count, each tool is exposed to
   * the model as its own definition (deterministic order, prompt-cache
   * friendly) and the `mcp_search` router is hidden; above it, only the
   * router is exposed (the degradation path for large tool sets).
   * `0` = always router (the pre-hybrid behavior). Undefined = default.
   */
  flatToolThreshold?: number
}

/** Default flat-mode threshold when settings do not specify one. */
export const MCP_DEFAULT_FLAT_TOOL_THRESHOLD = 20

export const DEFAULT_MCP_SETTINGS: MCPSettings = {
  enabled: true,
  servers: [],
  flatToolThreshold: MCP_DEFAULT_FLAT_TOOL_THRESHOLD,
}

/** 一次连通性探测的答复(`mcp` 域的契约里有它;探测本身在后端 `mcp/kernel/client-state.ts`)。 */
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
