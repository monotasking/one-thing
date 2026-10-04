import { describe, expect, it } from 'vitest'
// A0-3 起 core 不内置「acp 的上下文归它自己管」这条事实;生产里它由 backend.ts 静态 import
// 执行器注册表登记进来,这里照同一条路登记,压缩门才认得 acp。
import '@onething/backend/agent/executor/agent-executor-registry'
import { getContextCompactReason, maybeCompactAgentLoopContextWithAdapters } from '@onething/backend/agent-loop'
import { applyAgentLoopContextCompactResult, buildAgentLoopContextCompactEventPlan, createAgentLoopCompactState, planAgentLoopContextCompactFinal, planAgentLoopContextCompactPass, shouldStartAgentLoopContextCompact } from '../agent-loop-runtime-compaction.js'
import { getContextUsageTriggerReason } from '../agent-loop-context-usage.js'

describe('core agent-loop runtime helpers', () => {
  // 2026-08-23:hard-limit 触发整条删除 —— 判定只认用户百分比。9900/10000 过线,
  // 所以是 'threshold';8000/10000(80% < 85%)不过线,哪怕"输入 + 任何预留输出"
  // 早就贴满窗口,也只能是 'none'。
  it('judges a provider turn on the user threshold only', () => {
    expect(getContextCompactReason({
      session: { contextSize: 9900 },
      sessionMessages: [],
      modelContextLength: 10000,
      thresholdPercent: 85,
    })).toBe('threshold')

    expect(getContextCompactReason({
      session: { contextSize: 8000 },
      sessionMessages: [],
      modelContextLength: 10000,
      thresholdPercent: 85,
    })).toBe(null)

    expect(getContextUsageTriggerReason({
      inputTokens: 8000,
      modelContextLength: 10000,
      thresholdPercent: 85,
    })).toBe('none')
  })

  it('plans agent-loop context compact passes and result transitions in core', () => {
    expect(shouldStartAgentLoopContextCompact({
      turn: 1,
      providerId: 'deepseek',
      compactEnabled: true,
    })).toBe(false)
    expect(shouldStartAgentLoopContextCompact({
      turn: 2,
      providerId: 'acp',
      compactEnabled: true,
    })).toBe(false)
    expect(shouldStartAgentLoopContextCompact({
      turn: 2,
      providerId: 'deepseek',
      compactEnabled: true,
    })).toBe(true)

    const budget = {
      modelContextLength: 10000,
      reservedOutputTokens: 512,
      thresholdPercent: 85,
    }
    const initial = createAgentLoopCompactState(3)
    expect(planAgentLoopContextCompactPass({
      state: initial,
      session: { messages: [], contextSize: 9000 },
      providerId: 'deepseek',
      budget,
    })).toEqual({
      kind: 'compact',
      state: initial,
      reason: 'threshold',
      keepRecentTurns: 3,
      pass: 1,
    })

    expect(planAgentLoopContextCompactPass({
      state: initial,
      session: { messages: [], contextSize: 12000 },
      providerId: 'codex',
      budget,
      providerUsageMismatch: true,
    })).toEqual({
      kind: 'skip-provider-usage-mismatch',
      state: initial,
    })

    const skipped = applyAgentLoopContextCompactResult({
      state: initial,
      reason: 'threshold',
      success: true,
      skipped: true,
    })
    expect(skipped).toEqual({
      kind: 'retry',
      state: {
        configuredKeepTurns: 3,
        keepRecentTurns: 2,
        pass: 2,
        compacted: false,
      },
    })

    // 2026-08-23:压过一次就收 —— 'hard-limit' 那条会递减 keepRecentTurns 再重来
    // 的支线随触发器一起删除,失败一律 'stop'。
    const compacted = applyAgentLoopContextCompactResult({
      state: skipped.state,
      reason: 'threshold',
      success: true,
      skipped: false,
    })
    expect(compacted).toEqual({
      kind: 'stop',
      state: {
        configuredKeepTurns: 3,
        keepRecentTurns: 2,
        pass: 2,
        compacted: true,
      },
    })

    expect(applyAgentLoopContextCompactResult({
      state: compacted.state,
      reason: 'threshold',
      success: false,
    })).toEqual({
      kind: 'stop',
      state: compacted.state,
    })

    // 收尾计划只看"这一轮压过没有",不再有把仍然超窗当错误抛出的分支。
    expect(planAgentLoopContextCompactFinal({
      state: compacted.state,
    })).toEqual({ kind: 'rebuild' })

    expect(planAgentLoopContextCompactFinal({
      state: { configuredKeepTurns: 3, keepRecentTurns: 3, pass: 1, compacted: false },
    })).toEqual({ kind: 'none' })
  })

  it('builds context compact event plans without an EventBus', () => {
    expect(buildAgentLoopContextCompactEventPlan({
      success: true,
      skipped: false,
      summary: 'summary',
      retainedContextSize: 123,
    })).toEqual([
      {
        type: 'context:compact-completed',
        success: true,
        skipped: false,
        summary: 'summary',
        error: undefined,
      },
      {
        type: 'context:size-updated',
        contextSize: 123,
      },
    ])

    expect(buildAgentLoopContextCompactEventPlan({
      success: true,
      skipped: true,
    })).toEqual([
      {
        type: 'context:compact-completed',
        success: true,
        skipped: true,
        summary: undefined,
        error: undefined,
      },
    ])
  })

  it('runs context compaction through injected adapters and rebuilds messages', async () => {
    let session = {
      contextSize: 95,
      lastInputTokens: 95,
      messages: [],
    }
    const emitted: unknown[] = []
    const compactCalls: unknown[] = []
    const rebuilt = [{ role: 'user', content: 'rebuilt' }]

    await expect(maybeCompactAgentLoopContextWithAdapters({
      ctx: {
        sessionId: 's1',
        providerId: 'deepseek',
        providerConfig: { model: 'deepseek-chat' },
        settings: { chat: { contextCompactEnabled: true } },
      },
      turn: 2,
      messages: [],
      budget: {
        modelContextLength: 100,
        reservedOutputTokens: 10,
        thresholdPercent: 80,
      },
      compactEnabled: true,
      keepRecentTurns: 6,
      adapters: {
        getSession: () => session,
        compactSessionContext: async input => {
          compactCalls.push(input)
          await input.onMessageCreated({ id: 'compact-message' })
          await input.onMessageUpdated('compact-message', { content: 'summary' })
          session = {
            contextSize: 30,
            lastInputTokens: 30,
            messages: [],
          }
          return {
            success: true,
            summary: 'summary',
            retainedContextSize: 30,
          }
        },
        emitEvent: async (_sessionId, event) => {
          emitted.push(event)
        },
        rebuildMessages: async () => rebuilt,
        logger: {},
      },
    })).resolves.toBe(rebuilt)

    expect(compactCalls).toHaveLength(1)
    expect(compactCalls[0]).toMatchObject({
      sessionId: 's1',
      providerId: 'deepseek',
      configWithApiKey: {
        model: 'deepseek-chat',
        apiKey: '',
      },
      keepRecentTurns: 6,
    })
    expect(emitted).toEqual([
      { type: 'message:created', message: { id: 'compact-message' } },
      { type: 'message:updated', messageId: 'compact-message', updates: { content: 'summary' } },
      {
        type: 'context:compact-completed',
        success: true,
        skipped: undefined,
        summary: 'summary',
        error: undefined,
      },
      { type: 'context:size-updated', contextSize: 30 },
    ])
  })

  it('skips context compaction through injected provider-usage mismatch policy', async () => {
    const logger = { warn: () => undefined }
    await expect(maybeCompactAgentLoopContextWithAdapters({
      ctx: {
        sessionId: 's1',
        providerId: 'deepseek',
        providerConfig: { model: 'deepseek-chat' },
        settings: {},
      },
      turn: 2,
      messages: [],
      budget: {
        modelContextLength: 100,
        reservedOutputTokens: 10,
        thresholdPercent: 80,
      },
      compactEnabled: true,
      keepRecentTurns: 6,
      adapters: {
        getSession: () => ({ contextSize: 120, lastInputTokens: 120, messages: [] }),
        shouldSkipProviderUsageMismatch: () => true,
        compactSessionContext: async () => {
          throw new Error('compact should not run')
        },
        emitEvent: async () => undefined,
        rebuildMessages: async () => [{ role: 'user', content: 'unexpected' }],
        logger,
      },
    })).resolves.toBeUndefined()
  })
})
