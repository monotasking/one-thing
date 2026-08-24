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
