/**
 * variable —— 上下文变量:会话 / 项目 / agent / 全局几个作用域里的键值,由自述的变量源(工作目录、目标、
 * 笔记库、agent 自己的状态……)提供,每回合作为变量看板交给模型,模型也能经 `variable` 工具读写。
 *
 * 对外交出五类东西:
 * - 装配:起变量系统、登记标准变量源与 agent 在场源、给工具用的带守卫的登记表、变量看板的提示词文本;
 * - 登记表与仓库:`VariableRegistry`、`VariablesStore` 与它的持久化口、变量文件的解析与缺省;
 * - 变量的形状(作用域、类型、能力变量判据)与变量错误;
 * - 工作目录这一路的网关、agent 自身状态的几种事实形状;
 * - 开给设置页的列 / 改 / 删与请求形状。
 * 依赖 session、event、goal、note、project-dir、permission、space、music、agent、tool、storage、logging 与包根的当前实例槽(变量源各自带进来)。
 */

// 装配。
export {
  bootstrapVariableSystem,
  buildStateVariablesPromptText,
  getGuardedVariableRegistryForTools,
  VariableError,
} from './variable-system.js'
export { registerStandardVariableProviders } from './variable-bootstrap.js'
export { registerAgentPresenceSource } from './variable-agent-presence.js'

// 登记表与仓库。
export { VariableRegistry } from './variable-registry.js'
export { VariablesStore } from './variable-store.js'
export type { VariablesStorePersistence } from './variable-store.js'
export { createDefaultVariablesFile, parseVariablesFile } from './variable-schema.js'
export type { VariablesFile } from './variable-schema.js'

// 变量的形状。
export { isCapabilityVariable } from './variable-types.js'
export type { ContextVariable, VariableScope, VariableType } from './variable-types.js'

// 工作目录网关与 agent 自身状态。
export { workdirGateway } from './variable-gateways.js'
export type {
  AgentSelfCardFact,
  AgentSelfChatFact,
  AgentSelfStateFacts,
} from './providers/variable-providers-agent-self.js'

// 开给设置页的操作。
export {
  deleteOnethingVariableForIpc,
  listOnethingVariablesForIpc,
  setOnethingVariableForIpc,
} from './variable-ipc-operations.js'
export type { VariablesDeleteRequest, VariablesListRequest, VariablesSetRequest } from './variable-ipc-operations.js'
