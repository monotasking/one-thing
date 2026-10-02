import { hasAgentReference, type AgentReferenceSessionLike } from './presence.js'
import {
  DEFAULT_ONETHING_AGENT_ID,
  type CreateOnethingAgentInput,
  type OnethingAgentDefinition,
  type UpdateOnethingAgentInput,
} from './store.js'

type MaybePromise<T> = T | Promise<T>

export interface OnethingAgentsIpcLogger {
  error?: (...args: unknown[]) => void
}

export type OnethingAgentIpcResult<TPayload extends object = {}> =
  | ({ success: true } & TPayload)
  | { success: false; error: string }

export interface ListOnethingAgentsOptions<TAgent extends OnethingAgentDefinition = OnethingAgentDefinition> {
  listAgents(): MaybePromise<TAgent[]>
}

export interface ListOnethingAgentsResult<TAgent extends OnethingAgentDefinition = OnethingAgentDefinition> {
  success: true
  agents: TAgent[]
}

export async function listOnethingAgents<TAgent extends OnethingAgentDefinition>(
  options: ListOnethingAgentsOptions<TAgent>,
): Promise<ListOnethingAgentsResult<TAgent>> {
  return {
    success: true,
    agents: await options.listAgents(),
  }
}

export async function listOnethingAgentsForIpc<TAgent extends OnethingAgentDefinition>(
  options: ListOnethingAgentsOptions<TAgent> & {
    logger?: OnethingAgentsIpcLogger
  },
): Promise<OnethingAgentIpcResult<{ agents: TAgent[] }>> {
  try {
    return await listOnethingAgents(options)
  } catch (error) {
    return agentIpcError(options.logger, 'list agents', error)
  }
}

export interface CreateOnethingAgentFromRequestOptions<
  TAgent extends OnethingAgentDefinition = OnethingAgentDefinition,
> extends Omit<CreateOnethingAgentInput, 'id' | 'name'> {
  name?: string
  createId(): string
  createAgent(input: CreateOnethingAgentInput): MaybePromise<TAgent>
}

export interface CreateOnethingAgentFromRequestResult<
  TAgent extends OnethingAgentDefinition = OnethingAgentDefinition,
> {
  success: true
  agent: TAgent
}

export async function createOnethingAgentFromRequest<TAgent extends OnethingAgentDefinition>(
  options: CreateOnethingAgentFromRequestOptions<TAgent>,
): Promise<CreateOnethingAgentFromRequestResult<TAgent>> {
  return {
    success: true,
    agent: await options.createAgent({
      id: `agent-${options.createId()}`,
      name: options.name ?? '',
      systemPrompt: options.systemPrompt ?? '',
      tools: options.tools,
      title: options.title,
      avatar: options.avatar,
      avatarImage: options.avatarImage,
      color: options.color,
      description: options.description,
      model: options.model,
      toolGrants: options.toolGrants,
      permissionMode: options.permissionMode,
      maxTurns: options.maxTurns,
    }),
  }
}

export async function createOnethingAgentFromRequestForIpc<TAgent extends OnethingAgentDefinition>(
  options: CreateOnethingAgentFromRequestOptions<TAgent> & {
    logger?: OnethingAgentsIpcLogger
  },
): Promise<OnethingAgentIpcResult<{ agent: TAgent }>> {
  try {
    return await createOnethingAgentFromRequest(options)
  } catch (error) {
    return agentIpcError(options.logger, 'create agent', error)
  }
}

export interface UpdateOnethingAgentFromRequestOptions<
  TAgent extends OnethingAgentDefinition = OnethingAgentDefinition,
> extends UpdateOnethingAgentInput {
  updateAgent(input: UpdateOnethingAgentInput): MaybePromise<TAgent>
}

export interface UpdateOnethingAgentFromRequestResult<
  TAgent extends OnethingAgentDefinition = OnethingAgentDefinition,
> {
  success: true
  agent: TAgent
}

/**
 * 普通编辑面。**刻意不转发 `kind`/`status`/`executor`** —— 白名单是这份显式的
 * 字段列表本身,而不是某处的黑名单校验:生命周期(status)只经退休/恢复变更
 * (§3.2),分类与执行体也不是编辑表单里的东西。请求里带了这些字段也会在这里
 * 停住,加字段的人必须显式想一遍要不要放开。
 */
export async function updateOnethingAgentFromRequest<TAgent extends OnethingAgentDefinition>(
  options: UpdateOnethingAgentFromRequestOptions<TAgent>,
): Promise<UpdateOnethingAgentFromRequestResult<TAgent>> {
  return {
    success: true,
    agent: await options.updateAgent({
      agentId: options.agentId,
      name: options.name,
      systemPrompt: options.systemPrompt,
      tools: options.tools,
      title: options.title,
      avatar: options.avatar,
      avatarImage: options.avatarImage,
      color: options.color,
      description: options.description,
      model: options.model,
      toolGrants: options.toolGrants,
      permissionMode: options.permissionMode,
      maxTurns: options.maxTurns,
    }),
  }
}

export async function updateOnethingAgentFromRequestForIpc<TAgent extends OnethingAgentDefinition>(
  options: UpdateOnethingAgentFromRequestOptions<TAgent> & {
    logger?: OnethingAgentsIpcLogger
  },
): Promise<OnethingAgentIpcResult<{ agent: TAgent }>> {
  try {
    return await updateOnethingAgentFromRequest(options)
  } catch (error) {
    return agentIpcError(options.logger, 'update agent', error)
  }
}

