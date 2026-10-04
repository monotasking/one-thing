/**
 * 执行器注册表(E0)。`resolveAgentExecutor` 是**单点**:任何「这个 agent /
 * 这个 provider 的回合由谁执行、它支持什么」的问题都从这里问。
 *
 * E0 交付的是骨架:执行器对象带齐 id / kind / capabilities,`runTurn` 留空
 * 待 E4 接真实驱动(local 走引擎工具循环,external 走 connector.streamTurn),
 * `interrupt` / `dispose` 留成可选待 E5 的停止三级接线。骨架先行的意义是
 * 让**能力查询这一面**立刻可用——压缩门与鉴权豁免今天就能改问能力,不必
 * 等驱动搬完。
 */
import {
  findAgentExecutorDescriptor,
  isExternalAgentExecutorId,
  localAgentExecutorDescriptor,
  unknownExternalExecutorDescriptor,
  type AgentExecutorDescriptor,
} from '@onething/backend/agent-loop'
import {
  agentExecutorIdFromSelection,
  resolveAgentExecutorSelection,
  type AgentExecutorSelectionSource,
} from './agent-executor-selection.js'
import type { AgentExecutor } from './agent-executor-types.js'

/**
 * 描述 → 执行器骨架。E0 不带 `runTurn`:声明一个立刻抛错的实现只会让调用
 * 方以为它能跑,留空(可选成员)让类型系统在 E4 之前就挡住误用。
 */
function createAgentExecutorFromDescriptor(descriptor: AgentExecutorDescriptor): AgentExecutor {
  return {
    id: descriptor.id,
    kind: descriptor.kind,
    capabilities: descriptor.capabilities,
  }
}

/** 本地执行器骨架:引擎 + 我们自己的工具循环(E4 接驱动)。 */
export function createLocalAgentExecutor(): AgentExecutor {
  return createAgentExecutorFromDescriptor(localAgentExecutorDescriptor())
}

/**
 * 外部执行器骨架:包住一个 connector(E4 接驱动)。未登记的 connectorId
 * 仍返回一个执行器——它确实是外部的——但能力全保守,详见执行器表
 * (`agent-loop/agent-loop-external-agent-providers.ts` 的 `unknownExternalExecutorDescriptor`)。
 */
export function createExternalAgentExecutor(connectorId: string): AgentExecutor {
  const descriptor = findAgentExecutorDescriptor(connectorId)
  return createAgentExecutorFromDescriptor(
    descriptor?.kind === 'external' ? descriptor : unknownExternalExecutorDescriptor(connectorId),
  )
}

/**
 * 单点解析:传 agent(显式 executor 字段优先,缺省由 model.providerId 推导)
 * 或直接传一个 providerId。
 */
export function resolveAgentExecutor(
  source: AgentExecutorSelectionSource | string | undefined,
): AgentExecutor {
  const selection = resolveAgentExecutorSelection(source)
  if (selection.type === 'external') return createExternalAgentExecutor(selection.connectorId)
  return createLocalAgentExecutor()
}

/** 解析结果的 id,免去调用方为了看一眼 id 而造一个执行器对象。 */
export function resolveAgentExecutorId(
  source: AgentExecutorSelectionSource | string | undefined,
): string {
  return agentExecutorIdFromSelection(resolveAgentExecutorSelection(source))
}

/**
 * 鉴权豁免的判据(取代 provider-config 里的 id 名单):外部执行体的登录归
 * 它自己的 CLI,引擎侧凭据故意留空。
 */
export function isExternalAgentExecutorProvider(providerId: string): boolean {
  return isExternalAgentExecutorId(providerId)
}

/** 压缩分流的判据。core 侧同一问题走 `coreProviderOwnsItsContextWindow`。 */
export function agentExecutorOwnsContextWindow(providerId: string): boolean {
  return resolveAgentExecutor(providerId).capabilities.contextWindow === 'theirs'
}

/*
 * 从前这里末尾有一句加载期副作用 `syncAgentExecutorsToCore()`:把执行器表里压缩门要的两条事实
 * 抄进 agent-loop 的登记表。2026-10-04(越层清零 C2)两张表并成一张、住进 agent-loop
 * (`agent-loop/agent-loop-external-agent-providers.ts`),没有东西要抄了,那句与那个函数一起删掉。
 */
