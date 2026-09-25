import type {
  ContentBlock,
  SessionNotification,
  StopReason,
} from '@agentclientprotocol/sdk'
import type {
  ACPAgentConfig,
  ACPPermissionMode,
  ACPSessionOption,
  ACPSessionOptionChoice,
} from '@shared/contracts/acp.js'

// agent 配置与会话选项的形状住在 `@shared/contracts/acp.ts`,契约层与产品层共用这一份。
export type { ACPAgentConfig, ACPPermissionMode, ACPSessionOption, ACPSessionOptionChoice }

export type ACPConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

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
  /** 跟在文本后面的内容块(图片等);只有握手声明接得住的 agent 才会收到。 */
  extraContent?: ContentBlock[]
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
