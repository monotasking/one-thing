import { defineRouter } from './router.js'
import type { PermissionMode } from './tools.js'

export const DEFAULT_AGENT_ID = 'default'

/** Per-agent model binding. Applied as a per-command override on drives
 *  (radio-DJ pattern) — never consulted by getEffectiveProviderConfig. */
export interface AgentModelBinding {
  providerId?: string
  modelId?: string
  thinking?: string
}

/**
 * Agent 分类(域模型 M2,docs/design/agent-domain-model.md §3.1)。
 * - `colleague`(缺省):人格化同事——进联系人、可私聊、可进群、有履历。
 * - `service`:后台设施角色(radio-dj 等)。有身份面(日志/账单里要认得出),
 *   无社交面:不进联系人、不可被 dm、不进 roster 候选、AgentSelector 不列。
 */
export type AgentKind = 'colleague' | 'service'

/**
 * Agent 生命周期(域模型 M3)。UI 的「删除」= 退休:身份面永久保留(墓碑),
 * 退出联系人/roster 候选/激活目标。缺省视为 `active`。
 * A0 只定义类型;退休行为矩阵(§3.2)在 A2 落地。
 */
export type AgentStatus = 'active' | 'retired'

/**
 * 心智面的驱动方(域模型 M7,前瞻)。缺省视为 `{ type: 'native' }`(本引擎驱动)。
 * `external` 指外部执行体连接器(如 ClaudeCodeConnector 'claude-code-agent')——
 * 身份/能力面共用,只有心智面的驱动方式不同。A0 只定义语义,不接线任何行为。
 */
export type AgentExecutor =
  | { type: 'native' }
  | { type: 'external'; connectorId: string }

export interface AgentDefinition {
  id: string
  name: string
  systemPrompt: string
  /** Tool allowlist (tool ids). Absent = agent sees all enabled tools. */
  tools?: string[]
  isDefault?: boolean
  createdAt: number
  updatedAt: number
  /** Job title shown in rosters/signatures, e.g. '产品经理'. */
  title?: string
  /** Emoji avatar shown on signed messages and member bars. */
  avatar?: string
  /**
   * Picture avatar, as a MEDIA LIBRARY FILE NAME (the `basename` of the media
   * asset's `filePath`), never a dataURL. The host resolves it to a URL:
   * `media://<name>` on desktop, `/api/media/file/<name>` on the server.
   * Absent = fall back to `avatar` (emoji).
   */
  avatarImage?: string
  /** Accent color (CSS color) for the agent's signature chip. */
  color?: string
  /** One-line duty statement, rendered into room rosters. */
  description?: string
  /** Preferred model; stamped onto drive commands by the coordinator. */
  model?: AgentModelBinding
  /** Capability packs layered on top of `tools` (e.g. 'collab-room'). */
  toolGrants?: string[]
  /** Composed with the session/global mode by strictness, not by override. */
  permissionMode?: PermissionMode
  /** Model round-trips per run; absent falls back to settings.chat.maxTurns. */
  maxTurns?: number
  /** 分类(M2)。缺省 = 'colleague'。判定请走 `isColleague`,不要自写条件。 */
  kind?: AgentKind
  /** 生命周期(M3)。缺省 = 'active'。判定请走 `isActiveAgent`。 */
  status?: AgentStatus
  /** 心智驱动方(M7,前瞻)。缺省 = { type: 'native' }。A0 不接线任何行为。 */
  executor?: AgentExecutor
}

/**
 * 社交面判定(M2):联系人区、roster 候选、群成员选择器、AgentSelector 只收
 * colleague。缺省 kind 按 colleague 解释(旧 agents.json 无此字段)。
 * 与 runtime 产品层 `packages/onething-runtime/src/agents/model.ts` 的同名函数
 * 语义镜像(产品层禁 import @shared/ipc,故两份实现;有镜像测试盯住)。
 */
export function isColleague(agent: Pick<AgentDefinition, 'kind'>): boolean {
  return (agent.kind ?? 'colleague') === 'colleague'
}

