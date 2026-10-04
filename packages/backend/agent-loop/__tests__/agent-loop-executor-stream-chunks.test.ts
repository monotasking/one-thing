import { describe, expect, it } from 'vitest'
import { applyAgentLoopStreamChunkWithAdapters, createAgentLoopExecutorTurnState, executeAgentLoopStreamLifecycleWithAdapters } from '@onething/backend/agent-loop'
import { applyAgentLoopReasoningChunkWithAdapters, applyAgentLoopTextChunkWithAdapters, applyAgentLoopProviderDataWithAdapters, applyAgentLoopTurnStartWithAdapters, planAgentLoopProviderData } from '../agent-loop-executor-stream-chunks.js'
import type { JsonObject, JsonValue } from '@shared/json'

describe('core agent-loop executor helpers', () => {
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
      sendSkillActivated(skillName: string) {
        events.push(`skill:${skillName}`)
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
})
