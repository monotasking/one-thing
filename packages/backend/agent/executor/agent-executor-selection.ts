/**
 * agent → 执行器的选择(域模型 M7 的接线,E0)。
 *
 * `agents/store.ts` 的 `executor` 字段自 A0 起只有语义没有行为
 * (agent-domain-model.md M7 原文「本期只定义语义不接线」)。本期兑现它,
 * 但**不能靠它改变今天的行为**:线上 agents.json 里一行 executor 都没有,
 * 外部 agent 走外部通路全靠 `model.providerId === 'acp'`(A6-b 前是 'claude-code-agent')。
 *
 * 所以选择规则是两级,顺序不可颠倒:
 *   1. 显式 `executor` 字段(将来 UI 里选执行器时写入)——优先;
 *   2. 缺省时由 `model.providerId` 推导——这就是今天的行为,原样保留。
 *
 * 结论:只配了 providerId 的老 agent,解析结果与改造前逐字节一致。
 */
import type { OnethingAgentExecutor } from '../agent-store.js'
import { isExternalAgentExecutorId } from './agent-executor-capabilities.js'

/**
 * 选择所需的最小输入面。刻意不收 `OnethingAgentDefinition` 全形:调用方
 * 手上可能只有心智面投影(`agentMind`)或一个裸 providerId。
 */
export interface AgentExecutorSelectionSource {
  executor?: OnethingAgentExecutor
  model?: { providerId?: string }
}

const NATIVE: OnethingAgentExecutor = { type: 'native' }

/** providerId → 执行器选择。未登记为外部执行器的一律本地。 */
export function agentExecutorSelectionFromProviderId(
  providerId: string | undefined,
): OnethingAgentExecutor {
  if (providerId && isExternalAgentExecutorId(providerId)) {
    return { type: 'external', connectorId: providerId }
  }
  return NATIVE
}

/**
 * agent(或裸 providerId)→ 执行器选择。显式字段优先,缺省回落 providerId。
 *
 * 注意 `{ type: 'external' }` 但 connectorId 为空的情况在 store 归一化时
 * 已经被丢弃(半成品值不入库),这里再兜一次:空 connectorId 无法驱动任何
 * 东西,退回 providerId 推导比返回一个跑不动的选择更接近调用方的本意。
 */
export function resolveAgentExecutorSelection(
  source: AgentExecutorSelectionSource | string | undefined,
): OnethingAgentExecutor {
  if (typeof source === 'string') return agentExecutorSelectionFromProviderId(source)
  if (!source) return NATIVE

  const explicit = source.executor
  if (explicit?.type === 'external' && explicit.connectorId) {
    return { type: 'external', connectorId: explicit.connectorId }
  }
  if (explicit?.type === 'native') return NATIVE

  return agentExecutorSelectionFromProviderId(source.model?.providerId)
}

/** 选择 → 执行器 id。本地执行器的 id 就是 'local'。 */
export function agentExecutorIdFromSelection(selection: OnethingAgentExecutor): string {
  return selection.type === 'external' ? selection.connectorId : 'local'
}
