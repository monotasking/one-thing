/**
 * Agent 执行会话 — W18 (docs/design/multi-agent-collab-im.md §4.6 v5).
 *
 * 用户原话:"一个群聊里只有 message。我们要把 agent 抽象出来,干活、思考都在
 * 自己的 session 里干,说话调用工具 say,say 到哪个 room。"
 *
 * So the room stops being the place a turn RUNS. Every agent owns one durable
 * execution session — drives land there, thinking and tool calls stay there —
 * and the only thing that ever reaches a room is a `say`. This module owns the
 * two pure facts that decision needs:
 *
 *  - the session id is DERIVED from the agent id, so "ensure" is idempotent
 *    without a registry: the same agent always resolves to the same session,
 *    across restarts and without a lookup table to keep in sync;
 *  - a session id alone tells you whether it is an execution session, which is
 *    what the sidebar filters and the hidden-session guards read.
 */

/**
 * A3(M6):id 构造已迁往 `agents/identity.ts`,这里只留 collab 侧的名字。
 *
 * 下面三个导出是**委托**,一行实现都没有:IM 化新增了 dm 房两族 id,所有
 * `agent-*` 派生 id 的构造因此收进一个属主(agent-domain-model.md §5),
 * 字面量前缀只剩那边一处。
 *
 * ## 属主是 `agents/identity.ts`,这三个名字是过渡壳(架构审查 B8)
 *
 * 同一件事两个名字,是"下一个人该 import 哪一个"的持续成本。清点过一次,
 * 产品侧还剩 10 处调用点:
 *
 *  - `collabAgentSessionId` —— app/collab/{turn.ts ×5, coordinator.ts,
 *    planner.ts, agent-session.ts};
 *  - `collabAgentSessionIdsForScan` —— app/collab/{budget.ts, queue.ts};
 *  - `isCollabAgentSessionId` —— 产品侧**零**调用点(只剩 barrel 与测试)。
 *
 * 撤掉的判据不是"过了一个版本",而是**上面那张表清空**:每一处改成直接
 * import `agents/identity.ts` 的同义名(`execSessionId` /
 * `execSessionIdsForScan` / `isAgentExecSessionId`),这个文件的前三个导出连同
 * barrel 里的三行一起删。名字后半段(`collabAgentSessionName` 一族)不在此列
 * —— 那是 collab 自己的显示约定,本来就该住在这里。
 *
 * 按相对路径 import 单文件而不走 `@onething/backend/agent` barrel:那个 barrel
 * 带着 agents/store.ts(读 agents.json,吃 node fs),而 collab barrel 是
 * renderer 也 import 的(packages/renderer/utils/agent-sessions.ts)。identity.ts
 * 本身零依赖纯字符串,搭在这条链上不会把 node 拖进浏览器包。
 */
import {
  AGENT_EXEC_SESSION_PREFIX,
  execSessionId,
  execSessionIdsForScan,
  isAgentExecSessionId,
} from '../agent/agent-identity.js'

/** Prefix of every agent execution session id. Stable — it is persisted. */
export const COLLAB_AGENT_SESSION_PREFIX = AGENT_EXEC_SESSION_PREFIX

/**
 * The execution session an agent runs a given room's turns in
 * (collab-team-v2 §1.1:每群每 agent 一条常驻会话)。
 *
 * 语义与"为什么 id 里要带房间"的完整来历见 `agents/identity.ts#execSessionId`。
 *
 * @deprecated 用 `agents/identity.ts#execSessionId`。撤除判据见文件头。
 */
export function collabAgentSessionId(agentId: string, roomSessionId?: string): string | null {
  return execSessionId(agentId, roomSessionId)
}

/**
 * 迁移期要扫的执行会话集合(§1.4)。见 identity.ts#execSessionIdsForScan。
 *
 * @deprecated 用 `agents/identity.ts#execSessionIdsForScan`。判据见文件头。
 */
export function collabAgentSessionIdsForScan(agentId: string, roomSessionId: string): string[] {
  return execSessionIdsForScan(agentId, roomSessionId)
}

/**
 * Is this id an agent execution session? (id-only test — no store needed.)
 *
 * @deprecated 用 `agents/identity.ts#isAgentExecSessionId`。产品侧已零调用点,
 * 只等 barrel 与测试改名 —— 三个委托里最先可以删的就是它。
 */
export function isCollabAgentSessionId(sessionId: string | undefined): boolean {
  return isAgentExecSessionId(sessionId)
}

/** The badge `collabAgentSessionName` stamps onto an execution session's name.
 *  Exported so the sidebar's Agent group (W20) can take it back off instead of
 *  keeping a second copy of the literal: the group shows the agent's own name,
 *  and the badge exists only to keep the session file readable. */
export const COLLAB_AGENT_SESSION_NAME_PREFIX = '[执行] '

/** Display name for the hidden session. It stays out of the ordinary session
 *  lists, but the session file and the sidebar's Agent group read better with
 *  a real name. */
export function collabAgentSessionName(agentName: string): string {
  const name = (agentName || '').trim()
  return `${COLLAB_AGENT_SESSION_NAME_PREFIX}${name || 'Agent'}`
}

/** The agent name back out of an execution session's name — the last-resort
 *  label when the roster no longer answers for the agent (renamed away or
 *  deleted). A stale name still reads better than `agent-exec-<id>`. */
export function stripCollabAgentSessionName(sessionName: string | undefined): string {
  const name = (sessionName || '').trim()
  return name.startsWith(COLLAB_AGENT_SESSION_NAME_PREFIX)
    ? name.slice(COLLAB_AGENT_SESSION_NAME_PREFIX.length).trim()
    : name
}