/**
 * UI 的「删除」发生了什么(域模型 M3,§3.2)。
 *
 * `retired`:这个 agent 被引用过,身份面永久保留成墓碑;`deleted`:从未被
 * 引用过,真从 agents.json 里没了。文案分岔靠这个字段,不靠猜。
 */
export type OnethingAgentRemovalOutcome = 'retired' | 'deleted'

export interface DeleteOnethingAgentFromRequestResult<
  TAgent extends OnethingAgentDefinition = OnethingAgentDefinition,
> {
  success: true
  outcome: OnethingAgentRemovalOutcome
  /** 退休时带回墓碑本人(UI 就地灰显,不必再拉一次列表);硬删时缺席。 */
  agent?: TAgent
}

/**
 * 删除语义(§3.2):**退休不是删除**。
 *
 * 被任何会话引用过的 agent 永不硬删 —— 历史消息署名、房间成员条、履历页都指着
 * 它的 id,删掉就是把这些引用变成孤儿(旧世界靠 getAgent 的静默 fallback 让
 * default agent 冒充它来"兜底",两个错误互相掩护,M4 已经把那条路拆了)。
 * 从未被引用过的才允许真硬删:没有人指着它,墓碑就是纯垃圾。
 */
export async function deleteOnethingAgentFromRequest<
  TAgent extends OnethingAgentDefinition,
  TSession extends AgentReferenceSessionLike,
>(
  options: {
    agentId?: string | null
    defaultAgentId?: string
    /** 引用检查的输入。会话元数据即可(agentId / kind / room / collab 四个字段)。 */
    sessions: readonly TSession[]
    /** 被引用过 → 退休(status 翻 retired,身份面全留)。 */
    retireAgent(agentId: string): MaybePromise<TAgent>
    /** 从未被引用过 → 真硬删。 */
    deleteAgent(agentId: string): MaybePromise<void>
  },
): Promise<DeleteOnethingAgentFromRequestResult<TAgent>> {
  const defaultAgentId = options.defaultAgentId ?? DEFAULT_ONETHING_AGENT_ID
  const agentId = options.agentId
  if (!agentId) throw new Error('Agent id is required')
  // 主助理不可退休不可删(M5):两条路一起堵,不留"换个入口就没了"的缝。
  if (agentId === defaultAgentId) throw new Error('Default Agent cannot be retired or deleted')

  if (hasAgentReference(agentId, options.sessions)) {
    return { success: true, outcome: 'retired', agent: await options.retireAgent(agentId) }
  }

  await options.deleteAgent(agentId)
  return { success: true, outcome: 'deleted' }
}

export async function deleteOnethingAgentFromRequestForIpc<
  TAgent extends OnethingAgentDefinition,
  TSession extends AgentReferenceSessionLike,
>(
  options: {
    agentId?: string | null
    defaultAgentId?: string
    listSessions(): MaybePromise<readonly TSession[]>
    retireAgent(agentId: string): MaybePromise<TAgent>
    deleteAgent(agentId: string): MaybePromise<void>
    logger?: OnethingAgentsIpcLogger
  },
): Promise<OnethingAgentIpcResult<{ outcome: OnethingAgentRemovalOutcome; agent?: TAgent }>> {
  try {
    return await deleteOnethingAgentFromRequest({
      agentId: options.agentId,
      defaultAgentId: options.defaultAgentId,
      sessions: await options.listSessions(),
      retireAgent: options.retireAgent,
      deleteAgent: options.deleteAgent,
    })
  } catch (error) {
    return agentIpcError(options.logger, 'delete agent', error)
  }
}

export interface RestoreOnethingAgentFromRequestOptions<
  TAgent extends OnethingAgentDefinition = OnethingAgentDefinition,
> {
  agentId?: string | null
  restoreAgent(agentId: string): MaybePromise<TAgent>
}

export interface RestoreOnethingAgentFromRequestResult<
  TAgent extends OnethingAgentDefinition = OnethingAgentDefinition,
> {
  success: true
  agent: TAgent
}

/**
 * 重新入职(§8):status 翻回 active,别的什么都不动。
 *
 * 独立于 update 的一条语义动作,和退休对称——生命周期的两个方向各有一个名字,
 * 而不是一个「顺手能写 status 的 update」。入口只在 Agents 管理页(不进任何
 * 社交面):恢复是管理动作,不是聊天里能点出来的东西。
 */
export async function restoreOnethingAgentFromRequest<TAgent extends OnethingAgentDefinition>(
  options: RestoreOnethingAgentFromRequestOptions<TAgent>,
): Promise<RestoreOnethingAgentFromRequestResult<TAgent>> {
  const agentId = options.agentId
  if (!agentId) throw new Error('Agent id is required')
  return { success: true, agent: await options.restoreAgent(agentId) }
}

export async function restoreOnethingAgentFromRequestForIpc<TAgent extends OnethingAgentDefinition>(
  options: RestoreOnethingAgentFromRequestOptions<TAgent> & {
    logger?: OnethingAgentsIpcLogger
  },
): Promise<OnethingAgentIpcResult<{ agent: TAgent }>> {
  try {
    return await restoreOnethingAgentFromRequest(options)
  } catch (error) {
    return agentIpcError(options.logger, 'restore agent', error)
  }
}

function agentIpcError(
  logger: OnethingAgentsIpcLogger | undefined,
  label: string,
  error: unknown,
): { success: false; error: string } {
  logger?.error?.(`[AgentsIPC] Failed to ${label}:`, error)
  return {
    success: false,
    error: error instanceof Error ? error.message : String(error),
  }
}
