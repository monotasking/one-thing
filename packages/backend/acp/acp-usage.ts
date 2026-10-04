/**
 * 一轮 ACP prompt 的用量(A2-b,方案 `docs/design/acp-integration-2026-09.md` §3.3 / §11.6)。
 *
 * **账本只写一次,写的人是引擎**:ACP 这一轮的 `finish` 分片带着 `usage` 走进 agent-loop,
 * 装配层的执行器在回合边界对**每一家** provider 都调一次 `recordUsage`
 * (`backend/engine/stream/engine-stream-agent-loop-executor.ts` 的 `syncLastTurnUsage`)。所以这里
 * 不再另起一条写账的路 —— 那会是同一轮两行账。这里只负责把协议给的东西**一格不丢**地折进
 * `AgentUsage`:
 *
 *  - `PromptResponse.usage` 的 input / output / total 原样;`thoughtTokens` → `reasoningTokens`,
 *    `cachedReadTokens` / `cachedWriteTokens` → `cacheReadTokens` / `cacheWriteTokens`
 *    (A2-b 之前这三格在客户端就被丢了)。
 *  - `usage_update.cost` 是**整条会话的累计成本**(协议原文 "Total cumulative cost for session"),
 *    不是这一轮的。这一轮的报价 = 这一轮收场时的累计 − 上一次见到的累计,只在币种是 USD 时算
 *    (账本那一格是 USD);基线不知道(恢复出来的会话、本进程里还没见过报价)就这一轮不报,
 *    只记下基线 —— 宁可少一格报价,不把会话历史的钱记到这一轮头上。
 *  - `usageSource: 'acp'`:账本的「类目」由 provider 自述(引擎不认识 ACP 这个名字)。
 *
 * 本地价目估算(`costUSD`)照旧由账本按价目表算:agent id 不在价目表里,于是它是 `null`,
 * 厂商报价另存 `providerCostUSD` —— 账本两格并存的约定,见 `usage/usage-types.ts`。
 */
import type { AgentUsage } from '@onething/backend/agent-loop/loop-primitives'

/** 账本里 ACP 回合的类目。 */
export const ACP_USAGE_SOURCE = 'acp'

/** `PromptResponse.usage` 的结构化子集(夹具可以直接写字面量)。 */
export interface AcpWireUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  thoughtTokens?: number | null
  cachedReadTokens?: number | null
  cachedWriteTokens?: number | null
}

/** 累计成本(`usage_update.cost`)。 */
export interface AcpCumulativeCost {
  amount: number
  currency: string
}

export interface AcpTurnCost {
  /** 这一轮的报价(USD);算不出就缺席。 */
  providerCostUSD?: number
  /** 下一轮的基线(USD 累计);不知道 = undefined。 */
  nextBaseline: number | undefined
}

function isUsd(cost: AcpCumulativeCost | undefined): cost is AcpCumulativeCost {
  return Boolean(cost) && typeof cost!.amount === 'number' && Number.isFinite(cost!.amount)
    && cost!.currency.trim().toUpperCase() === 'USD'
}

/**
 * 这一轮的报价。`baseline` = 上一次见到的 USD 累计(新开的会话从 0 起);`current` = 收场时的
 * 累计。累计变小(agent 换了会话 / 重置)= 不报,基线跟过去。
 */
export function acpTurnCost(baseline: number | undefined, current: AcpCumulativeCost | undefined): AcpTurnCost {
  if (!isUsd(current)) return { nextBaseline: baseline }
  if (baseline === undefined || current.amount < baseline) return { nextBaseline: current.amount }
  const delta = current.amount - baseline
  return {
    ...(delta > 0 ? { providerCostUSD: Number(delta.toFixed(10)) } : {}),
    nextBaseline: current.amount,
  }
}

function count(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 协议的 usage + 这一轮的报价 → 引擎的 `AgentUsage`。没有 usage 就没有账(与别家 provider 同一条)。 */
export function acpAgentUsage(usage: AcpWireUsage | null | undefined, providerCostUSD?: number): AgentUsage | undefined {
  if (!usage) return undefined
  const reasoning = count(usage.thoughtTokens)
  const cacheRead = count(usage.cachedReadTokens)
  const cacheWrite = count(usage.cachedWriteTokens)
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
    ...(providerCostUSD !== undefined ? { providerCostUSD } : {}),
    usageSource: ACP_USAGE_SOURCE,
  }
}
