/**
 * agent:agent 档案(层次 L2)—— 每个 agent 是谁、用什么模型、由谁执行、此刻在不在场。
 *
 * 名册存在用户的 store 里(`agents/`),所以它是能力而不是纯事实。生效档案(某个会话此刻用哪个 agent、
 * 开哪些工具、权限模式是什么)在这里算;执行器表本身住在 agent-loop,这里只按 agent 回答「它由谁执行」。
 *
 * 对外交出七类东西(下面按类分组):名册的读写、身份(执行会话与私聊房间的 id 算法)、模型判据、
 * 生效档案、在场、执行器、旧引擎 `AgentEngine`(只剩 HTTP 服务器的旧事件形状与冒烟脚本在用),
 * 另有一个 IPC 日志口的类型。
 *
 * 依赖:agent-loop(执行器表)、session 与 settings(生效档案要读会话与设置)、tool、event、context
 * (后三只只为旧引擎)、storage、logging。开给界面的操作在第二入口 `agent-client-api.ts`,不经这里。
 * 只用具名导出,每个名字从声明它的那只文件转交;只交外面真在用的名字。
 */

// 1. 名册:存储、读写与缓存
export { createOnethingAgentStore, DEFAULT_ONETHING_AGENT_ID } from './agent-store.js'
export {
  agentExists,
  DEFAULT_AGENT_ID,
  defaultAgent,
  findAgent,
  initializeAgents,
  invalidateAgentsCache,
  listAgents,
} from './agent-store-access.js'
export { createAgent, updateAgent } from './agent-store-bound.js'

// 2. 身份:执行会话与私聊房间的 id
export {
  AGENT_EXEC_SESSION_PREFIX,
  agentDmRoomId,
  execSessionId,
  execSessionIdsForScan,
  isAgentExecSessionId,
  userDmRoomId,
} from './agent-identity.js'

// 3. 模型判据
export { agentTombstoneLabel, isColleague } from './agent-model.js'

// 4. 生效档案:工具面、权限模式、按会话解析
export { composeAgentPermissionMode, DEFAULT_AGENT_MAX_TURNS, registerAgentToolGrant, resolveAgentToolSurface } from './agent-profile.js'
export type { AgentToolGrant, EffectiveAgentProfile } from './agent-profile.js'
export { resolveAgentProfileForSession, resolveAgentProfileForSessionObject } from './agent-profile-for-session.js'

// 5. 在场
export { computeAgentPresence } from './agent-presence.js'

// 6. 执行器:描述从 agent-loop 的执行器表来,经执行器的桶转交(两只测试在这个入口上替换它)
export { findAgentExecutorDescriptor } from './executor/agent-executor.js'
export { isExternalAgentExecutorProvider } from './executor/agent-executor-registry.js'

// 7. 旧引擎
export { AgentEngine } from './agent-engine.js'
export type { AgentEngineSessionEvent, AgentEngineStreamChunk } from './agent-engine.js'

// IPC 日志口
export type { OnethingAgentsIpcLogger } from './agent-ipc-operations.js'
