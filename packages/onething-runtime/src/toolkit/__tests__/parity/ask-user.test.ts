/**
 * R3a 对拍 —— `ask_user`。
 * 旧 `tools/builtin/ask-user.ts` vs 新 `toolkit/builtin/ask-user.ts`。
 *
 * 四种收场(answered / declined / timeout / aborted)在旧路都是**正常返回**;
 * 新路里前三种照旧,而"回合被中止"这一种由内核统一结成 `Outcome.aborted`
 * —— 这是尺子③(信号一响,结果恒为 aborted)的直接后果,逐条记在设计文档 §13。
 */

import { describe, expect, it, vi } from 'vitest'
import type { InteractionAnswer } from '@onething/core/interaction'
import { Outcome } from '@onething/core/toolkit'
import { createAskUserTool as createLegacyAskUserTool } from '../../../tools/builtin/ask-user.js'
import { zodToJsonSchema } from '../../../tools/tool.js'
import {
  ASK_USER_ABORTED_REASON,
  AskUserInputSchema,
  createAskUserTool,
  type AskUserToolAdapters,
} from '../../builtin/ask-user.js'
import { annotationsOf, legacyContext, modelTextOf, normalizeDetails, runNewTool } from '../support.js'

const ARGS = {
  questions: [{
    question: '先修 A 还是 B?',
    header: '优先级',
    allowFreeText: true,
    options: [{ label: 'A', description: '快' }, { label: 'B' }],
  }],
}

function answerFor(outcome: InteractionAnswer['outcome'], anchor: string): InteractionAnswer {
  if (outcome === 'answered') {
    return { id: 'i1', answers: { [`${anchor}:0`]: { selected: ['A'], freeText: '顺便看看 C' } }, outcome }
  }
  return { id: 'i1', answers: {}, outcome, reason: `${outcome} 了` }
}

function adaptersFor(outcome: InteractionAnswer['outcome']): AskUserToolAdapters {
  return {
    ask: async input => answerFor(outcome, input.toolCallId ?? ''),
    abort: vi.fn(),
  }
}

describe('parity: ask_user', () => {
  it('spec 与旧工具逐字对齐', () => {
    const legacy = createLegacyAskUserTool(adaptersFor('answered'))
    const tool = createAskUserTool(adaptersFor('answered'))
    expect(tool.spec.description).toBe(legacy.description)
    expect(tool.spec.input).toEqual(zodToJsonSchema(AskUserInputSchema))
    // 新增的静态上界。`user_ask` 在策略表里是 silent —— 不会多出一张权限卡。
    expect(tool.spec.effects).toEqual(['user_ask'])
  })

  for (const outcome of ['answered', 'declined', 'timeout'] as const) {
    it(`模型文本与渲染信息一致:${outcome}`, async () => {
      const { ctx } = legacyContext()
      const legacy = await createLegacyAskUserTool(adaptersFor(outcome))
        .execute(ARGS as never, ctx as never)

      const run = await runNewTool(createAskUserTool(adaptersFor(outcome)), ARGS)
      expect(run.outcome.kind).toBe('ok')
      expect(modelTextOf(run.outcome)).toBe(legacy.output)
      expect(annotationsOf(run).at(-1)?.title).toBe(legacy.title)
      expect(normalizeDetails(annotationsOf(run).at(-1)?.details)).toEqual(normalizeDetails(legacy.metadata))
    })
  }

  it('边界:题 id 的锚仍然是 toolCallId(答案表按它对上题面)', async () => {
    const seen: string[] = []
    const adapters: AskUserToolAdapters = {
      ask: async input => {
        seen.push(...input.questions.map(question => question.id))
        return answerFor('answered', input.toolCallId ?? '')
      },
      abort: vi.fn(),
    }
    await runNewTool(createAskUserTool(adapters), ARGS, { callId: 'call-42' })
    expect(seen).toEqual(['call-42:0'])
  })

  it('边界:plan 的预览带着题面(提问栏位收场后会话里不留痕,这是唯一的记录)', async () => {
    const run = await runNewTool(createAskUserTool(adaptersFor('answered')), ARGS)
    expect(run.intent.preview?.title).toBe('向用户提问:先修 A 还是 B?')
    expect(run.intent.effects.map(effect => effect.kind)).toEqual(['user_ask'])
  })

  it('错误:questions 空数组不合契约', async () => {
    const run = await runNewTool(createAskUserTool(adaptersFor('answered')), { questions: [] })
    expect(run.outcome.kind).toBe('invalid')
    expect(Outcome.toModelText(run.outcome)).toContain('Invalid arguments')
  })

  /**
   * **有意的差异**(§13 差异表 2):旧路把「回合被中止」翻成一条正常的工具结果
   * (outcome: 'aborted');新路里它是内核的 `Outcome.aborted`。撤回登记照旧发生。
   */
  it('取消:信号先响 —— 新路结成 aborted,旧路给一条 aborted 结果', async () => {
    const controller = new AbortController()
    controller.abort()

    const { ctx } = legacyContext({ signal: controller.signal })
    const legacy = await createLegacyAskUserTool(adaptersFor('answered'))
      .execute(ARGS as never, ctx as never)
    expect(legacy.metadata.outcome).toBe('aborted')
    expect(legacy.metadata.reason).toBe(ASK_USER_ABORTED_REASON)

    const run = await runNewTool(createAskUserTool(adaptersFor('answered')), ARGS, { signal: controller.signal })
    expect(run.outcome.kind).toBe('aborted')
  })

  it('取消:等待期间信号响了 —— 撤回被调用一次,结局是 aborted', async () => {
    const controller = new AbortController()
    const abort = vi.fn()
    const adapters: AskUserToolAdapters = {
      ask: () => new Promise<InteractionAnswer>(() => {}),
      abort,
    }
    const promise = runNewTool(createAskUserTool(adapters), ARGS, { signal: controller.signal, callId: 'call-7' })
    await new Promise(resolve => setTimeout(resolve, 0))
    controller.abort()
    const run = await promise

    expect(run.outcome.kind).toBe('aborted')
    expect(abort).toHaveBeenCalledTimes(1)
    expect(abort.mock.calls[0]?.[0]).toMatchObject({
      toolCallId: 'call-7',
      reason: ASK_USER_ABORTED_REASON,
    })
  })
})
