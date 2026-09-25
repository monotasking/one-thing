/**
 * ACP agent 配置与会话选项的形状(A0-3:只此一份)。
 *
 * 产品层 `runtime/src/acp/types.ts` 与契约层 `shared/ipc/acp.ts` 都 `import type` 这里:
 * 契约层不许依赖产品层,产品层(非 `*.wiring.ts`)不许 import `@shared/ipc`,
 * 两边都够得着、又不反向依赖的只有 `@shared/contracts`。
 */
import type { JsonObject } from '../json.js'

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
  /**
   * 缺席 = `select`(A0-3 之前的形状只有这一种,旧读者不必改)。`boolean` 只出现在会话状态
   * (`AcpSessionState.configOptions`)里:`currentValue` 是 `'true'` / `'false'`,`choices` 恒为这两格。
   */
  type?: 'select' | 'boolean'
  description?: string
  /** ACP 的 `category`:`model` / `mode` / `thought_level` / 扩展值。只是提示,不是判据。 */
  category?: string
  currentValue: string
  choices: ACPSessionOptionChoice[]
}

export type ACPConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

/**
 * 一台 agent 的连接状态投影(`acp.getAgents` 的行,也是全局事件 `acp:agent-state` 的载荷)。
 * A0-2 从 runtime / `@shared/ipc` 两份合到这里,理由同上:全局事件的类型住 `@shared/events`,
 * 它够不着产品层。
 */
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
  /**
   * agent 在 `initialize` 里自报的 `agentCapabilities`,原样交出(A0-4,方案 §6)。
   * 契约层不 import ACP SDK,于是按 JSON 收;读的人要逐字比对或按键取值,不需要 SDK 的类型。
   * 未连过 = 缺席。
   */
  capabilities?: JsonObject
  sessionCount: number
  activePromptCount: number
}

// ── 会话级状态(A0-2,方案 `docs/design/acp-integration-2026-09.md` §3.3)──────────

export interface AcpSessionMode {
  id: string
  name: string
  description?: string
}

export interface AcpSessionCommand {
  name: string
  description: string
  inputHint?: string
}

export interface AcpPlanEntry {
  content: string
  priority: 'high' | 'medium' | 'low'
  status: 'pending' | 'in_progress' | 'completed'
}

/**
 * agent 的计划。`planId` 是 §3.3 形状之外多出的一格:`plan_removed` 带着 id 来,
 * 不记 id 就分不清它删的是不是眼前这一份。旧式整份 `plan` 没有 id,于是缺席。
 */
export type AcpSessionPlan =
  | { kind: 'items'; planId?: string; entries: AcpPlanEntry[] }
  | { kind: 'markdown'; planId?: string; markdown: string }
  | { kind: 'file'; planId?: string; path: string }

export interface AcpSessionNotice {
  severity: 'info' | 'warning' | 'error'
  title: string
  description?: string
  at: number
}

export interface AcpSessionProcess {
  status: ACPConnectionStatus
  error?: string
  pid?: number
}

/**
 * 一条 ACP 会话**此刻的状态**:与哪条消息无关、agent 可以在没有 prompt 在飞时推来的那些
 * (模式 / 可用命令 / 选项 / 计划 / 用量 / 标题 / 通知 / 压缩),加上承载它的进程。
 * 回合里说了什么(文本 / 思考 / 工具)不在这里,那是回合事件流。
 *
 * 形状住契约层:产品层的 reducer(`runtime/src/acp/session-state.ts`)产出它,
 * 全局事件 `acp:session-state` 与 RPC `acp.sessionState` 原样交出它。
 */
export interface AcpSessionState {
  localSessionId: string
  agentId: string
  acpSessionId?: string
  modes?: { current: string; available: AcpSessionMode[] }
  configOptions: ACPSessionOption[]
  commands: AcpSessionCommand[]
  plan?: AcpSessionPlan
  usage?: { used: number; size: number; cost?: { amount: number; currency: string } }
  info?: { title?: string; updatedAt?: string }
  /** 最近 20 条,新的在后。 */
  notices: AcpSessionNotice[]
  compaction?: { status: 'in_progress' | 'done'; startedAt: number }
  process: AcpSessionProcess
}
