import type {
  SessionNotification,
  StopReason,
} from '@agentclientprotocol/sdk'
import type { JsonObject } from '@onething/core'

export type ACPConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export type ACPPermissionMode = 'allow' | 'reject'

export interface ACPAgentConfig {
  id: string
  name: string
  description?: string
  enabled: boolean
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  model?: string
  permissionMode?: ACPPermissionMode
  allowFileSystemAccess?: boolean
  allowTerminalAccess?: boolean
  mcpServers?: JsonObject[]
  connectTimeoutMs?: number
  promptTimeoutMs?: number
  idleTimeoutMs?: number
  maxBufferedUpdates?: number
  maxSessionRecords?: number
  maxTerminals?: number
  maxTerminalOutputBytes?: number
}

export interface ACPAgentState {
  config: ACPAgentConfig
  status: ACPConnectionStatus
  error?: string
  connectedAt?: number
  lastUsedAt?: number
  pid?: number
  protocolVersion?: number
  agentInfo?: {
    name?: string
    version?: string
  }
  sessionCount: number
  activePromptCount: number
}

export interface ACPSettings {
  enabled: boolean
  agents: ACPAgentConfig[]
}

/**
 * 一台 agent 在**它自己的会话里**自述的一格可调选项(ACP `configOptions`:模型 / 模式 /
 * 思考档……)。onething 不认识「模型」这件事 —— agent 列什么就画什么,选中后原样经
 * `session/set_config_option` 交回去。只收 `select` 那一种;分组的选项在投影时拍平,
 * 组名落进 `group`。
 */
export interface ACPSessionOptionChoice {
  value: string
  name: string
  description?: string
  group?: string
}

export interface ACPSessionOption {
  id: string
  name: string
  description?: string
  /** ACP 的 `category`:`model` / `mode` / `thought_level` / 扩展值。只是提示,不是判据。 */
  category?: string
  currentValue: string
  choices: ACPSessionOptionChoice[]
}

/** `getSessionOptions` 的答案:`live` = 来自一个真开着的 agent 会话;否则是上次记下的目录。 */
export interface ACPSessionOptionsSnapshot {
  options: ACPSessionOption[]
  live: boolean
}

export interface ACPPromptStreamOptions {
  localSessionId: string
  prompt: string
  cwd: string
  abortSignal?: AbortSignal
  /** Assistant message the prompt streams into; threads through to permission asks. */
  messageId?: string
}

export interface ACPPermissionOptionInfo {
  optionId: string
  name: string
  kind: string
}

export interface ACPPermissionRequestContext {
  agentId: string
  agentName: string
  /** onething session that owns the active prompt, when attributable. */
  localSessionId?: string
  messageId?: string
  cwd?: string
  toolCall?: {
    toolCallId?: string
    title?: string
    kind?: string
    rawInput?: unknown
  }
  options: ACPPermissionOptionInfo[]
}

export type ACPPermissionDecision =
  | { behavior: 'allow' }
  | { behavior: 'reject' }
  | { behavior: 'select'; optionId: string }
  | { behavior: 'cancel' }

/**
 * Host-injected bridge for ACP permission prompts. When registered, every
 * agent-initiated permission request is routed here instead of being
 * auto-resolved from `permissionMode`; hosts without an interactive surface
 * (headless server) simply leave it unregistered to keep the old behavior.
 */
export type ACPPermissionBridge = (
  context: ACPPermissionRequestContext,
) => Promise<ACPPermissionDecision>

export type ACPPromptStreamEvent =
  | { type: 'update'; notification: SessionNotification }
  | { type: 'warning'; message: string }
  | {
      type: 'finish'
      stopReason: StopReason
      usage?: {
        inputTokens: number
        outputTokens: number
        totalTokens: number
      }
    }
