export {
  DEFAULT_AGENT_ID,
  agentExists,
  createAgent,
  defaultAgent,
  deleteAgent,
  displayAgent,
  findAgent,
  getAgent,
  initializeAgents,
  invalidateAgentsCache,
  listAgents,
  requireAgent,
  restoreAgent,
  retireAgent,
  updateAgent,
} from '@onething/runtime/agents/store-bound.wiring'
/** 在场面(M6):现算,不落库。四路全空 = 从未被引用(A2 硬删判定的依赖)。 */
export { hasAnyReference, listAgentPresence } from './presence.js'
