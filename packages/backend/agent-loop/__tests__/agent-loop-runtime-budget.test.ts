import { describe, expect, it } from 'vitest'
import { clampAgentLoopRequestMaxTokens, getContextCompactReason, resolveAgentLoopContextBudgetWithRegistry } from '@onething/backend/agent-loop'
import { positiveTokenLimit, resolveAgentLoopContextBudgetValues } from '../agent-loop-runtime-budget.js'
import { getContextUsageTriggerReason } from '../agent-loop-context-usage.js'

describe('core agent-loop runtime helpers', () => {
  it('resolves context budget through injected model registry adapters', async () => {
    await expect(resolveAgentLoopContextBudgetWithRegistry({
      providerId: 'deepseek',
      providerConfig: {
        model: 'deepseek-chat',
        maxOutputByModel: { 'deepseek-chat': 900 },
      },
      contextCompactThreshold: 70,
      resolveModelContextLength: async () => 32000,
      resolveModelMaxOutputTokens: async () => 8192,
    })).resolves.toEqual({
      budget: {
        modelContextLength: 32000,
        reservedOutputTokens: 900,
        thresholdPercent: 70,
      },
    })

    const calls: string[] = []
    await expect(resolveAgentLoopContextBudgetWithRegistry({
      providerId: 'deepseek',
      capabilities: {
        maxInputTokens: 64000,
        maxOutputTokens: 12000,
      },
      providerConfig: { model: 'deepseek-reasoner' },
      resolveModelContextLength: async () => {
        calls.push('context')
        return 32000
      },
      resolveModelMaxOutputTokens: async () => {
        calls.push('output')
        return 8192
      },
    })).resolves.toEqual({
      budget: {
        modelContextLength: 64000,
        reservedOutputTokens: 6000,
        thresholdPercent: 85,
      },
    })
    expect(calls).toEqual([])
  })

  // 解析出错 = 我们没问出这个模型的上限 = 不知道(2026-09-09 裁定)。
  // 从前这里回「设置里的那个数 || 4096」,等于在兜底里替模型编一个上限。
  it('falls back when injected model registry lookup fails: 预留量缺席,不编数', async () => {
    const result = await resolveAgentLoopContextBudgetWithRegistry({
      providerId: 'deepseek',
      capabilities: {},
      providerConfig: { model: 'deepseek-chat' },
      contextCompactThreshold: 75,
      resolveModelContextLength: async () => {
        throw new Error('registry unavailable')
      },
    })

    expect(result.budget).toEqual({
      modelContextLength: 128000,
      thresholdPercent: 75,
    })
    expect(result.budget.reservedOutputTokens).toBeUndefined()
    expect(result.error).toBeInstanceOf(Error)
  })

  // 事故 fe5261d9(2026-09-09):`deepseek-v4.1-flash-expires-on-0910` 不在目录里,
  // 从前一路编成 4096 → 对半 2048 → reasoning 吃光后 `length` 收场。
  it('目录没有 + 无覆盖 ⇒ 预留量缺席(不传 max_tokens)', async () => {
    const result = await resolveAgentLoopContextBudgetWithRegistry({
      providerId: 'deepseek',
      providerConfig: { model: 'deepseek-v4.1-flash-expires-on-0910' },
      resolveModelContextLength: async () => 128000,
      resolveModelMaxOutputTokens: async () => undefined,
    })
    expect(result.budget.reservedOutputTokens).toBeUndefined()
    expect(clampAgentLoopRequestMaxTokens({
      budget: result.budget,
      providerInputTokens: 1000,
    })).toBeUndefined()
    // 上限未知时不拿窗口余量另造一个数 —— 128000 − 1000 也不算数。
    expect(clampAgentLoopRequestMaxTokens({
      budget: result.budget,
      providerInputTokens: 0,
    })).toBeUndefined()
  })

  it('目录没有、但用户在 maxOutputByModel 里写了 3000 ⇒ 3000(写了就是「知道」)', async () => {
    const result = await resolveAgentLoopContextBudgetWithRegistry({
      providerId: 'deepseek',
      providerConfig: {
        model: 'deepseek-v4.1-flash-expires-on-0910',
        maxOutputByModel: { 'deepseek-v4.1-flash-expires-on-0910': 3000 },
      },
      resolveModelContextLength: async () => 128000,
      resolveModelMaxOutputTokens: async () => undefined,
    })
    expect(result.budget.reservedOutputTokens).toBe(3000)
    expect(clampAgentLoopRequestMaxTokens({
      budget: result.budget,
      providerInputTokens: 1000,
    })).toBe(3000)
  })

  it('目录知道 384000 ⇒ 对半 192000,已知上限的行为一字不变', async () => {
    const result = await resolveAgentLoopContextBudgetWithRegistry({
      providerId: 'deepseek',
      providerConfig: { model: 'deepseek-v4-pro' },
      resolveModelContextLength: async () => 1048576,
      resolveModelMaxOutputTokens: async () => 384000,
    })
    expect(result.budget.reservedOutputTokens).toBe(192000)
  })

  it('floors positive finite token limits only', () => {
    expect(positiveTokenLimit(10.8)).toBe(10)
    expect(positiveTokenLimit(0)).toBeUndefined()
    expect(positiveTokenLimit(Number.POSITIVE_INFINITY)).toBeUndefined()
  })

  it('resolves context budget values without model registry dependencies', () => {
    expect(resolveAgentLoopContextBudgetValues({
      providerConfig: {
        model: 'deepseek-chat',
      },
      registeredModelContextLength: 64000,
      registeredModelMaxOutputTokens: 8192,
      contextCompactThreshold: 90,
    })).toEqual({
      modelContextLength: 64000,
      reservedOutputTokens: 4096,
      thresholdPercent: 90,
    })

    expect(resolveAgentLoopContextBudgetValues({
      capabilities: {
        maxInputTokens: 200000.9,
        maxOutputTokens: 12000,
      },
      providerConfig: {
        model: 'deepseek-reasoner',
        maxOutputByModel: {
          'deepseek-reasoner': 20000,
        },
      },
      registeredModelContextLength: 64000,
      registeredModelMaxOutputTokens: 8192,
    })).toEqual({
      modelContextLength: 200000,
      reservedOutputTokens: 12000,
      thresholdPercent: 85,
    })

    // 上限未知 + 无覆盖 ⇒ 预留量缺席(2026-09-09;从前这里是 4096,
    // 中途还短暂读过设置里的 chat.maxTokens,那一格已整格退役)。
    expect(resolveAgentLoopContextBudgetValues({
      providerConfig: { model: 'custom-small' },
    })).toEqual({
      modelContextLength: 128000,
      thresholdPercent: 85,
    })
  })

  // 回归(2026-08-23,grok-4.5/4.6 形状):models.dev 上 context 与 max output
  // 都是 500000,预留照旧取一半 = 250000。从前那条 hard-limit 线
  // (input + 250000 >= 500000 − margin)会在 ~50% 抢在用户的 90% 前面触发;
  // 现在预留只喂请求的 maxTokens,一格都不进触发判定。
  it('never lets reserved output influence the compact trigger', () => {
    const budget = resolveAgentLoopContextBudgetValues({
      providerConfig: { model: 'grok-4.5' },
      registeredModelContextLength: 500000,
      registeredModelMaxOutputTokens: 500000,
      contextCompactThreshold: 90,
    })
    expect(budget).toEqual({
      modelContextLength: 500000,
      // 请求的 max_tokens 照旧是"模型最大输出的一半"——公式没动。
      reservedOutputTokens: 250000,
      thresholdPercent: 90,
    })

    const cases: Array<{ inputTokens: number; expected: 'none' | 'threshold' }> = [
      // 262435 / 500000 = 52.5%:旧 hard-limit 线上早就红了,新判据必须是 'none'。
      { inputTokens: 262435, expected: 'none' },
      { inputTokens: 449999, expected: 'none' },
      { inputTokens: 450000, expected: 'threshold' },
    ]
    for (const { inputTokens, expected } of cases) {
      expect(getContextUsageTriggerReason({
        inputTokens,
        modelContextLength: budget.modelContextLength,
        thresholdPercent: budget.thresholdPercent,
      })).toBe(expected)
      expect(getContextCompactReason({
        session: { contextSize: inputTokens },
        modelContextLength: budget.modelContextLength,
        thresholdPercent: budget.thresholdPercent,
        inputTokens,
      })).toBe(expected === 'threshold' ? 'threshold' : null)
    }
  })
})
