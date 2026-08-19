import { describe, expect, it } from 'vitest'
import {
  appendAgentLoopTurnToolCallOnce,
  appendOrderedPart,
  applyAgentLoopFinishChunkWithAdapters,
  applyAgentLoopReasoningChunkWithAdapters,
  applyAgentLoopTextChunkWithAdapters,
  applyAgentLoopToolCallFallbackWithAdapters,
  applyAgentLoopToolInputDeltaWithAdapters,
  applyAgentLoopToolInputEndWithAdapters,
  applyAgentLoopToolInputStartWithAdapters,
  applyAgentLoopToolMetadata,
  applyAgentLoopToolMetadataWithAdapters,
  applyAgentLoopToolPartialResultWithAdapters,
  applyAgentLoopProviderDataWithAdapters,
  applyAgentLoopStreamChunkWithAdapters,
  applyAgentLoopToolResultWithAdapters,
  applyAgentLoopTurnStartWithAdapters,
  buildAgentLoopFinalMessageUpdate,
  buildAgentLoopPostResponseContexts,
  buildAgentLoopToolPartialStepUpdate,
  buildAgentLoopToolResultPresentation,
  buildAgentLoopToolStartStepUpdate,
  changesFromMetadata,
  completeAgentLoopStreamWithAdapters,
  createAgentLoopAssistantMessage,
  createAgentLoopNextAssistantWriterPlan,
  createAgentLoopExecutorTurnState,
  dispatchAgentLoopToolContentPartsWithAdapters,
  enabledToolNames,
  emitAgentLoopFinalMessageUpdateWithAdapters,
  executeAgentLoopStreamLifecycleWithAdapters,
  getAgentLoopReasoningPlacement,
  hasAgentLoopVisibleTurnActivity,
  lastUserMessageText,
  planAgentLoopToolCallFallback,
  planAgentLoopFinishChunk,
  planAgentLoopProviderData,
  planAgentLoopToolContentPartsDispatch,
  planAgentLoopTurnContentPersistence,
  persistAgentLoopTurnContentPartsWithAdapters,
  resultText,
  rememberAgentLoopToolStepId,
  runAgentLoopPostResponseHooksWithAdapters,
  settleAgentLoopToolCallResult,
  settleAgentLoopToolResultWithAdapters,
  startAgentLoopToolExecution,
  structuredToolResult,
  textFromPartialResult,
} from '@onething/core/engine'
import type { JsonObject, JsonValue } from '@onething/core'

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

  it('creates turn state and merges adjacent ordered text/reasoning parts', () => {
    const turn = createAgentLoopExecutorTurnState<unknown, { type: string; content?: string; turnIndex?: number }>()

    appendOrderedPart(turn.orderedParts, { type: 'text', content: 'hello', turnIndex: 1 })
    appendOrderedPart(turn.orderedParts, { type: 'text', content: ' world', turnIndex: 1 })
    appendOrderedPart(turn.orderedParts, { type: 'reasoning', content: 'think', turnIndex: 1 })
    appendOrderedPart(turn.orderedParts, { type: 'reasoning', content: ' more', turnIndex: 1 })

    expect(turn).toMatchObject({
      toolCalls: [],
      content: { value: '' },
      reasoning: { value: '' },
      hasSentToolParts: false,
      orderedParts: [
        { type: 'text', content: 'hello world', turnIndex: 1 },
        { type: 'reasoning', content: 'think more', turnIndex: 1 },
      ],
    })
  })

  it('applies turn-start, text, and reasoning chunks through core adapters', async () => {
    const state = {
      turnIndex: 1,
      createNewAssistantOnNextTurnStart: true,
    }
    let created = 0
    await applyAgentLoopTurnStartWithAdapters({
      state,
      turn: 2,
      createNextAssistantWriter: () => {
        created += 1
      },
    })
    expect(state).toEqual({
      turnIndex: 2,
      createNewAssistantOnNextTurnStart: false,
    })
    expect(created).toBe(1)

    const turn = createAgentLoopExecutorTurnState<unknown, { type: string; content?: string; turnIndex?: number }>()
    const textApplied = applyAgentLoopTextChunkWithAdapters({
      text: 'hello',
      turnIndex: 2,
      content: turn.content,
      orderedParts: turn.orderedParts,
      handleTextChunk(text, accumulator) {
        accumulator.value += text
        return text.toUpperCase()
      },
    })
    expect(textApplied).toBe(true)
    expect(turn.content.value).toBe('hello')
    expect(turn.orderedParts).toEqual([
      { type: 'text', content: 'HELLO', turnIndex: 2 },
    ])

    const firstTurn = createAgentLoopExecutorTurnState<unknown, { type: string; content?: string; turnIndex?: number }>()
    const topPlacement = applyAgentLoopReasoningChunkWithAdapters({
      reasoning: 'think',
      turnIndex: 1,
      accumulatedContent: '',
      turn: firstTurn,
      handleReasoningChunk(reasoning, accumulator) {
        accumulator.value += reasoning
      },
    })
    expect(topPlacement).toBe('top')
    expect(firstTurn.reasoning.value).toBe('think')
    expect(firstTurn.orderedParts).toEqual([])

    const inlinePlacement = applyAgentLoopReasoningChunkWithAdapters({
      reasoning: ' more',
      turnIndex: 2,
      accumulatedContent: 'answer',
      turn,
      handleReasoningChunk(reasoning, accumulator) {
        accumulator.value += reasoning
      },
    })
    expect(inlinePlacement).toBe('inline')
    expect(turn.reasoning.value).toBe(' more')
    expect(turn.orderedParts.at(-1)).toEqual({
      type: 'reasoning',
      content: ' more',
      turnIndex: 2,
    })
  })

  it('dispatches provider stream chunks through the core executor adapter', async () => {
    interface TestPart {
      type: string
      content?: string
      turnIndex?: number
    }
    interface TestToolCall {
      id: string
      toolName: string
      arguments?: JsonObject
      status?: string
      result?: JsonValue
      startTime?: number
      endTime?: number
    }

    const events: string[] = []
    const toolCalls: TestToolCall[] = []
    const state = {
      turnIndex: 1,
      turn: createAgentLoopExecutorTurnState<TestToolCall, TestPart>(),
      stepIdsByToolCallId: new Map<string, string>(),
      accumulatedUsage: undefined as { inputTokens: number; outputTokens: number; totalTokens: number } | undefined,
      lastTurnUsage: undefined as { inputTokens: number; outputTokens: number } | undefined,
      toolIterations: 0,
      skillManageCalled: false,
      latestUserPrompt: 'draw',
      createNewAssistantOnNextTurnStart: false,
    }
    const processor = {
      toolCalls,
      getStepIdForToolCall: (toolCallId: string) => `step_${toolCallId}`,
      handleToolInputStart(toolCallId: string, toolName: string, turnIndex?: number) {
        events.push(`input-start:${toolCallId}:${toolName}:${turnIndex}`)
      },
      handleToolInputDelta(toolCallId: string, argsTextDelta: string) {
        events.push(`input-delta:${toolCallId}:${argsTextDelta}`)
      },
      handleToolInputEnd(toolCallId: string) {
        events.push(`input-end:${toolCallId}`)
        const call = {
          id: toolCallId,
          toolName: 'read',
          arguments: { path: 'a.txt' },
        }
        toolCalls.push(call)
        return call
      },
      handleToolCallChunk(chunk: { toolCallId: string; toolName: string; args: JsonObject }) {
        const call = {
          id: chunk.toolCallId,
          toolName: chunk.toolName,
          arguments: chunk.args,
        }
        toolCalls.push(call)
        return call
      },
    }
    const store = {
      updateMessageToolCalls: (_sessionId: string, _messageId: string, calls: TestToolCall[]) => {
        events.push(`store:${calls.map(call => `${call.id}:${call.status ?? 'none'}`).join(',')}`)
      },
    }
    const emitter = {
      sendContentPart(part: TestPart | { type: 'data-steps'; turnIndex: number }) {
        events.push(`part:${part.type}:${'content' in part ? part.content ?? '' : part.turnIndex}`)
      },
      sendToolCall(call: TestToolCall) {
        events.push(`tool-call:${call.id}:${call.status ?? 'none'}`)
      },
      sendToolResult(call: TestToolCall) {
        events.push(`tool-result:${call.id}:${call.status ?? 'none'}`)
      },
      sendToolExecutionStart(toolCallId: string, stepId: string, toolName: string) {
        events.push(`exec-start:${toolCallId}:${stepId}:${toolName}`)
      },
      sendToolExecutionUpdate() {},
      sendToolExecutionEnd(toolCallId: string, stepId: string, result?: unknown, isError?: boolean) {
        events.push(`exec-end:${toolCallId}:${stepId}:${isError}:${JSON.stringify(result)}`)
      },
      sendStepUpdated(stepId: string, update: { status?: string }) {
        events.push(`step:${stepId}:${update.status}`)
      },
      sendContextSizeUpdate(inputTokens: number) {
        events.push(`context:${inputTokens}`)
      },
      sendContinuation(turnIndex: number) {
        events.push(`continue:${turnIndex}`)
      },
    }
    const baseOptions = {
      state,
      sessionId: 's1',
      assistantMessageId: 'm1',
      model: 'deepseek-chat',
      accumulatedContent: '',
      processor,
      store,
      emitter,
      createNextAssistantWriter: () => {
        events.push('next-writer')
      },
      handleTextChunk(text: string, accumulator: { value: string }) {
        accumulator.value += text
        return text
      },
      handleReasoningChunk(reasoning: string, accumulator: { value: string }) {
        accumulator.value += reasoning
      },
      persistTurnContentParts: () => {
        events.push('persist')
      },
      createTurnState: () => createAgentLoopExecutorTurnState<TestToolCall, TestPart>(),
      syncAccumulatedUsage: (usage: { inputTokens: number; outputTokens: number; totalTokens: number }) => {
        state.accumulatedUsage = usage
        events.push(`usage:${usage.totalTokens}`)
      },
      syncLastTurnUsage: (usage: { inputTokens: number; outputTokens: number }) => {
        state.lastTurnUsage = usage
        events.push(`last:${usage.inputTokens}/${usage.outputTokens}`)
      },
      now: () => 100,
    }

    await applyAgentLoopStreamChunkWithAdapters<TestPart, TestToolCall, { status?: string }>({
      ...baseOptions,
      chunk: { type: 'text', text: 'hello' },
    })
    await applyAgentLoopStreamChunkWithAdapters<TestPart, TestToolCall, { status?: string }>({
      ...baseOptions,
      chunk: { type: 'tool-input-start', toolInputStart: { toolCallId: 'call_1', toolName: 'read' } },
    })
    await applyAgentLoopStreamChunkWithAdapters<TestPart, TestToolCall, { status?: string }>({
      ...baseOptions,
      chunk: { type: 'tool-input-delta', toolInputDelta: { toolCallId: 'call_1', argsTextDelta: '{"path":"a.txt"}' } },
    })
    await applyAgentLoopStreamChunkWithAdapters<TestPart, TestToolCall, { status?: string }>({
      ...baseOptions,
      chunk: { type: 'tool-input-end', toolInputEnd: { toolCallId: 'call_1', finalizedBy: 'parse' } },
    })
    await applyAgentLoopStreamChunkWithAdapters<TestPart, TestToolCall, { status?: string }>({
      ...baseOptions,
      chunk: { type: 'tool-result', toolResult: { toolCallId: 'call_1', result: { content: 'done' } } },
    })
    await applyAgentLoopStreamChunkWithAdapters<TestPart, TestToolCall, { status?: string }>({
      ...baseOptions,
      chunk: {
        type: 'finish',
        finishReason: 'tool-calls',
        usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      },
    })

    expect(state.turnIndex).toBe(2)
    expect(state.toolIterations).toBe(1)
    expect(state.accumulatedUsage).toEqual({ inputTokens: 3, outputTokens: 4, totalTokens: 7 })
    expect(events).toEqual(expect.arrayContaining([
      'part:text:hello',
      'input-start:call_1:read:1',
      'input-delta:call_1:{"path":"a.txt"}',
      'input-end:call_1',
      'tool-call:call_1:executing',
      'tool-result:call_1:completed',
      'exec-end:call_1:step_call_1:false:{"content":[{"type":"text","text":"done"}]}',
      'context:3',
      'persist',
      'continue:2',
    ]))
  })

  it('runs the agent-loop stream lifecycle through core adapters', async () => {
    const events: string[] = []
    let now = 100
    const prepared = { supported: true as const, runtime: { id: 'runtime-1' } }

    const result = await executeAgentLoopStreamLifecycleWithAdapters<
      typeof prepared,
      typeof prepared
    >({
      prepareRuntime: () => {
        events.push('prepare')
        return prepared
      },
      isRuntimeSupported: (value): value is typeof prepared => value.supported,
      unsupportedReason: () => 'unsupported',
      emitStreamStart: () => {
        events.push('start')
      },
      async *streamChunks(value) {
        events.push(`stream:${value.runtime.id}`)
        yield { type: 'text', text: 'hello' }
        yield { type: 'finish', finishReason: 'stop' as const }
      },
      applyChunk: chunk => {
        events.push(`chunk:${chunk.type}`)
      },
      finalize: () => {
        events.push('finalize')
      },
      updateUsage: durationMs => {
        events.push(`usage:${durationMs}`)
      },
      completeStream: value => {
        events.push(`complete:${value.runtime.id}`)
      },
      runPostResponseHooks: value => {
        events.push(`hooks:${value.runtime.id}`)
      },
      isAbortError: error => error.name === 'AbortError',
      sendStreamAborted: reason => {
        events.push(`aborted:${reason}`)
      },
      updateMessageError: error => {
        events.push(`message-error:${error}`)
      },
      emitFinalAssistantMessageUpdate: () => {
        events.push('final-update')
      },
      sendStreamError: data => {
        events.push(`stream-error:${data.error}:${data.preserved}`)
      },
      sendStreamComplete: data => {
        events.push(`stream-complete:${data.sessionName ?? ''}:${data.error ?? ''}`)
      },
      now: () => {
        now += 25
        return now
      },
    })

    expect(result).toEqual({ pausedForConfirmation: false })
    expect(events).toEqual([
      'prepare',
      'start',
      'stream:runtime-1',
      'chunk:text',
      'chunk:finish',
      'usage:25',
      'complete:runtime-1',
      'hooks:runtime-1',
    ])
  })

  it('handles agent-loop stream lifecycle errors in core', async () => {
    const events: string[] = []

    await expect(executeAgentLoopStreamLifecycleWithAdapters({
      prepareRuntime: () => ({ supported: true as const }),
      isRuntimeSupported: (prepared): prepared is { supported: true } => prepared.supported,
      unsupportedReason: () => 'unsupported',
      emitStreamStart: () => {
        throw new Error('boom')
      },
      async *streamChunks() {},
      applyChunk: () => {},
      finalize: () => {
        events.push('finalize')
      },
      completeStream: () => {
        events.push('complete')
      },
      runPostResponseHooks: () => {
        events.push('hooks')
      },
      isAbortError: error => error.name === 'AbortError',
      sendStreamAborted: reason => {
        events.push(`aborted:${reason}`)
      },
      updateMessageError: error => {
        events.push(`message-error:${error}`)
      },
      emitFinalAssistantMessageUpdate: () => {
        events.push('final-update')
      },
      sendStreamError: data => {
        events.push(`stream-error:${data.error}:${data.preserved}`)
      },
      sendStreamComplete: data => {
        events.push(`stream-complete:${data.error}`)
      },
      getSessionName: () => 'Session',
    })).resolves.toEqual({ pausedForConfirmation: false })

    expect(events).toEqual([
      'finalize',
      'message-error:boom',
      'final-update',
      'stream-error:boom:true',
      'stream-complete:boom',
    ])
  })

  it('tracks agent-loop tool-call fallback state in core', () => {
    const stepIds = new Map<string, string>()
    expect(rememberAgentLoopToolStepId(stepIds, 'call_1', undefined)).toBeUndefined()
    expect(stepIds.size).toBe(0)
    expect(rememberAgentLoopToolStepId(stepIds, 'call_1', 'step_1')).toBe('step_1')
    expect(stepIds.get('call_1')).toBe('step_1')

    const turnToolCalls = [{ id: 'call_1', toolName: 'read' }]
    expect(appendAgentLoopTurnToolCallOnce(turnToolCalls, { id: 'call_1', toolName: 'read-again' })).toBe(false)
    expect(appendAgentLoopTurnToolCallOnce(turnToolCalls, { id: 'call_2', toolName: 'write' })).toBe(true)
    expect(turnToolCalls.map(toolCall => toolCall.id)).toEqual(['call_1', 'call_2'])

    expect(planAgentLoopToolCallFallback([{ id: 'call_1' }], {
      toolCallId: 'call_1',
      toolName: 'read',
      args: { path: '/tmp/a.txt' },
    })).toEqual({
      shouldStartPlaceholder: false,
      toolCallId: 'call_1',
      toolName: 'read',
      args: { path: '/tmp/a.txt' },
    })

    expect(planAgentLoopToolCallFallback([], {
      toolCallId: 'call_3',
      toolName: 'bash',
    })).toEqual({
      shouldStartPlaceholder: true,
      toolCallId: 'call_3',
      toolName: 'bash',
      args: {},
    })
  })

  it('places first-turn reasoning at top until visible activity appears', () => {
    const turn = createAgentLoopExecutorTurnState<unknown, { type: string; content?: string; turnIndex?: number }>()

    expect(hasAgentLoopVisibleTurnActivity(turn)).toBe(false)
    expect(getAgentLoopReasoningPlacement({
      turnIndex: 1,
      accumulatedContent: '',
      turn,
    })).toBe('top')

    appendOrderedPart(turn.orderedParts, { type: 'provider-data', turnIndex: 1 })
    expect(hasAgentLoopVisibleTurnActivity(turn)).toBe(false)
    expect(getAgentLoopReasoningPlacement({
      turnIndex: 1,
      accumulatedContent: '',
      turn,
    })).toBe('top')

    appendOrderedPart(turn.orderedParts, { type: 'text', content: 'hello', turnIndex: 1 })
    expect(hasAgentLoopVisibleTurnActivity(turn)).toBe(true)
    expect(getAgentLoopReasoningPlacement({
      turnIndex: 1,
      accumulatedContent: '',
      turn,
    })).toBe('inline')
  })

  it('formats tool results for display and structured IPC updates', () => {
    expect(resultText({ content: 'ok', data: { ignored: true } })).toBe('ok')
    expect(resultText({ data: { output: 'ok' } })).toBe('{"output":"ok"}')
    expect(resultText({ error: 'boom' })).toBe('boom')

    expect(structuredToolResult({ data: { output: 'ok' } })).toEqual({
      content: [{ type: 'text', text: '{"output":"ok"}' }],
      details: { output: 'ok' },
    })
    expect(buildAgentLoopToolStartStepUpdate({ id: 'call_1', status: 'executing' })).toEqual({
      status: 'running',
      toolCall: { id: 'call_1', status: 'executing' },
    })
  })

  it('settles agent-loop tool calls without store or emitter access', () => {
    const completed = {
      id: 'call_1',
      toolId: 'read',
      toolName: 'read',
      status: 'executing',
    }
    // COW(P0.2 area ①,F3):结算返回**新** toolCall,入参那条一个字段都不动。
    const settlement = settleAgentLoopToolCallResult(completed, {
      content: 'ok',
      data: { output: 'ok' },
    }, 1234)
    expect(settlement).toMatchObject({
      awaitingConfirmation: false,
      skillManageCalled: false,
    })
    expect(settlement.toolCall).not.toBe(completed)
    expect(settlement.toolCall).toMatchObject({
      status: 'completed',
      result: { output: 'ok' },
      endTime: 1234,
      requiresConfirmation: false,
    })
    expect(completed.status).toBe('executing')
    expect(buildAgentLoopToolResultPresentation(settlement.toolCall, {
      content: 'ok',
      data: { output: 'ok' },
    })).toEqual({
      executionEnd: {
        result: {
          content: [{ type: 'text', text: 'ok' }],
          details: { output: 'ok' },
        },
        isError: false,
        error: undefined,
      },
      stepUpdate: {
        status: 'completed',
        toolCall: { ...settlement.toolCall },
        partialResult: {
          content: [{ type: 'text', text: 'ok' }],
          details: { output: 'ok' },
        },
        partialResultIsPartial: false,
        result: 'ok',
        error: undefined,
        rejected: undefined,
        rejectionReason: undefined,
      },
    })

    const rejected = {
      id: 'call_2',
      toolId: 'edit',
      toolName: 'edit',
      status: 'executing',
    }
    const rejectedSettlement = settleAgentLoopToolCallResult(rejected, {
      error: 'Denied',
      data: { rejected: true, rejectionReason: 'No edits' },
    }, 2345)
    expect(rejectedSettlement.toolCall).toMatchObject({
      status: 'failed',
      rejected: true,
      rejectionReason: 'No edits',
      error: 'Denied',
      endTime: 2345,
    })
    expect(buildAgentLoopToolResultPresentation(rejectedSettlement.toolCall, {
      error: 'Denied',
      data: { rejected: true, rejectionReason: 'No edits' },
    })).toMatchObject({
      executionEnd: {
        result: undefined,
        isError: true,
        error: 'Denied',
      },
      stepUpdate: {
        status: 'failed',
        result: 'Denied',
        error: 'Denied',
        rejected: true,
        rejectionReason: 'No edits',
      },
    })

    const pending = {
      id: 'call_3',
      toolId: 'skill_manage',
      toolName: 'skill_manage',
      status: 'executing',
    }
    const pendingSettlement = settleAgentLoopToolCallResult(pending, {
      requiresConfirmation: true,
      error: 'Confirm skill update',
      data: { commandType: 'dangerous' },
    }, 3456)
    expect(pendingSettlement).toMatchObject({
      awaitingConfirmation: true,
      // skill_manage 工具已移除,没有可识别的专用调用了。
      skillManageCalled: false,
    })
    expect(pendingSettlement.toolCall).toMatchObject({
      status: 'pending',
      requiresConfirmation: true,
      commandType: 'dangerous',
      error: 'Confirm skill update',
      endTime: 3456,
    })
    expect(buildAgentLoopToolResultPresentation(pendingSettlement.toolCall, {
      requiresConfirmation: true,
      error: 'Confirm skill update',
      data: { commandType: 'dangerous' },
    }, true)).toEqual({
      stepUpdate: {
        status: 'awaiting-confirmation',
        toolCall: { ...pendingSettlement.toolCall },
        error: 'Confirm skill update',
      },
    })
  })

  it('runs agent-loop tool lifecycle through headless store and emitter adapters', () => {
    interface TestToolCall {
      id: string
      toolId?: string
      toolName: string
      arguments?: { path?: string }
      status?: string
      startTime?: number
      endTime?: number
      result?: JsonValue
      error?: string
      rejected?: boolean
      rejectionReason?: string
      requiresConfirmation?: boolean
      commandType?: string
      changes?: {
        diff: string
        filePath: string
        additions: number
        deletions: number
      }
    }

    const toolCall: TestToolCall = {
      id: 'call_1',
      toolId: 'read',
      toolName: 'read',
      arguments: { path: 'a.txt' },
      status: 'pending',
    }
    const toolCalls = [toolCall]
    const stepIds = new Map([['call_1', 'step_1']])
    const events: string[] = []
    const store = {
      updateMessageToolCalls: (_sessionId: string, _messageId: string, calls: TestToolCall[]) => {
        events.push(`store:${calls[0].status}`)
      },
    }
    const emitter = {
      sendToolCall: (call: TestToolCall) => events.push(`tool-call:${call.status}`),
      sendToolResult: (call: TestToolCall) => events.push(`tool-result:${call.status}`),
      sendToolExecutionStart: (toolCallId: string, stepId: string, toolName: string, args: unknown) => {
        events.push(`start:${toolCallId}:${stepId}:${toolName}:${JSON.stringify(args)}`)
      },
      sendToolExecutionUpdate: (toolCallId: string, stepId: string, partial: { content: Array<{ text?: string }> }) => {
        events.push(`partial:${toolCallId}:${stepId}:${partial.content[0]?.text}`)
      },
      sendToolExecutionEnd: (toolCallId: string, stepId: string, result?: unknown, isError?: boolean, error?: string) => {
        events.push(`end:${toolCallId}:${stepId}:${isError}:${error ?? ''}:${JSON.stringify(result)}`)
      },
      sendStepUpdated: (stepId: string, updates: { status?: string; title?: string; result?: string }) => {
        events.push(`step:${stepId}:${updates.status ?? updates.title ?? updates.result}`)
      },
    }

    // COW(F3):开跑返回新对象并换进工作表;手里那条不动。
    const started = startAgentLoopToolExecution({
      sessionId: 's1',
      assistantMessageId: 'm1',
      toolCall,
      toolCalls,
      stepId: 'step_1',
      store,
      emitter,
      now: () => 100,
    })
    expect(started).toMatchObject({ status: 'executing', startTime: 100 })
    expect(toolCalls[0]).toBe(started)

    expect(applyAgentLoopToolPartialResultWithAdapters({
      toolCallId: 'call_1',
      update: { content: [{ type: 'text', text: 'partial' }] },
      stepIdsByToolCallId: stepIds,
      emitter,
    })).toBe(true)

    expect(applyAgentLoopToolMetadataWithAdapters({
      toolCallId: 'call_1',
      update: {
        title: 'Read a.txt',
        metadata: {
          output: 'preview',
          path: 'a.txt',
          diff: '+hello',
          additions: 1,
          deletions: 0,
        },
      },
      toolCalls,
      stepIdsByToolCallId: stepIds,
      emitter,
    })).toBe(true)
    // COW(F3):`changes` 不再写回 toolCall,只随 step 更新发出去。
    expect(toolCall.changes).toBeUndefined()
    expect(events.some(event => event.includes('step:step_1:Read a.txt'))).toBe(true)

    const settlement = settleAgentLoopToolResultWithAdapters({
      sessionId: 's1',
      assistantMessageId: 'm1',
      toolCallId: 'call_1',
      result: { content: 'done', data: { output: 'done' } },
      toolCalls,
      stepIdsByToolCallId: stepIds,
      store,
      emitter,
      now: () => 200,
    })

    expect(settlement).toMatchObject({
      found: true,
      toolIterationsDelta: 1,
      awaitingConfirmation: false,
    })
    // COW(F3):结算后的那一版在工作表里,`toolCall` 是旧引用。
    expect(settlement.toolCall).toMatchObject({
      status: 'completed',
      result: { output: 'done' },
      endTime: 200,
    })
    expect(toolCalls[0]).toBe(settlement.toolCall)
    expect(events).toEqual([
      'store:executing',
      'tool-call:executing',
      'start:call_1:step_1:read:{"path":"a.txt"}',
      'step:step_1:running',
      'partial:call_1:step_1:partial',
      'step:step_1:running',
      'step:step_1:Read a.txt',
      'store:completed',
      'tool-result:completed',
      'end:call_1:step_1:false::{"content":[{"type":"text","text":"done"}],"details":{"output":"done"}}',
      'step:step_1:completed',
    ])
  })

  it('extracts text from partial results and diff metadata', () => {
    expect(textFromPartialResult({
      content: [
        { type: 'text', text: 'half' },
        { type: 'text', text: 'way' },
      ],
    })).toBe('halfway')
    expect(buildAgentLoopToolPartialStepUpdate({
      content: [
        { type: 'text', text: 'half' },
        { type: 'text', text: 'way' },
      ],
    })).toEqual({
      status: 'running',
      partialResult: {
        content: [
          { type: 'text', text: 'half' },
          { type: 'text', text: 'way' },
        ],
      },
      partialResultIsPartial: true,
      result: 'halfway',
    })

    expect(changesFromMetadata({
      path: '/tmp/a.txt',
      diff: '-old\n+new',
      additions: 1,
      deletions: 2,
      originalContentHash: 'before',
    })).toEqual({
      filePath: '/tmp/a.txt',
      diff: '-old\n+new',
      additions: 1,
      deletions: 2,
      originalContent: undefined,
      originalContentHash: 'before',
      afterContentHash: undefined,
      auditId: undefined,
      auditPath: undefined,
    })
  })

  it('builds tool metadata step updates without emitter access', () => {
    const toolCall: {
      id: string
      toolName: string
      status: string
      changes?: {
        diff: string
        filePath: string
        additions: number
        deletions: number
      }
    } = {
      id: 'call_1',
      toolName: 'edit',
      status: 'executing',
    }

    expect(applyAgentLoopToolMetadata(toolCall, {
      title: 'Edited file',
      metadata: {
        output: 'updated',
        path: '/tmp/a.txt',
        diff: '-old\n+new',
        additions: 1,
        deletions: 1,
      },
    })).toEqual({
      title: 'Edited file',
      result: 'updated',
      toolCall: {
        ...toolCall,
        changes: {
          filePath: '/tmp/a.txt',
          diff: '-old\n+new',
          additions: 1,
          deletions: 1,
          originalContent: undefined,
          originalContentHash: undefined,
          afterContentHash: undefined,
          auditId: undefined,
          auditPath: undefined,
        },
      },
    })
    // COW(F3):`changes` 落在返回的新对象上,入参那条不动。
    expect(toolCall.changes).toBeUndefined()

    expect(applyAgentLoopToolMetadata(undefined, {
      metadata: { count: 2 },
    })).toEqual({ result: '{"count":2}' })
  })

  it('applies agent-loop tool input/call/result chunks through core adapters', () => {
    interface TestToolCall {
      id: string
      toolId?: string
      toolName: string
      arguments?: { path?: string }
      status?: string
      startTime?: number
      endTime?: number
      result?: JsonValue
      error?: string
      rejected?: boolean
      rejectionReason?: string
      requiresConfirmation?: boolean
    }

    const toolCalls: TestToolCall[] = []
    const events: string[] = []
    const processor = {
      toolCalls,
      getStepIdForToolCall: (toolCallId: string) => `step_${toolCallId}`,
      handleToolInputStart(toolCallId: string, toolName: string, turnIndex: number) {
        events.push(`input-start:${toolCallId}:${toolName}:${turnIndex}`)
      },
      handleToolInputDelta(toolCallId: string, argsTextDelta: string) {
        events.push(`input-delta:${toolCallId}:${argsTextDelta}`)
      },
      handleToolInputEnd(toolCallId: string): TestToolCall {
        events.push(`input-end:${toolCallId}`)
        const call = { id: toolCallId, toolId: 'read', toolName: 'read', arguments: { path: 'a.txt' } }
        toolCalls.push(call)
        return call
      },
      handleToolCallChunk(chunk: { toolCallId: string; toolName: string; args: { path?: string } }): TestToolCall {
        events.push(`tool-chunk:${chunk.toolCallId}:${chunk.toolName}`)
        const call = {
          id: chunk.toolCallId,
          toolId: chunk.toolName,
          toolName: chunk.toolName,
          arguments: chunk.args,
        }
        toolCalls.push(call)
        return call
      },
    }
    const store = {
      updateMessageToolCalls: (_sessionId: string, _messageId: string, calls: TestToolCall[]) => {
        events.push(`store:${calls.map(call => `${call.id}:${call.status}`).join(',')}`)
      },
    }
    const emitter = {
      sendContentPart: (part: { type: string; content?: string; turnIndex?: number }) => {
        events.push(`part:${part.type}:${part.content ?? part.turnIndex}`)
      },
      sendToolCall: (call: TestToolCall) => events.push(`tool-call:${call.id}:${call.status}`),
      sendToolResult: (call: TestToolCall) => events.push(`tool-result:${call.id}:${call.status}`),
      sendToolExecutionStart: (toolCallId: string, stepId: string, toolName: string) => {
        events.push(`exec-start:${toolCallId}:${stepId}:${toolName}`)
      },
      sendToolExecutionUpdate: () => {},
      sendToolExecutionEnd: (toolCallId: string, stepId: string, result?: unknown, isError?: boolean) => {
        events.push(`exec-end:${toolCallId}:${stepId}:${isError}:${JSON.stringify(result)}`)
      },
      sendStepUpdated: (stepId: string, update: { status?: string }) => {
        events.push(`step:${stepId}:${update.status}`)
      },
    }
    const stepIdsByToolCallId = new Map<string, string>()
    const turn = createAgentLoopExecutorTurnState<TestToolCall, { type: string; content?: string; turnIndex?: number }>()
    turn.orderedParts.push({ type: 'text', content: 'before tool', turnIndex: 1 })

    expect(applyAgentLoopToolInputStartWithAdapters({
      turn,
      turnIndex: 1,
      toolCallId: 'call_1',
      toolName: 'read',
      processor,
      stepIdsByToolCallId,
      emitter,
    })).toBe('step_call_1')
    expect(stepIdsByToolCallId.get('call_1')).toBe('step_call_1')
    expect(turn.hasSentToolParts).toBe(true)

    applyAgentLoopToolInputDeltaWithAdapters(processor, 'call_1', '{"path"')

    expect(applyAgentLoopToolInputEndWithAdapters({
      sessionId: 's1',
      assistantMessageId: 'm1',
      toolCallId: 'call_1',
      turn,
      processor,
      stepIdsByToolCallId,
      store,
      emitter,
      now: () => 100,
    })).toMatchObject({ found: true, toolCall: { id: 'call_1', status: 'executing' } })

    const fallbackTurn = createAgentLoopExecutorTurnState<TestToolCall, { type: string; content?: string; turnIndex?: number }>()
    applyAgentLoopToolCallFallbackWithAdapters({
      sessionId: 's1',
      assistantMessageId: 'm1',
      turn: fallbackTurn,
      turnIndex: 2,
      toolCall: {
        toolCallId: 'call_2',
        toolName: 'write',
        args: { path: 'b.txt' },
      },
      processor,
      stepIdsByToolCallId,
      store,
      emitter,
      now: () => 200,
    })

    const state = { toolIterations: 0, skillManageCalled: false }
    expect(applyAgentLoopToolResultWithAdapters({
      state,
      sessionId: 's1',
      assistantMessageId: 'm1',
      toolCallId: 'call_1',
      result: { content: 'done', data: { output: 'done' } },
      toolCalls,
      stepIdsByToolCallId,
      store,
      emitter,
      now: () => 300,
    })).toMatchObject({
      found: true,
      toolIterationsDelta: 1,
      awaitingConfirmation: false,
    })
    expect(state).toEqual({ toolIterations: 1, skillManageCalled: false })
    expect(events).toEqual(expect.arrayContaining([
      'part:text:before tool',
      'part:data-steps:1',
      'input-start:call_1:read:1',
      'input-delta:call_1:{"path"',
      'input-end:call_1',
      'tool-call:call_1:executing',
      'exec-start:call_1:step_call_1:read',
      'tool-chunk:call_2:write',
      'tool-result:call_1:completed',
      'exec-end:call_1:step_call_1:false:{"content":[{"type":"text","text":"done"}],"details":{"output":"done"}}',
    ]))
  })

  it('builds post-response context helpers', () => {
    expect(enabledToolNames({ toolNames: ['read'], mcpToolNames: ['mcp_search'] })).toEqual([
      'read',
      'mcp_search',
    ])
    expect(lastUserMessageText([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: [{ type: 'text', text: 'latest' }] },
    ])).toBe('latest')

    const contexts = buildAgentLoopPostResponseContexts({
      session: {
        id: 's1',
        name: 'Session',
        messages: [{ id: 'm1', role: 'user', content: 'latest' }],
      },
      sessionId: 's1',
      assistantMessageId: 'a1',
      lastAssistantMessage: 'assistant answer',
      historyMessages: [
        { role: 'user', content: 'first' },
        { role: 'user', content: [{ type: 'text', text: 'latest' }] },
      ],
      providerId: 'deepseek',
      providerConfig: { model: 'deepseek-chat' },
      settings: { ai: { provider: 'deepseek' } },
      toolIterations: 2,
      skillManageCalled: true,
      prepared: { toolNames: ['read'], mcpToolNames: ['mcp_search'] },
    })

    expect(contexts?.triggerContext).toMatchObject({
      sessionId: 's1',
      lastUserMessage: 'latest',
      lastAssistantMessage: 'assistant answer',
      providerId: 'deepseek',
      toolIterations: 2,
      skillManageCalled: true,
      enabledToolNames: ['read', 'mcp_search'],
    })
    expect(contexts?.afterAssistantResponseContext).toMatchObject({
      assistantMessageId: 'a1',
      lastAssistantMessage: 'assistant answer',
    })
    expect(buildAgentLoopPostResponseContexts({
      session: undefined,
      sessionId: 's1',
      assistantMessageId: 'a1',
      lastAssistantMessage: 'assistant answer',
      historyMessages: [],
      providerId: 'deepseek',
      providerConfig: {},
      settings: {},
      toolIterations: 0,
      skillManageCalled: false,
      prepared: { toolNames: [], mcpToolNames: [] },
    })).toBeNull()
  })

  it('runs post-response trigger and plugin hooks through core adapters', () => {
    const triggerCalls: unknown[] = []
    const afterCalls: unknown[] = []
    const errors: Array<{ source: string; message: string }> = []

    const contexts = runAgentLoopPostResponseHooksWithAdapters({
      sessionId: 's1',
      assistantMessageId: 'a1',
      lastAssistantMessage: 'assistant answer',
      historyMessages: [{ role: 'user', content: 'latest request' }],
      providerId: 'deepseek',
      providerConfig: { model: 'deepseek-chat' },
      settings: { ai: { provider: 'deepseek' } },
      toolIterations: 1,
      skillManageCalled: false,
      prepared: { toolNames: ['read'], mcpToolNames: [] },
      getSession: () => ({
        id: 's1',
        messages: [{ id: 'u1', role: 'user', content: 'latest request' }],
      }),
      runTriggerContext: context => {
        triggerCalls.push(context)
      },
      runAfterAssistantResponse: context => {
        afterCalls.push(context)
      },
      onError: (source, error) => {
        errors.push({ source, message: error instanceof Error ? error.message : String(error) })
      },
    })

    expect(contexts?.triggerContext).toMatchObject({
      sessionId: 's1',
      lastUserMessage: 'latest request',
      enabledToolNames: ['read'],
    })
    expect(triggerCalls).toHaveLength(1)
    expect(afterCalls).toHaveLength(1)
    expect(afterCalls[0]).toMatchObject({ assistantMessageId: 'a1' })
    expect(errors).toEqual([])

    expect(runAgentLoopPostResponseHooksWithAdapters({
      sessionId: 'missing',
      assistantMessageId: 'a1',
      lastAssistantMessage: 'assistant answer',
      historyMessages: [],
      providerId: 'deepseek',
      providerConfig: {},
      settings: {},
      toolIterations: 0,
      skillManageCalled: false,
      prepared: { toolNames: [], mcpToolNames: [] },
      getSession: () => undefined,
      runTriggerContext: () => {
        throw new Error('should not run')
      },
      runAfterAssistantResponse: () => {
        throw new Error('should not run')
      },
      onError: (source, error) => {
        errors.push({ source, message: error instanceof Error ? error.message : String(error) })
      },
    })).toBeNull()

    runAgentLoopPostResponseHooksWithAdapters({
      sessionId: 's1',
      assistantMessageId: 'a1',
      lastAssistantMessage: 'assistant answer',
      historyMessages: [],
      providerId: 'deepseek',
      providerConfig: {},
      settings: {},
      toolIterations: 0,
      skillManageCalled: false,
      prepared: { toolNames: [], mcpToolNames: [] },
      getSession: () => ({ messages: [] }),
      runTriggerContext: () => {
        throw new Error('trigger failed')
      },
      runAfterAssistantResponse: () => {
        throw new Error('after failed')
      },
      onError: (source, error) => {
        errors.push({ source, message: error instanceof Error ? error.message : String(error) })
      },
    })

    expect(errors).toEqual([
      { source: 'trigger', message: 'trigger failed' },
      { source: 'afterAssistantResponse', message: 'after failed' },
    ])
  })

  it('plans generic provider-data in core', () => {
    const options = {
      turnIndex: 2,
      latestUserPrompt: ' draw a product ',
      model: 'codex-image',
      sessionId: 's1',
      messageId: 'm1',
    }

    expect(planAgentLoopProviderData({
      provider: 'other',
      type: 'encrypted-reasoning',
    }, {
      ...options,
    })).toEqual({
      kind: 'provider-data',
      orderedPart: {
        type: 'provider-data',
        providerData: {
          provider: 'other',
          type: 'encrypted-reasoning',
        },
        turnIndex: 2,
      },
    })

    expect(planAgentLoopProviderData({
      provider: 'codex',
      type: 'encrypted-reasoning',
      encryptedContent: 'secret',
    }, options)).toEqual({
      kind: 'provider-data',
      orderedPart: {
        type: 'provider-data',
        providerData: {
          provider: 'codex',
          type: 'encrypted-reasoning',
          encryptedContent: 'secret',
        },
        turnIndex: 2,
      },
    })

    expect(planAgentLoopProviderData({
      provider: 'provider-x',
      type: 'ephemeral',
    }, {
      ...options,
      planProviderData: () => ({ kind: 'ignore' }),
    })).toEqual({ kind: 'ignore' })
  })

  it('applies provider-data through core adapters and exposes a runtime hook', async () => {
    type TestPart = { type: string; content?: string; turnIndex?: number; providerData?: unknown }
    const orderedParts: TestPart[] = []
    const emittedParts: TestPart[] = []
    const content = { value: 'existing' }

    await expect(applyAgentLoopProviderDataWithAdapters<TestPart>({
      providerData: {
        provider: 'codex',
        type: 'encrypted-reasoning',
        encryptedContent: 'secret',
      },
      turnIndex: 1,
      model: 'codex',
      sessionId: 's1',
      messageId: 'm1',
      latestUserPrompt: 'draw',
      content,
      orderedParts,
      emitter: {
        sendContentPart: part => emittedParts.push(part),
      },
      handleTextChunk: () => null,
    })).resolves.toBe(true)
    expect(orderedParts).toEqual([{
      type: 'provider-data',
      providerData: {
        provider: 'codex',
        type: 'encrypted-reasoning',
        encryptedContent: 'secret',
      },
      turnIndex: 1,
    }])

    await expect(applyAgentLoopProviderDataWithAdapters<TestPart>({
      providerData: {
        provider: 'provider-x',
        type: 'custom-ui',
      },
      turnIndex: 2,
      model: 'model-x',
      sessionId: 's1',
      messageId: 'm1',
      content,
      orderedParts,
      emitter: {
        sendContentPart: part => emittedParts.push(part),
      },
      handleTextChunk: () => null,
      applyProviderData: runtimeOptions => {
        runtimeOptions.emitter.sendContentPart({
          type: 'custom-provider-ui',
          turnIndex: runtimeOptions.turnIndex,
        } as TestPart)
        return true
      },
    })).resolves.toBe(true)
    expect(emittedParts).toEqual([{
      type: 'custom-provider-ui',
      turnIndex: 2,
    }])

    await expect(applyAgentLoopProviderDataWithAdapters<TestPart>({
      providerData: {
        provider: 'other',
        type: 'ignored-provider-data',
      },
      turnIndex: 4,
      model: 'other',
      sessionId: 's1',
      messageId: 'm1',
      content,
      orderedParts,
      emitter: {
        sendContentPart: part => emittedParts.push(part),
      },
      handleTextChunk: () => null,
      planProviderData: () => ({ kind: 'ignore' }),
    })).resolves.toBe(false)
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

  it('plans agent-loop content-part dispatch and persistence in core', () => {
    const turn = createAgentLoopExecutorTurnState<unknown, { type: string; content?: string; turnIndex?: number }>()
    turn.orderedParts.push(
      { type: 'provider-data', turnIndex: 1 },
      { type: 'text', content: 'hello', turnIndex: 1 },
      { type: 'reasoning', content: 'think', turnIndex: 1 },
    )

    expect(planAgentLoopToolContentPartsDispatch(turn, 1)).toEqual({
      shouldSend: true,
      parts: [
        { type: 'text', content: 'hello', turnIndex: 1 },
        { type: 'reasoning', content: 'think', turnIndex: 1 },
      ],
      dataStepsPart: { type: 'data-steps', turnIndex: 1 },
    })

    turn.hasSentToolParts = true
    expect(planAgentLoopToolContentPartsDispatch(turn, 1)).toEqual({
      shouldSend: false,
      parts: [],
    })

    expect(planAgentLoopTurnContentPersistence(turn, 1)).toEqual({
      persistParts: [
        { type: 'provider-data', turnIndex: 1 },
        { type: 'text', content: 'hello', turnIndex: 1 },
        { type: 'reasoning', content: 'think', turnIndex: 1 },
      ],
      immediateParts: [
        { type: 'text', content: 'hello', turnIndex: 1 },
        { type: 'reasoning', content: 'think', turnIndex: 1 },
      ],
    })

    turn.toolCalls.push({ id: 'call-1' })
    expect(planAgentLoopTurnContentPersistence(turn, 1)).toEqual({
      persistParts: [
        { type: 'provider-data', turnIndex: 1 },
        { type: 'text', content: 'hello', turnIndex: 1 },
        { type: 'reasoning', content: 'think', turnIndex: 1 },
        { type: 'data-steps', turnIndex: 1 },
      ],
      immediateParts: [],
    })

    const adapterTurn = createAgentLoopExecutorTurnState<unknown, { type: string; content?: string; turnIndex?: number }>()
    adapterTurn.orderedParts.push(
      { type: 'provider-data', turnIndex: 2 },
      { type: 'text', content: 'adapter', turnIndex: 2 },
    )
    const sentParts: unknown[] = []
    const persistedParts: unknown[] = []

    expect(dispatchAgentLoopToolContentPartsWithAdapters({
      turn: adapterTurn,
      turnIndex: 2,
      emitter: {
        sendContentPart: part => sentParts.push(part),
      },
    })).toMatchObject({ shouldSend: true })
    expect(adapterTurn.hasSentToolParts).toBe(true)
    expect(sentParts).toEqual([
      { type: 'text', content: 'adapter', turnIndex: 2 },
      { type: 'data-steps', turnIndex: 2 },
    ])

    adapterTurn.toolCalls.push({ id: 'call-adapter' })
    expect(persistAgentLoopTurnContentPartsWithAdapters({
      sessionId: 's1',
      assistantMessageId: 'm1',
      turn: adapterTurn,
      turnIndex: 2,
      store: {
        addMessageContentPart: (_sessionId, _messageId, part) => persistedParts.push(part),
      },
      emitter: {
        sendContentPart: part => sentParts.push(part),
      },
    })).toMatchObject({ immediateParts: [] })
    expect(persistedParts).toEqual([
      { type: 'provider-data', turnIndex: 2 },
      { type: 'text', content: 'adapter', turnIndex: 2 },
      { type: 'data-steps', turnIndex: 2 },
    ])
  })

  it('keeps the steps anchor at its streamed position when text follows the tool call (external agents)', () => {
    // External agents interleave text → tool → text inside one turn: the
    // dispatch records the anchor inline, and persistence must not append a
    // second anchor at the end (which would yank the cards below the text).
    const turn = createAgentLoopExecutorTurnState<unknown, { type: string; content?: string; turnIndex?: number }>()
    turn.orderedParts.push({ type: 'text', content: 'before ', turnIndex: 0 })

    const sent: unknown[] = []
    dispatchAgentLoopToolContentPartsWithAdapters({
      turn,
      turnIndex: 0,
      emitter: { sendContentPart: part => sent.push(part) },
    })
    turn.toolCalls.push({ id: 'call-1' })
    // Post-tool text arrives after the anchor.
    turn.orderedParts.push({ type: 'text', content: ' after', turnIndex: 0 })

    expect(turn.orderedParts).toEqual([
      { type: 'text', content: 'before ', turnIndex: 0 },
      { type: 'data-steps', turnIndex: 0 },
      { type: 'text', content: ' after', turnIndex: 0 },
    ])
    expect(planAgentLoopTurnContentPersistence(turn, 0)).toEqual({
      persistParts: [
        { type: 'text', content: 'before ', turnIndex: 0 },
        { type: 'data-steps', turnIndex: 0 },
        { type: 'text', content: ' after', turnIndex: 0 },
      ],
      immediateParts: [],
    })
  })
})
