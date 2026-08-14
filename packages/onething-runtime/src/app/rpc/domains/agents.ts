/**
 * Agent 档案 CRUD 域(主线 T1 第二批)。
 *
 * 替换 `apps/electron/src/main/ipc/agents.ts`(已删)与 server 的
 * `runtime.agents` 适配器 + `/api/agents*` 五条路由。server 那份原本是
 * per-owner 分库(`getAgentStoreForContext`),默认 context 写的就是同一个
 * `agents.json` —— 与第一批 prompts / todo-plan 同类的「换个路径存」,单用户
 * 前提下是收敛;旧的 `owners/<uid>/<wid>/agents.json` **不会自动搬家**。
 *
 * 「删除」的两条路(域模型 §3.2):被引用过 → 退休(墓碑);从未被引用过 →
 * 真硬删。引用检查吃的是 meta-only 的会话快索引(`getSessionsList`),不是
 * 会带出全部转录的 `getSessions`。
 */
import { randomUUID } from 'node:crypto'
import type { RouteHandlers } from '@onething/core/ipc'
import { agentsRouter, type AgentsRoutes } from '@shared/ipc/agents.js'
import {
  createOnethingAgentFromRequestForIpc,
  deleteOnethingAgentFromRequestForIpc,
  listOnethingAgentsForIpc,
  restoreOnethingAgentFromRequestForIpc,
  updateOnethingAgentFromRequestForIpc,
} from '@onething/runtime/agents'
import {
  DEFAULT_AGENT_ID,
  createAgent,
  deleteAgent,
  listAgents,
  restoreAgent,
  retireAgent,
  updateAgent,
} from '../../agents/index.js'
import { getSessionsList } from '../../stores/index.js'
import { registerRouterHandlers } from '../registry.js'

export const agentsRpcHandlers: RouteHandlers<AgentsRoutes> = {
  async list() {
    return listOnethingAgentsForIpc({ listAgents, logger: console })
  },
  async create(request) {
    return createOnethingAgentFromRequestForIpc({
      name: request?.name ?? '',
      systemPrompt: request?.systemPrompt ?? '',
      tools: request?.tools,
      title: request?.title,
      avatar: request?.avatar,
      avatarImage: request?.avatarImage,
      color: request?.color,
      description: request?.description,
      model: request?.model,
      toolGrants: request?.toolGrants,
      permissionMode: request?.permissionMode,
      maxTurns: request?.maxTurns,
      createId: randomUUID,
      createAgent,
      logger: console,
    })
  },
  async update(request) {
    return updateOnethingAgentFromRequestForIpc({
      agentId: request?.agentId ?? '',
      name: request?.name,
      systemPrompt: request?.systemPrompt,
      tools: request?.tools,
      title: request?.title,
      avatar: request?.avatar,
      avatarImage: request?.avatarImage,
      color: request?.color,
      description: request?.description,
      model: request?.model,
      toolGrants: request?.toolGrants,
      permissionMode: request?.permissionMode,
      maxTurns: request?.maxTurns,
      updateAgent,
      logger: console,
    })
  },
  async delete(request) {
    return deleteOnethingAgentFromRequestForIpc({
      agentId: request?.agentId,
      defaultAgentId: DEFAULT_AGENT_ID,
      listSessions: getSessionsList,
      retireAgent,
      deleteAgent,
      logger: console,
    })
  },
  async restore(request) {
    return restoreOnethingAgentFromRequestForIpc({
      agentId: request?.agentId,
      restoreAgent,
      logger: console,
    })
  },
}

export function registerAgentsRpcDomain(): () => void {
  return registerRouterHandlers(agentsRouter, agentsRpcHandlers)
}