/** 生命周期判定(M3):缺省 status 按 active 解释。镜像同上。 */
export function isActiveAgent(agent: Pick<AgentDefinition, 'status'>): boolean {
  return (agent.status ?? 'active') === 'active'
}

/**
 * 身份面投影(M1/M4):被引用的最小面 —— 署名、联系人、墓碑渲染消费这个,
 * 不带 systemPrompt/tools 等心智/能力面字段。kind/status 已解析缺省。
 * 与 runtime 产品层 model.ts 的 `agentIdentity` 语义镜像。
 */
export interface AgentIdentity {
  id: string
  name: string
  title?: string
  avatar?: string
  avatarImage?: string
  color?: string
  description?: string
  kind: AgentKind
  status: AgentStatus
}

/** 身份面投影。镜像同上。 */
export function agentIdentity(agent: AgentDefinition): AgentIdentity {
  return {
    id: agent.id,
    name: agent.name,
    title: agent.title,
    avatar: agent.avatar,
    avatarImage: agent.avatarImage,
    color: agent.color,
    description: agent.description,
    kind: agent.kind ?? 'colleague',
    status: agent.status ?? 'active',
  }
}

export interface AgentsListResponse {
  success: boolean
  agents?: AgentDefinition[]
  error?: string
}

export interface AgentCreateRequest {
  name: string
  systemPrompt?: string
  tools?: string[]
  title?: string
  avatar?: string
  avatarImage?: string
  color?: string
  description?: string
  model?: AgentModelBinding
  toolGrants?: string[]
  permissionMode?: PermissionMode
  maxTurns?: number
}

export interface AgentCreateResponse {
  success: boolean
  agent?: AgentDefinition
  error?: string
}

export interface AgentUpdateRequest {
  agentId: string
  name?: string
  systemPrompt?: string
  /** Pass an explicit array to set; pass null to clear the allowlist. */
  tools?: string[] | null
  title?: string | null
  avatar?: string | null
  /** Media file name sets it; null clears it (back to the emoji). */
  avatarImage?: string | null
  color?: string | null
  description?: string | null
  model?: AgentModelBinding | null
  toolGrants?: string[] | null
  permissionMode?: PermissionMode | null
  maxTurns?: number | null
}

export interface AgentUpdateResponse {
  success: boolean
  agent?: AgentDefinition
  error?: string
}

export interface AgentDeleteRequest {
  agentId: string
}

/**
 * UI 的「删除」实际发生了什么(M3,§3.2):被引用过的 agent 只能退休(墓碑),
 * 从未被引用过的才真硬删。UI 文案据此分岔 —— 「已退休」和「已删除」不是同一件事。
 */
export type AgentRemovalOutcome = 'retired' | 'deleted'

export interface AgentDeleteResponse {
  success: boolean
  outcome?: AgentRemovalOutcome
  /** 退休时带回墓碑本人(status 已是 retired);硬删时缺席。 */
  agent?: AgentDefinition
  error?: string
}

export interface AgentRestoreRequest {
  agentId: string
}

export interface AgentRestoreResponse {
  success: boolean
  agent?: AgentDefinition
  error?: string
}

/**
 * Agent 档案 CRUD 域(主线 T1 第二批)。
 *
 * 纯数据面:五个方法全是 agents.json 的读写,零窗口、零流式、零事件推送。
 * 「删除」的两条路(退休 vs 硬删)在 runtime 的 `deleteOnethingAgentFromRequestForIpc`
 * 里判,传输面不参与 —— 这也是它能整只搬走的原因。
 */
export type AgentsRoutes = {
  list: { input: Record<string, never>; output: AgentsListResponse }
  create: { input: AgentCreateRequest; output: AgentCreateResponse }
  update: { input: AgentUpdateRequest; output: AgentUpdateResponse }
  delete: { input: AgentDeleteRequest; output: AgentDeleteResponse }
  restore: { input: AgentRestoreRequest; output: AgentRestoreResponse }
}

export const agentsRouter = defineRouter<AgentsRoutes>('agents', [
  'list',
  'create',
  'update',
  'delete',
  'restore',
])
