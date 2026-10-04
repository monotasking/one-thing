/**
 * agent 自我状态(`my_cards` / `my_rooms` / `my_dms`)的事实从哪儿来(越层清零 A4,2026-10-04)。
 *
 * 从前 `variable-gateways.ts` 的 `agentSelfGateway` 自己去读协作的看板、协作的用户身份、私聊房
 * 判据 —— 变量系统认识协作。现在协作登记一个来源(`collab/collab-variable-presence.ts`,装配期
 * `configureAppRuntimeAdapters()` 登记一次),变量系统只问这一格。没有登记 = 三个变量一个都不产出,
 * 与「没绑 agent」同一个结局(provider 把 `null` 与三格全空读成同样的零个变量)。
 */
import type { AgentSelfStateFacts } from './providers/variable-providers-agent-self.js'

/** 给一条会话、会话上绑着的那个 agent,答它此刻的卡 / 房 / 私聊。 */
export type AgentPresenceSource = (sessionId: string, agentId: string) => AgentSelfStateFacts | null

const presence: { source: AgentPresenceSource | undefined } = { source: undefined }

/** 登记来源。只有一格:后登记的替换先登记的(同一个函数重复登记即幂等)。 */
export function registerAgentPresenceSource(source: AgentPresenceSource | undefined): void {
  presence.source = source
}

/** 读当下登记着的来源;没有就是 `undefined`。 */
export function agentPresenceSource(): AgentPresenceSource | undefined {
  return presence.source
}
