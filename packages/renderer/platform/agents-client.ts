/**
 * Agent 档案域的渲染侧客户端(主线 T1 第二批)。
 *
 * 形状照 E1 判例:壳外一个模块 + 通用 `platformApi.rpcInvoke`,四壳零改动。
 * 对外的方法名沿用旧的 `listAgents / createAgent / ...`,并把旧签名(位置参数)
 * 在这里包成信封 —— 调用点(`stores/agents.ts`)因此只换引入来源,不改写法。
 */
import { agentsRouter } from '@shared/ipc/agents.js'
import type {
  AgentCreateResponse,
  AgentDeleteResponse,
  AgentRestoreResponse,
  AgentUpdateRequest,
  AgentUpdateResponse,
  AgentsListResponse,
} from '@shared/ipc/agents.js'
import { clientApi } from './client'

const agents = clientApi(agentsRouter)

export const agentsApi = {
  listAgents: (): Promise<AgentsListResponse> => agents.list({}),
  createAgent: (name: string, systemPrompt = ''): Promise<AgentCreateResponse> =>
    agents.create({ name, systemPrompt }),
  updateAgent: (
    agentId: string,
    updates: Omit<AgentUpdateRequest, 'agentId'>,
  ): Promise<AgentUpdateResponse> => agents.update({ ...updates, agentId }),
  deleteAgent: (agentId: string): Promise<AgentDeleteResponse> => agents.delete({ agentId }),
  restoreAgent: (agentId: string): Promise<AgentRestoreResponse> => agents.restore({ agentId }),
}
