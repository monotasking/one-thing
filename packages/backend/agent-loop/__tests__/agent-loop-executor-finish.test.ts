import { describe, expect, it } from 'vitest'
import { synthesizeCoreToolAnchors } from '@shared/session/render-anchors'
import { buildAgentLoopFinalMessageUpdate, completeAgentLoopStreamWithAdapters, createAgentLoopNextAssistantWriterPlan, emitAgentLoopFinalMessageUpdateWithAdapters } from '@onething/backend/agent-loop'
import { applyAgentLoopFinishChunkWithAdapters, createAgentLoopAssistantMessage, planAgentLoopFinishChunk } from '../agent-loop-executor-finish.js'

describe('core agent-loop executor helpers', () => {
  it('creates assistant message shells and final message updates in core', () => {
    expect(createAgentLoopAssistantMessage({
      id: 'assistant-1',
      model: 'deepseek-chat',
      provider: 'deepseek',
      timestamp: 1234,
    })).toEqual({
      id: 'assistant-1',
      role: 'assistant',
      model: 'deepseek-chat',
      provider: 'deepseek',
      content: '',
      timestamp: 1234,
      isStreaming: true,
      thinkingStartTime: 1234,
      toolCalls: [],
      contentParts: [],
    })

    expect(createAgentLoopNextAssistantWriterPlan({
      id: 'assistant-2',
      model: 'deepseek-reasoner',
      provider: 'deepseek',
      timestamp: 2234,
    })).toEqual({
      assistantMessage: {
        id: 'assistant-2',
        role: 'assistant',
        model: 'deepseek-reasoner',
        provider: 'deepseek',
        content: '',
        timestamp: 2234,
        isStreaming: true,
        thinkingStartTime: 2234,
        toolCalls: [],
        contentParts: [],
      },
      events: [
        {
          type: 'message:assistant-created',
          message: {
            id: 'assistant-2',
            role: 'assistant',
            model: 'deepseek-reasoner',
            provider: 'deepseek',
            content: '',
            timestamp: 2234,
            isStreaming: true,
            thinkingStartTime: 2234,
            toolCalls: [],
            contentParts: [],
          },
        },
        {
          type: 'stream:start',
          messageId: 'assistant-2',
          assistantMessageId: 'assistant-2',
          model: 'deepseek-reasoner',
        },
      ],
    })

    expect(buildAgentLoopFinalMessageUpdate({
      content: 'done',
      reasoning: 'because',
      contentParts: [{ type: 'text', content: 'done' }],
      toolCalls: [{ id: 'call-1' }],
      steps: [{ id: 'step-1' }],
      usage: { totalTokens: 4 },
      errorDetails: 'details',
    })).toEqual({
      content: 'done',
      reasoning: 'because',
      contentParts: [{ type: 'text', content: 'done' }],
      toolCalls: [{ id: 'call-1' }],
      steps: [{ id: 'step-1' }],
      usage: { totalTokens: 4 },
      errorDetails: 'details',
      isStreaming: false,
    })
  })

  it('emits final message updates and completes streams through core adapters', async () => {
    const message = {
      id: 'assistant-1',
      content: 'done',
      reasoning: 'because',
      contentParts: [{ type: 'text', content: 'done' }],
      toolCalls: [],
      steps: [],
      usage: { totalTokens: 4 },
      errorDetails: undefined,
    }
    const session = {
      name: 'Updated Session',
      messages: [message],
    }
    const events: unknown[] = []

    await expect(emitAgentLoopFinalMessageUpdateWithAdapters({
      sessionId: 's1',
      assistantMessageId: 'assistant-1',
      getSession: () => session,
      emitMessageUpdated: event => {
        events.push(event)
      },
    })).resolves.toBe(true)
    expect(events).toEqual([{
      type: 'message:updated',
      messageId: 'assistant-1',
      updates: {
        content: 'done',
        reasoning: 'because',
        contentParts: [{ type: 'text', content: 'done' }],
        toolCalls: [],
        steps: [],
        usage: { totalTokens: 4 },
        errorDetails: undefined,
        isStreaming: false,
      },
    }])

    await expect(emitAgentLoopFinalMessageUpdateWithAdapters({
      sessionId: 's1',
      assistantMessageId: 'missing',
      getSession: () => session,
      emitMessageUpdated: event => {
        events.push(event)
      },
    })).resolves.toBe(false)

    const calls: string[] = []
    const completions: unknown[] = []
    await completeAgentLoopStreamWithAdapters({
      sessionId: 's1',
      assistantMessageId: 'assistant-1',
      sessionName: 'Fallback',
      accumulatedUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      lastTurnUsage: { inputTokens: 1, outputTokens: 2 },
      finalize: () => {
        calls.push('finalize')
      },
      getSession: () => session,
      emitMessageUpdated: event => {
        calls.push(`emit:${event.messageId}`)
      },
      sendStreamComplete: data => {
        calls.push('complete')
        completions.push(data)
      },
    })

    expect(calls).toEqual(['finalize', 'emit:assistant-1', 'complete'])
    expect(completions).toEqual([{
      sessionName: 'Updated Session',
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      lastTurnUsage: { inputTokens: 1, outputTokens: 2 },
    }])
  })

  /**
   * **收尾修复的产物必须递给采集点,不许回读**(F4-c c4-b,§16.25)。
   *
   * 收尾链上排在 `emitFinalAssistantMessageUpdate` 后面的
   * `captureCancelledToolResults` 要的是"这次修复判死了哪几个 step" ——
   * 它是 `tool/result{cancelled:true}` 的**产地**。
   *
   * 施工时先按"改读投影"做过一版,探针当场量到 48/330 条**整批丢账**:修复的
   * 落盘走命令面 `patchMessage{steps,toolCalls}`,而这两格在 `message/patched`
   * 的 `DERIVED_KEYS` 里(投影只认 `tool/*` 折出来的那一份,不认补丁)——
   * 于是投影侧那几个 step 永远停在 `running`,采集点一条都不写。
   *
   * 所以判据是:`onSettled` 交出来的**必须是修复之后**那一份。反证在同一条里 ——
   * 入参那一份的 step 是 `running`(没有 `cancelled`,采集点会一条都不记)。
   */
  it('hands the settled (repaired) message to the capture hook, never the pre-repair one', async () => {
    const running = {
      id: 'step-c1',
      status: 'running',
      toolCallId: 'c1',
      toolCall: { id: 'c1', status: 'executing' },
    }
    const message = {
      id: 'assistant-settle',
      content: '',
      toolCalls: [{ id: 'c1', status: 'executing' }],
      steps: [running],
    }
    const settled: Array<{ steps?: Array<{ status?: string; error?: string }> }> = []

    await emitAgentLoopFinalMessageUpdateWithAdapters({
      sessionId: 's-settle',
      assistantMessageId: 'assistant-settle',
      getSession: () => ({ messages: [message] }),
      getMessage: () => message,
      emitMessageUpdated: () => {},
      errorMessage: 'User cancelled',
      onSettled: next => {
        settled.push(next as (typeof settled)[number])
      },
    })

    expect(settled).toHaveLength(1)
    // 修复之后:采集点看得到 cancelled,`tool/result{cancelled:true}` 才写得出来。
    expect(settled[0]!.steps?.[0]?.status).toBe('cancelled')
    expect(settled[0]!.steps?.[0]?.error).toBe('User cancelled')
    // 反证:入参那一份还是 running —— 谁把采集点改回读它(或读任何一侧缓存),
    // 被取消工具的结局就整批丢账。
    expect(running.status).toBe('running')
  })

  /**
   * **§15.16 同型合同:settle 快照必须带渲染锚点,来源不限。**
   *
   * §15.16 那一课的机械形状,搬到收尾链上重演一遍:
   *
   *  - settle 快照是**整体覆盖** —— renderer 的 `updateSessionMessage` 只做
   *    `{...message, ...updates}`,不跑 `rebuildContentParts`、不补合成锚点;
   *  - `data-steps` 锚点按 canonical G4 只住渲染侧,投影**故意不产出**;
   *  - 于是快照少了锚点 = 覆盖后锚点归零 = work group 与整段工具渲染消失,
   *    而**正文一个字都没丢**(§15.16 定性:不是数据丢失,是分界塌了)。
   *
   * **F4-b2 立这道门时的结论是"必须读活 run 的写手视图"**(锚点当时只有那一个
   * 产地)。**F4-c c4-b(§16.25 钥匙①)换了来源,没换判据**:锚点改由推送侧用
   * 共享纯件 `synthesizeCoreToolAnchors` 从**折叠产物自己的 steps** 现算,于是
   * 写手对象不再是锚点的必经保管人 —— 那正是 18 个热写端口的解锁条件。
   *
   * 三条断言:①带锚点的取材 → 快照带锚点;②**裸的**投影取材 → 锚点归零(这一条
   * 是反证,它说明现算那一步是承重的,不是装饰);③投影取材 + 现算 → 锚点回来,
   * 而且正文三侧逐字相同。
   */
  it('the settle snapshot keeps render anchors — synthesized from the fold (§15.16 同型)', async () => {
    const writerParts = [
      { type: 'text', content: 'answer', turnIndex: 0 },
      { type: 'data-steps', turnIndex: 0 },
      { type: 'text', content: 'tail', turnIndex: 1 },
    ]
    // 投影侧同一条消息:正文逐字相同,锚点整格没有(G4)。
    const projectedParts = writerParts.filter(part => part.type !== 'data-steps')
    const baseMessage = {
      id: 'assistant-anchor',
      content: 'answer\ntail',
      reasoning: undefined,
      toolCalls: [],
      steps: [{ id: 'step-c1', status: 'completed', toolCallId: 'c1', turnIndex: 0 }],
      usage: undefined,
      errorDetails: undefined,
    }
    const snapshotFrom = async (parts: unknown[]) => {
      const message = { ...baseMessage, contentParts: parts }
      const events: Array<{ updates: { contentParts?: unknown[]; content?: string } }> = []
      await emitAgentLoopFinalMessageUpdateWithAdapters({
        sessionId: 's-anchor',
        assistantMessageId: 'assistant-anchor',
        getSession: () => ({ messages: [message] }),
        getMessage: () => message,
        emitMessageUpdated: event => {
          events.push(event as (typeof events)[number])
        },
      })
      return events[0]!.updates
    }
    // renderer 那一步逐字复刻:整体覆盖,不补锚点。
    const mergeIntoRenderer = (updates: { contentParts?: unknown[] }) =>
      ({ ...baseMessage, contentParts: writerParts, ...updates })

    const fromWriter = await snapshotFrom(writerParts)
    const fromProjection = await snapshotFrom(projectedParts)

    const anchors = (parts: unknown[] | undefined) =>
      (parts ?? []).filter(part => (part as { type?: string }).type === 'data-steps').length
    const text = (parts: unknown[] | undefined) =>
      (parts ?? [])
        .filter(part => (part as { type?: string }).type === 'text')
        .map(part => (part as { content?: string }).content)

    // 写手视图取材:锚点原样带出去,覆盖之后渲染层还有它。
    expect(anchors(fromWriter.contentParts)).toBe(1)
    expect(anchors(mergeIntoRenderer(fromWriter).contentParts)).toBe(1)
    // 投影取材:快照少了锚点,而 renderer 的整体覆盖把渲染层原有的那一个也抹掉。
    expect(anchors(fromProjection.contentParts)).toBe(0)
    expect(anchors(mergeIntoRenderer(fromProjection).contentParts)).toBe(0)
    // ③ c4-b:投影取材 **+ 现算** —— 锚点回来了,渲染层覆盖之后也还在。
    const synthesized = synthesizeCoreToolAnchors(
      projectedParts as Array<{ type: string; turnIndex?: number }>,
      baseMessage,
    )
    const fromSynthesized = await snapshotFrom(synthesized!)
    expect(anchors(fromSynthesized.contentParts)).toBe(1)
    expect(anchors(mergeIntoRenderer(fromSynthesized).contentParts)).toBe(1)
    // 而正文三侧逐字相同 —— 这正是 §15.16 的定性:丢的是分界,不是数据。
    expect(text(fromWriter.contentParts)).toEqual(['answer', 'tail'])
    expect(text(fromProjection.contentParts)).toEqual(['answer', 'tail'])
    expect(text(fromSynthesized.contentParts)).toEqual(['answer', 'tail'])
    expect(fromProjection.content).toBe(fromWriter.content)
  })

  it('plans finish chunk usage accumulation and continuation state in core', () => {
    expect(planAgentLoopFinishChunk({
      turnIndex: 1,
      accumulatedUsage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        durationMs: 100,
      },
      usage: {
        inputTokens: 20,
        outputTokens: 8,
        totalTokens: 28,
      },
      finishReason: 'tool-calls',
    })).toEqual({
      accumulatedUsage: {
        inputTokens: 30,
        outputTokens: 13,
        totalTokens: 43,
        durationMs: 100,
      },
      lastTurnUsage: {
        inputTokens: 20,
        outputTokens: 8,
        totalTokens: 28,
      },
      contextSizeInputTokens: 20,
      nextTurnIndex: 2,
      createNewAssistantOnNextTurnStart: false,
      resetTurn: true,
      continuationTurnIndex: 2,
    })

    expect(planAgentLoopFinishChunk({
      turnIndex: 2,
      finishReason: 'tool_calls',
    })).toEqual({
      accumulatedUsage: undefined,
      lastTurnUsage: undefined,
      contextSizeInputTokens: undefined,
      nextTurnIndex: 3,
      createNewAssistantOnNextTurnStart: false,
      resetTurn: true,
      continuationTurnIndex: 3,
    })

    expect(planAgentLoopFinishChunk({
      turnIndex: 2,
      finishReason: 'stop',
    })).toEqual({
      accumulatedUsage: undefined,
      lastTurnUsage: undefined,
      contextSizeInputTokens: undefined,
      nextTurnIndex: 2,
      createNewAssistantOnNextTurnStart: true,
      resetTurn: false,
    })
  })

  it('applies finish chunk state transitions through core adapters', () => {
    const state = {
      turnIndex: 1,
      accumulatedUsage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        durationMs: 100,
      },
      lastTurnUsage: undefined as { inputTokens: number; outputTokens: number } | undefined,
      createNewAssistantOnNextTurnStart: true,
      turn: { id: 'old-turn' },
    }
    const synced: string[] = []

    const plan = applyAgentLoopFinishChunkWithAdapters({
      state,
      usage: {
        inputTokens: 20,
        outputTokens: 8,
        totalTokens: 28,
      },
      finishReason: 'tool-calls',
      syncAccumulatedUsage: usage => {
        synced.push(`acc:${usage.totalTokens}`)
      },
      syncLastTurnUsage: usage => {
        synced.push(`last:${usage.totalTokens}`)
      },
      updateStepsUsageByTurn: (turnIndex, usage) => {
        synced.push(`steps:${turnIndex}/${usage.inputTokens}`)
      },
      sendContextSizeUpdate: inputTokens => {
        synced.push(`context:${inputTokens}`)
      },
      persistTurnContentParts: () => {
        synced.push('persist')
      },
      createTurnState: () => ({ id: 'new-turn' }),
      sendContinuation: turnIndex => {
        synced.push(`continue:${turnIndex}`)
      },
    })

    expect(plan.continuationTurnIndex).toBe(2)
    expect(state).toEqual({
      turnIndex: 2,
      accumulatedUsage: {
        inputTokens: 30,
        outputTokens: 13,
        totalTokens: 43,
        durationMs: 100,
      },
      lastTurnUsage: {
        inputTokens: 20,
        outputTokens: 8,
        totalTokens: 28,
      },
      createNewAssistantOnNextTurnStart: false,
      turn: { id: 'new-turn' },
    })
    expect(synced).toEqual([
      'acc:43',
      'last:28',
      'steps:1/20',
      'context:20',
      'persist',
      'continue:2',
    ])
  })
})
