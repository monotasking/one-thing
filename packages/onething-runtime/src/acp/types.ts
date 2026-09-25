import type {
  ContentBlock,
  SessionNotification,
  StopReason,
} from '@agentclientprotocol/sdk'
import type {
  ACPAgentConfig,
  ACPAgentState,
  ACPConnectionStatus,
  ACPPermissionMode,
  ACPUnattendedPolicy,
  ACPSessionOption,
  ACPSessionOptionChoice,
  ACPSettings,
  AcpAgentDetect,
  AcpAgentManifest,
  AcpAgentSource,
  AcpSessionState,
} from '@shared/contracts/acp.js'

// agent 配置、连接状态、会话选项与会话状态的形状住在 `@shared/contracts/acp.ts`,
// 契约层、全局事件与产品层共用这一份。
export type {
  ACPAgentConfig,
  ACPAgentState,
  ACPConnectionStatus,
  ACPPermissionMode,
  ACPUnattendedPolicy,
  ACPSessionOption,
  ACPSessionOptionChoice,
  ACPSettings,
  AcpAgentDetect,
  AcpAgentManifest,
  AcpAgentSource,
  AcpSessionState,
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
    /** agent 声明的受影响位置(`ToolCallLocation`);效果分析按路径判时先看它。 */
    locations?: Array<{ path: string; line?: number }>
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
 * auto-resolved from `unattended`(缺省拒,A3-a);没挂桥的宿主走那条无人值守兜底。
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
