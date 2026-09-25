import type {
  ContentBlock,
  CreateElicitationRequest,
  CreateElicitationResponse,
  McpServer,
  SessionNotification,
  StopReason,
} from '@agentclientprotocol/sdk'
import type { AgentUsage } from '@onething/core/agent-loop'
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
  AcpAgentAuth,
  AcpAgentSource,
  AcpAuthMethod,
  AcpReconnectBackoff,
  AcpRemoteSessionInfo,
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
  AcpAgentAuth,
  AcpAgentSource,
  AcpAuthMethod,
  AcpReconnectBackoff,
  AcpRemoteSessionInfo,
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
  /**
   * 这条会话的 persona(A2-a,方案 §3.4)。ACP 协议正文没有 system 位,所以它只送一次:
   * 客户端在「这条 agent 会话是刚 `session/new` 出来、还一轮都没跑过」时把它折成第一个
   * `text` 块 `<persona>…</persona>`;恢复(load / resume)的会话 agent 自己有历史,不再送;
   * manifest 标了 `quirks.systemPromptMeta` 的 agent 已在 `session/new` 的 `_meta` 里收过,也不再送。
   */
  persona?: string
}

/**
 * 开会话时顺带递进去的东西。persona(A2-a):走 `_meta` 的那一档要在 `session/new` 时就给;
 * mcpServers(A4-b):宿主现组的 MCP 名册(`onething` 宿主工具面 + 透传的用户名册)。
 */
export interface ACPOpenSessionOptions {
  persona?: string
  /**
   * 进 `session/new` / `load` / `resume` 的 `mcpServers`。缺席 = 这一次没人组(选项面板那类
   * 只为读选项而开的会话)→ 递空表,且下一次带着名册来开时**重开一次**(经 load / resume
   * 沿用 agent 会话),否则那条会话就永远没有宿主工具。给了(哪怕空表)= 这就是名册。
   */
  mcpServers?: McpServer[]
}

export interface ACPPermissionOptionInfo {
  optionId: string
  name: string
  kind: string
}

export interface ACPPermissionRequestContext {
  agentId: string
  agentName: string
  /**
   * 这台 agent 的无人值守策略(A3-b)。`'allow'` = 用户在设置里显式打开了「无人应答时自动放行」,
   * 桥据它**前置放行**、不进 ask;缺席 / `'reject'` = 照常上卡,没人答由许可系统的兜底拒。
   */
  unattended?: ACPUnattendedPolicy
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
      /** 已折成引擎的形状(`acp/usage.ts`):思考 / 缓存两格、这一轮的报价与账本类目都在里面。 */
      usage?: AgentUsage
    }

// ── agent 向我们要文件与终端(A3-b,方案 §3.5 / §11.3)──────────────────────────────

/**
 * 一条 `fs/*` / `terminal/*` 请求是谁发的、落在哪条会话里。客户端从在飞的 prompt(或开着的会话)
 * 算出来;算不出本地会话的请求根本到不了桥 —— 客户端当场拒,没人看得见那张卡。
 */
export interface AcpClientRequestContext {
  agentId: string
  agentName: string
  localSessionId: string
  /** 这一轮的助手消息号;卡片按它锚(缺席 = 兜底锚)。 */
  messageId?: string
  /** 会话目录(绝对路径);相对路径按它解析,沙箱根也从它起。 */
  cwd: string
  unattended?: ACPUnattendedPolicy
}

/**
 * 宿主注入的文件桥。读写都走 onething 自己的沙箱与许可:根内读静默、根外 / 敏感文件问一次,
 * 写一律按 `file_write` / `file_edit` 问(卡上带 diff),写完落一条 `tool/audit`。
 * 拒绝 = 抛一个 `Error`,message 是给 agent 看的一句人话;文件不存在抛带 `code: 'ENOENT'` 的错。
 */
export interface AcpFsBridge {
  readTextFile(
    context: AcpClientRequestContext,
    params: { path: string; line?: number | null; limit?: number | null },
  ): Promise<{ content: string }>
  writeTextFile(context: AcpClientRequestContext, params: { path: string; content: string }): Promise<void>
}

/** ACP `TerminalExitStatus` 的形状(信号是名字,不是号)。 */
export interface AcpTerminalExitStatus {
  exitCode?: number | null
  signal?: string | null
}

/**
 * 宿主注入的终端桥:agent 的命令跑在 onething 的 `TerminalService` 里(owner = 这台 agent),
 * 所以壳的终端列表里看得见、进得去。`available()` 答「这台宿主有没有终端输出通道」——
 * 没有就不声明 `terminal` 能力、不挂这五个方法。
 */
export interface AcpTerminalBridge {
  available(): boolean
  create(
    context: AcpClientRequestContext,
    params: {
      command: string
      args?: string[]
      env?: Record<string, string>
      cwd?: string | null
      outputByteLimit?: number | null
    },
  ): Promise<{ terminalId: string }>
  output(
    context: AcpClientRequestContext,
    params: { terminalId: string },
  ): Promise<{ output: string; truncated: boolean; exitStatus?: AcpTerminalExitStatus | null }>
  waitForExit(context: AcpClientRequestContext, params: { terminalId: string }): Promise<AcpTerminalExitStatus>
  kill(context: AcpClientRequestContext, params: { terminalId: string }): Promise<void>
  release(context: AcpClientRequestContext, params: { terminalId: string }): Promise<void>
}

// ── 登录与提问(A3-c,方案 §3.5 / §11.3)──────────────────────────────────────────

/**
 * 宿主注入的登录桥。客户端只用它决定握手里声明不声明 `auth.terminal`:注入了、且这台宿主
 * 有终端可用(`terminalAvailable()`)才声明 —— agent 只在客户端声明了终端登录时才自报终端型
 * 方法(协议原话:Agents MUST advertise this method only when the client enabled it)。
 * 「去登录」本身由装配层的 `acp.authenticate` 调它,不经客户端。
 */
export interface AcpAuthBridge {
  terminalAvailable(): boolean
  authenticate(agentId: string, methodId: string): Promise<AcpAuthenticateOutcome>
}

export type AcpAuthenticateOutcome =
  | { ok: true; terminalId?: string }
  | { ok: false; code: 'unavailable' | 'no-terminal' | 'unknown-agent' | 'unknown-method' | 'failed'; error: string }

/** SDK 的 `elicitation/create` 形状原样交给桥(产品层与装配层共用这一份,不另抄)。 */
export type AcpElicitationRequest = CreateElicitationRequest
export type AcpElicitationResponse = CreateElicitationResponse

/** 提问的归属:同 {@link AcpClientRequestContext},外加这一轮的中止信号(回合停了,卡跟着收)。 */
export interface AcpElicitationContext extends AcpClientRequestContext {
  abortSignal?: AbortSignal
}

/**
 * 宿主注入的提问桥:agent 的 `elicitation/create` 落成 onething 的交互卡(`Interaction.ask`)。
 * 注入了才声明 `elicitation: { form: {}, url: {} }`、才挂这两个方法 —— 声明了却答
 * method-not-found 比不声明更糟。`complete` 是 agent 发来的 `elicitation/complete`
 * 通知(url 型那一格在 agent 那边走完了)。
 */
export interface AcpElicitationBridge {
  create(context: AcpElicitationContext, request: AcpElicitationRequest): Promise<AcpElicitationResponse>
  complete(agentId: string, elicitationId: string): void
}
