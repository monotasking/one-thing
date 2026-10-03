/**
 * AgentExecutor 抽象(claude-code-integration-v2 §3,E0 期)。
 * 「思考在哪里发生」被收进这一层,上层不再需要认出外部 agent。
 */
export type {
  AgentExecutor,
  AgentExecutorCapabilities,
  AgentExecutorId,
  AgentExecutorKind,
  AgentExecutorTurnEvent,
  AgentExecutorTurnRequest,
} from './types.js'
export {
  LOCAL_AGENT_EXECUTOR_ID,
  findAgentExecutorDescriptor,
  isExternalAgentExecutorId,
  listAgentExecutorDescriptors,
  localAgentExecutorDescriptor,
  unknownExternalExecutorDescriptor,
  type AgentExecutorDescriptor,
} from './capabilities.js'
export {
  agentExecutorIdFromSelection,
  agentExecutorSelectionFromProviderId,
  resolveAgentExecutorSelection,
  type AgentExecutorSelectionSource,
} from './selection.js'
export {
  agentExecutorOwnsContextWindow,
  createExternalAgentExecutor,
  createLocalAgentExecutor,
  isExternalAgentExecutorProvider,
  resolveAgentExecutor,
  resolveAgentExecutorId,
  syncAgentExecutorsToCore,
} from './registry.js'
