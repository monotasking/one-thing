import type { AgentsListResponse } from '@shared/ipc/agents'
import { sessionsRouter, type SessionMutationResponse } from '@shared/ipc/sessions'
import { agentsRouter } from '@shared/ipc/agents'

/**
 * agents 名册与「这条会话归谁」之间的那一层**端口**。
 *
 * 判例与 `sessions-port.ts` / `chat-port.ts` 逐条相同:形状是**平台调用面的子集**,
 * 不是新契约,存在的唯一理由是可测 —— agents-source 的判据(拉一次、失败重试一次、
 * 切换的乐观更新与回滚)全是纯逻辑,不该为了测它去起一台 core。
 *
 * 三个方法逐条对应:
 *  - `agentsRouter` 的 `agents.list`;
 *  - `sessionsRouter` 的 `sessions.updateAgent`;
 *  - `whenConnected()`(D0 的连通面)。
 *
 * ── 为什么读面是 `agents.list` 而不是某个「名册投影」 ─────────────────────
 * 后端没有名册投影面:`EffectiveAgentProfile` 至今没有 IPC 出口(主仓既有留账),
 * 能拿到的就是 `agents.list` 的整份 `AgentDefinition[]`。屏幕上要的四格
 * (id / 名字 / 一句描述 / 头像与色)全在它身上,所以**不补新读口** ——
 * 多拿到的 systemPrompt / tools 在投影那一步就被丢掉,不流进屏幕。
 */
export interface AgentsPort {
  /** 传输面就绪(D0 的 whenConnected);浏览器直开时它也会 resolve。 */
  ready(): Promise<unknown>
  /** 名册全集。`success:false` 是「后端说不行」,抛异常是「根本没连上」。 */
  list(): Promise<AgentsListResponse>
  /**
   * 把一条会话改判给另一个 agent。**从下一条消息起生效,历史照留** ——
   * 这一条是后端 `sessions.updateAgent` 的既有语义(只改 meta.agentId),
   * 不是这一层加的解释。
   */
  updateSessionAgent(sessionId: string, agentId: string): Promise<SessionMutationResponse>
}

let port: AgentsPort | undefined

/** 测试用:换掉端口实现。传 undefined 恢复真实现。 */
export function configureAgentsPort(next: AgentsPort | undefined): void {
  port = next
}

/**
 * 真实现是**惰性**建的,理由与 sessions-port 同一条:它要的是那个连通之后才
 * 存在的客户端,而端口被换掉的测试根本不该把连通面拖进来。
 */
async function realPort(): Promise<AgentsPort> {
  const { onethingClient, whenConnected } = await import('../platform/connection')
  const client = await onethingClient()
  const agentsApi = client.api(agentsRouter)
  const sessionsApi = client.api(sessionsRouter)
  return {
    ready: () => whenConnected(),
    list: () => agentsApi.list({}),
    updateSessionAgent: (sessionId, agentId) => sessionsApi.updateAgent({ sessionId, agentId }),
  }
}

let pending: Promise<AgentsPort> | undefined

export function agentsPort(): Promise<AgentsPort> {
  if (port) return Promise.resolve(port)
  pending ??= realPort()
  return pending
}
