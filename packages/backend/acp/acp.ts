/**
 * acp —— ACP(Agent Client Protocol):起外部 agent 进程、握手、开会话、把它的流式更新翻译成本应用的事件,
 * 以及 agent 名册、权限 / 提问桥、会话链接与装配用的子系统。
 *
 * 对外交出四类东西:
 * - 装配:ACP 子系统 `AcpSubsystem`、agent 名册与它的拉取口、会话投影、会话删除时的清理、
 *   权限桥的登记、给外部 agent 主机工具开的 MCP 口;
 * - 管理器与流:`ACPManager`、把 ACP 的流翻译成本应用的流事件、连接器 id;
 * - 桥与会话的形状(权限、提问、客户端请求上下文、开会话与发提示的选项、线格式事件);
 * - 调试日志口的形状。
 * 依赖 external-agent、toolkit、terminal、permission、interaction、session、settings、shell、tool、todo-plan、event、storage、logging 与包根的当前实例槽。
 */

// 装配。
export { AcpSubsystem } from './acp-subsystem.js'
export { AcpAgentRegistry } from './acp-registry.js'
export type { AcpRegistryFetch } from './acp-registry.js'
export { createAcpSessionProjections } from './acp-projections.js'
export { onSessionsDeletedFromBus } from './acp-events.js'
export { registerACPPermissionBridge } from './acp-permission-bridge.js'
export { createAcpHostMcpPort } from './acp-host-mcp-port.js'

// 管理器与流。
export { ACPManager } from './acp-manager.js'
export { translateACPPromptStream } from './acp-translate.js'
export type { ACPWireStreamEvent } from './acp-translate.js'
export { ACP_CONNECTOR_ID } from './acp-session-links.js'

// 桥与会话的形状。
export type {
  ACPOpenSessionOptions,
  ACPPermissionBridge,
  ACPPermissionOptionInfo,
  ACPPermissionRequestContext,
  ACPPromptStreamOptions,
  AcpClientRequestContext,
  AcpElicitationContext,
  AcpElicitationRequest,
} from './acp-types.js'

// 调试日志口。
export type { OnethingACPIpcLogger } from './acp-ipc-operations.js'
