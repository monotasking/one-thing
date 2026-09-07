import {
  DEFAULT_ONETHING_AGENT_ID,
  createOnethingAgentStore,
  type CreateOnethingAgentInput,
  type UpdateOnethingAgentInput,
} from './index.js'
import type { AgentDefinition, AgentIdentity } from '@shared/ipc.js'
import {
  getOnethingAgentsPath,
} from '../storage/index.js'
/**
 * One store for the whole process. It used to be one instance PER CALL, each
 * doing a synchronous read + parse + normalize of agents.json — and `getAgent`
 * is called once per room member (roster, say-tool, willingness), so an N-member
 * room paid N full reads on the main thread per turn. The path is passed as a
 * function because the store root is only known after boot. The store keeps
 * its cache and initialization Promise with the resolved file, so a later
 * Backend using another root starts from that root's agents.json.
 */
const store = createOnethingAgentStore({
  agentsPath: () => getOnethingAgentsPath(),
})

/**
 * 下面每一处 `as AgentDefinition` 都靠 `OnethingAgentDefinition` 与 shared 的
 * `AgentDefinition` **逐字段同构**成立(产品层禁 import @shared/ipc,故两份类型)。
 * cast 本身永远不会报错,所以那个前提由测试盯住:
 * `packages/onething-runtime/src/agents/__tests__/model.test.ts` 的
 * 「mirror discipline」—— 任一侧加/删字段,那里的键集表就红。
 */

/** Load agents.json into memory once (and persist the normalized shape). */
export async function initializeAgents(): Promise<void> {
  await store.initialize()
}

/** Escape hatch after an external edit of agents.json. */
export function invalidateAgentsCache(): void {
  store.invalidate()
}

export function listAgents(): AgentDefinition[] {
  return store.listAgents() as AgentDefinition[]
}

/** 严格查找(M4):查无此人(含空 id)返回 null,绝不冒充 default。 */
export function findAgent(agentId: string | undefined | null): AgentDefinition | null {
  return store.findAgent(agentId) as AgentDefinition | null
}

/** 执行链用(M4):查无此人即 throw(错误信息带 agentId)。 */
export function requireAgent(agentId: string | undefined | null): AgentDefinition {
  return store.requireAgent(agentId) as AgentDefinition
}

/** 渲染用(M4):身份投影;未知 id 返回「已注销」墓碑占位,永不炸。 */
export function displayAgent(agentId: string | undefined | null): AgentIdentity {
  return store.displayAgent(agentId) as AgentIdentity
}

/** 功能兜底显式化(M4):default agent 本人(无 agentId 会话的 persona)。 */
export function defaultAgent(): AgentDefinition {
  return store.defaultAgent() as AgentDefinition
}

/**
 * @deprecated 过渡期兼容(M4):= `findAgent(id) ?? defaultAgent()`,fallback
 * 命中时打 warn。新代码按语义归位到上面四个 API 之一。
 */
export function getAgent(agentId: string | undefined | null): AgentDefinition {
  return store.getAgent(agentId) as AgentDefinition
}

export function agentExists(agentId: string | undefined | null): boolean {
  return store.agentExists(agentId)
}

export function createAgent(input: CreateOnethingAgentInput): AgentDefinition {
  return store.createAgent(input) as AgentDefinition
}

export function updateAgent(input: UpdateOnethingAgentInput): AgentDefinition {
  return store.updateAgent(input) as AgentDefinition
}

/** 退休(M3,§3.2):status → retired,身份面全保留(墓碑)。default 硬拒。 */
export function retireAgent(agentId: string): AgentDefinition {
  return store.retireAgent(agentId) as AgentDefinition
}

/** 恢复(§8):status → active。入口只在 Agents 管理页,不进任何社交面。 */
export function restoreAgent(agentId: string): AgentDefinition {
  return store.restoreAgent(agentId) as AgentDefinition
}

/** 真硬删。先用 `hasAnyReference` 确认从未被引用过 —— 被引用过只能退休。 */
export function deleteAgent(agentId: string): void {
  store.deleteAgent(agentId)
}

export const DEFAULT_AGENT_ID = DEFAULT_ONETHING_AGENT_ID
