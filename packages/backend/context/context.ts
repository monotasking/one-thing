/**
 * context —— 旧 agent 引擎的对话上下文:每个会话一份按顺序排好的消息表。
 *
 * 对外交出一类东西:上下文管理器 `ContextManager` 与它装的消息形状 `AgentMessage`。
 * 依赖 tool(只引类型)。
 */
export { ContextManager } from './context-manager.js'
export type { AgentMessage } from './context-manager.js'
