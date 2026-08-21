/**
 * 在场推导的装配面(M6,docs/design/agent-domain-model.md §5)。
 *
 * 规则本身是产品层的纯函数(`@onething/runtime/agents` → agents/presence.ts);
 * 这里只做一件事:去 sessions store 取会话**元数据**喂给它。
 *
 * 刻意走 `getSessionsList()` 而不是 `getSessions()`:前者是 meta-only 的快索引
 * (无 messages 数组),后者会把会话正文往内存里拉——presence 只读 kind /
 * agentId / collab.roomSessionId / room.memberAgentIds 四个字段,为这四个字段
 * 读进几百 MB 转录是启动性能事故的经典配方。
 *
 * renderer 将来自己从 sessionsStore 现算(desktop 省一跳 IPC),两边共用同一个
 * `computeAgentPresence`,故口径不会漂。
 */
import { computeAgentPresence, hasAgentReference, type AgentPresence } from '@onething/runtime/agents'
import { getSessionsList } from '../../stores/sessions.js'

/**
 * 一个 agent 此刻在哪儿:dm 房 / 房间 / 执行会话 / 工作台会话四路。
 *
 * 每次现算(在场面永不落库)。会话索引是内存里的快索引,一次遍历。
 */
export function listAgentPresence(agentId: string | undefined | null): AgentPresence {
  return computeAgentPresence(agentId, getSessionsList())
}

/**
 * 这个 agent 被任何会话引用过吗?
 *
 * A2「硬删 vs 退休」的判定(§3.2):有引用只能退休(墓碑保住历史署名、房间
 * 成员与履历不悬空),从未被引用过的才允许真硬删。
 *
 * 判定比在场面**宽一格**:履历四栏不认 `kind='chat'` 的直聊会话,但直聊会话的
 * `agentId` 就是它的 persona 绑定,那批消息的署名一样指着这个 id。规则本身在
 * 产品层的 `hasAgentReference`,这里只负责递会话索引。
 */
export function hasAnyReference(agentId: string | undefined | null): boolean {
  return hasAgentReference(agentId, getSessionsList())
}
