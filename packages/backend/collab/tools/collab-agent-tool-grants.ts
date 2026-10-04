/**
 * 协作的四格工具地板,登记进 agent 档案的能力包表(越层清零 A3,2026-10-04)。
 *
 * 从前这四行写死在 `agent/agent-profile.ts` 的 `AGENT_TOOL_GRANTS` 里,agent 档案因此要 import
 * 协作的工具表;现在由协作自己登记,agent 只读表(`agentToolGrants()`)。四行逐字搬,顺序不变 ——
 * 并集叠加按登记顺序走,顺序就是一回合工具面里协作工具出现的先后。
 *
 * 「哪个 session kind 拿哪一格」的映射仍在 agent(`GRANTS_BY_SESSION_KIND` 等三张表):那是规则,
 * 这里是表。
 */
import { registerAgentToolGrant, type AgentToolGrant } from '@onething/backend/agent'
import {
  COLLAB_NOTEBOOK_TOOLS,
  COLLAB_ROOM_TOOLS,
  COLLAB_WORK_REQUIRED_TOOLS,
} from './collab-tool-surface.js'

const COLLAB_AGENT_TOOL_GRANTS: readonly AgentToolGrant[] = [
  { id: 'collab-room', tools: COLLAB_ROOM_TOOLS, mode: 'union' },
  // agent-im-dm.md D7:单成员 dm 房(用户 ↔ agent 托管私聊)的回合。同样的两个
  // 工具、**恒为 union**,与 `collab-room` 分开登记的唯一目的是隔离:群房那一格
  // 将来若再次收紧成 replace,私聊不会被连带收窄(托管私聊的本义就是替你干活)。
  { id: 'collab-dm', tools: COLLAB_ROOM_TOOLS, mode: 'union' },
  { id: 'collab-work', tools: COLLAB_WORK_REQUIRED_TOOLS, mode: 'union' },
  /**
   * Collab v3 的跨房笔记(docs/design/collab-actor-v3.md §1.2)。
   *
   * D2 登记时刻意不由任何 kind 隐含(v2 回合带一个没人读的工具是纯损耗);
   * **D6-a 接线后由 `NOTEBOOK_SESSION_KINDS` 隐含** —— v3 的心智循环在每一条
   * drive 的尾部注入笔记,写下的东西从此有读者。
   */
  { id: 'collab-notebook', tools: COLLAB_NOTEBOOK_TOOLS, mode: 'union' },
]

/** 装配期登记一次(`configureAppRuntimeAdapters()`);幂等 —— 同 id 再登记是替换,位置不动。 */
export function registerCollabAgentToolGrants(): void {
  for (const grant of COLLAB_AGENT_TOOL_GRANTS) registerAgentToolGrant(grant)
}
