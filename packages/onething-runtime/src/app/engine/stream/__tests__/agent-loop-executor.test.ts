import { afterEach, describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS, type ToolCall } from '@shared/ipc.js'
import { createDefaultSettings } from '@shared/defaults/settings.js'
import {
  applyAgentLoopStreamChunk,
  completeAgentLoopStream,
  runAgentLoopPostResponseHooks,
  shouldUseAgentLoopStream,
  type AgentLoopExecutorState,
} from '../agent-loop-executor.js'
import { triggerManager } from '../../triggers/index.js'
import { runAfterAssistantResponseHooks } from '../../../plugins/lifecycle.js'
import type { saveMediaImage } from '@onething/runtime/media/save-image'
import type { BuildAgentLoopStreamRuntimeResult } from '../agent-loop-runtime.js'
import type { IPCEmitter } from '../ipc-emitter.js'
import type { StreamProcessor, StreamSender } from '../stream-processor.js'

type SaveMediaImageInput = Parameters<typeof saveMediaImage>[0]
type AgentLoopSelectionContext = Parameters<typeof shouldUseAgentLoopStream>[0]
type SupportedAgentLoopRuntimeResult = Extract<BuildAgentLoopStreamRuntimeResult, { supported: true }>

const mediaMocks = vi.hoisted(() => ({
  saveMediaImage: vi.fn(async (input: SaveMediaImageInput) => ({
    id: 'media_1',
    filePath: '/tmp/media_1.png',
    prompt: input.prompt,
    revisedPrompt: input.revisedPrompt,
    model: input.model,
    sessionId: input.sessionId,
    messageId: input.messageId,
    createdAt: 123,
  })),
}))

const storeMocks = vi.hoisted(() => ({
  addMessage: vi.fn(),
  addMessageContentPart: vi.fn(),
  updateMessageToolCalls: vi.fn(),
  updateMessageUsage: vi.fn(),
  updateMessageError: vi.fn(),
  getSession: vi.fn(() => ({ name: 'Test Session', messages: [] })),
  updateMessageContent: vi.fn(),
  updateMessageReasoning: vi.fn(),
  updateMessageStreaming: vi.fn(),
  addMessageStep: vi.fn(),
  updateMessageStep: vi.fn(),
  updateSessionContextSize: vi.fn(),
  updateMessageSkill: vi.fn(),
  flushSessionSave: vi.fn(async () => undefined),
}))

vi.mock('../../../store.js', () => ({
  ...storeMocks,
}))

vi.mock('../../triggers/index.js', () => ({
  triggerManager: {
    runPostResponse: vi.fn(() => Promise.resolve()),
  },
}))

vi.mock('../../../plugins/lifecycle.js', () => ({
  runAfterAssistantResponseHooks: vi.fn(() => Promise.resolve()),
}))

vi.mock('@onething/runtime/media/save-image', () => ({
  saveMediaImage: mediaMocks.saveMediaImage,
}))

function testSelectionContext(ctx: AgentLoopSelectionContext): AgentLoopSelectionContext {
  return ctx
}

function supportedPrepared(overrides: Partial<SupportedAgentLoopRuntimeResult> = {}): SupportedAgentLoopRuntimeResult {
  return {
    supported: true,
    runtime: {
      provider: { id: 'test-provider' },
      model: 'test-model',
      messages: [],
      sessionId: 's1',
      messageId: 'm1',
    },
    systemPrompt: 'system',
    sections: [],
    enabledSkills: [],
    toolNames: ['read'],
    mcpToolNames: ['mcp_search'],
    hasTools: true,
    supportsTools: true,
    modelContextLength: 128000,
    reservedOutputTokens: 4096,
    ...overrides,
  }
}

function createState(): AgentLoopExecutorState {
  const toolCalls: ToolCall[] = []
  const stepIds = new Map<string, string>()
  const inputBuffers = new Map<string, { toolName: string; argsText: string }>()
  const sender: StreamSender = {
    isDestroyed: () => false,
    send: vi.fn(),
  }
  const emitter: IPCEmitter = {
    sendTextChunk: vi.fn(),
    sendReasoningChunk: vi.fn(),
    sendContentPart: vi.fn(),
    sendContinuation: vi.fn(),
    sendToolCall: vi.fn(),
    sendToolInputEnd: vi.fn(),
    sendToolResult: vi.fn(),
    sendToolInputStart: vi.fn(),
    sendToolInputDelta: vi.fn(),
    sendToolExecutionStart: vi.fn(),
    sendToolExecutionUpdate: vi.fn(),
    sendToolExecutionEnd: vi.fn(),
    sendContextSizeUpdate: vi.fn(),
    sendStepAdded: vi.fn(),
    sendStepUpdated: vi.fn(),
    sendStreamComplete: vi.fn(),
    sendStreamError: vi.fn(),
    sendStreamAborted: vi.fn(),
    sendSkillActivated: vi.fn(),
  }
  const processor: StreamProcessor = {
    get accumulatedContent() { return '' },
    get accumulatedReasoning() { return '' },
    get toolCalls() { return toolCalls },
    handleTextChunk: vi.fn(text => text),
    handleReasoningChunk: vi.fn(),
    handleToolCallChunk: vi.fn((toolCallData) => {
      let toolCall = toolCalls.find(existing => existing.id === toolCallData.toolCallId)
      if (!toolCall) {
        toolCall = {
          id: toolCallData.toolCallId,
          toolId: toolCallData.toolName,
          toolName: toolCallData.toolName,
          arguments: toolCallData.args,
          status: 'pending',
          timestamp: 1,
        }
        toolCalls.push(toolCall)
      } else {
        toolCall.arguments = toolCallData.args
        toolCall.status = 'pending'
        delete toolCall.streamingArgs
      }
      return toolCall
    }),
    handleToolInputStart: vi.fn((toolCallId, toolName) => {
      inputBuffers.set(toolCallId, { toolName, argsText: '' })
      stepIds.set(toolCallId, `step-${toolCallId}`)
      toolCalls.push({
        id: toolCallId,
        toolId: toolName,
        toolName,
        arguments: {},
        status: 'input-streaming',
        streamingArgs: '',
        timestamp: 1,
      })
    }),
    handleToolInputDelta: vi.fn((toolCallId, argsTextDelta) => {
      const buffer = inputBuffers.get(toolCallId)
      if (buffer) buffer.argsText += argsTextDelta
    }),
    handleToolInputEnd: vi.fn((toolCallId) => {
      const buffer = inputBuffers.get(toolCallId)
      if (!buffer) return null
      inputBuffers.delete(toolCallId)
      const toolCall = toolCalls.find(existing => existing.id === toolCallId)
      if (!toolCall) return null
      toolCall.arguments = buffer.argsText ? JSON.parse(buffer.argsText) : {}
      toolCall.status = 'pending'
      delete toolCall.streamingArgs
      return toolCall
    }),
    getStepIdForToolCall: vi.fn(toolCallId => stepIds.get(toolCallId)),
    isToolCallHidden: () => false,
    finalize: vi.fn(),
  }

  return {
    ctx: {
      sessionId: 's1',
      assistantMessageId: 'm1',
      providerId: 'deepseek',
      providerConfig: { model: 'deepseek-v4-flash', selectedModels: ['deepseek-v4-flash'] },
      abortSignal: new AbortController().signal,
      settings: createDefaultSettings(),
      toolSettings: undefined,
      sender,
    },
    processor,
    emitter,
    turnIndex: 1,
    turn: {
      toolCalls: [],
      content: { value: '' },
      reasoning: { value: '' },
      orderedParts: [],
      hasSentToolParts: false,
    },
    stepIdsByToolCallId: new Map(),
    toolIterations: 0,
    skillManageCalled: false,
    latestUserPrompt: 'draw moon',
  }
}

describe('agent loop executor', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  it('routes supported providers by default and ignores legacy opt-out', () => {
    expect(shouldUseAgentLoopStream(testSelectionContext({ providerId: 'deepseek' }))).toBe(true)
    expect(shouldUseAgentLoopStream(testSelectionContext({ providerId: 'openai' }))).toBe(true)
    expect(shouldUseAgentLoopStream(testSelectionContext({
      providerId: 'deepseek',
      settings: { chat: { agentLoopStream: false } },
    }))).toBe(true)

    vi.stubEnv('ONETHING_AGENT_LOOP_STREAM', '1')

    expect(shouldUseAgentLoopStream(testSelectionContext({
      providerId: 'deepseek',
      settings: { chat: { agentLoopStream: false } },
    }))).toBe(true)
  })

  it('can route supported providers through agent-loop via chat settings', () => {
    expect(shouldUseAgentLoopStream(testSelectionContext({
      providerId: 'deepseek',
      settings: { chat: { agentLoopStream: true } },
    }))).toBe(true)
    expect(shouldUseAgentLoopStream(testSelectionContext({
      providerId: 'openai',
      settings: { chat: { agentLoopStream: true } },
    }))).toBe(true)
    expect(shouldUseAgentLoopStream(testSelectionContext({
      providerId: 'unsupported-provider',
      settings: { chat: { agentLoopStream: true } },
    }))).toBe(false)
  })

  it('maps internally executed tool chunks onto existing tool and step events', async () => {
    const state = createState()

    vi.mocked(state.processor.handleToolInputEnd).mockImplementation((toolCallId) => {
      const toolCall = state.processor.toolCalls.find(existing => existing.id === toolCallId)
      if (!toolCall) return null
      toolCall.arguments = { query: 'moon' }
      toolCall.status = 'pending'
      delete toolCall.streamingArgs
      return toolCall
    })

    await applyAgentLoopStreamChunk(state, {
      type: 'tool-input-start',
      toolInputStart: { toolCallId: 'call_1', toolName: 'lookup' },
    })
    await applyAgentLoopStreamChunk(state, {
      type: 'tool-input-delta',
      toolInputDelta: { toolCallId: 'call_1', argsTextDelta: '{"query":"moon"}' },
    })
    await applyAgentLoopStreamChunk(state, {
      type: 'tool-input-end',
      toolInputEnd: { toolCallId: 'call_1', finalizedBy: 'parse' },
    })
    await applyAgentLoopStreamChunk(state, {
      type: 'tool-result',
      toolResult: {
        toolCallId: 'call_1',
        result: { content: 'result: moon', data: { output: 'result: moon' } },
      },
    })

    expect(state.emitter.sendContentPart).toHaveBeenCalledWith({ type: 'data-steps', turnIndex: 1 })
    expect(state.emitter.sendToolExecutionStart).toHaveBeenCalledWith(
      'call_1',
      'step-call_1',
      'lookup',
      { query: 'moon' },
      expect.any(Number),
    )
    expect(state.processor.toolCalls[0]).toMatchObject({
      id: 'call_1',
      status: 'completed',
      result: { output: 'result: moon' },
    })
    expect(state.toolIterations).toBe(1)
    expect(state.skillManageCalled).toBe(false)
    expect(state.emitter.sendToolResult).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'call_1', status: 'completed' }),
    )
    expect(state.emitter.sendStepUpdated).toHaveBeenLastCalledWith(
      'step-call_1',
      expect.objectContaining({
        status: 'completed',
        result: 'result: moon',
      }),
    )
  })

  it('routes text and reasoning deltas through the stream processor', async () => {
    const state = createState()

    await applyAgentLoopStreamChunk(state, {
      type: 'text',
      text: 'hello',
    })
    await applyAgentLoopStreamChunk(state, {
      type: 'reasoning',
      reasoning: 'think',
    })

    expect(state.processor.handleTextChunk).toHaveBeenCalledWith('hello', state.turn.content, 1)
    expect(state.processor.handleReasoningChunk).toHaveBeenCalledWith('think', state.turn.reasoning, 1, 'inline')
  })

  it('maps tool metadata and partial results onto existing step events', async () => {
    const state = createState()

    vi.mocked(state.processor.handleToolInputEnd).mockImplementation((toolCallId) => {
      const toolCall = state.processor.toolCalls.find(existing => existing.id === toolCallId)
      if (!toolCall) return null
      toolCall.arguments = { path: '/tmp/a.txt' }
      toolCall.status = 'pending'
      delete toolCall.streamingArgs
      return toolCall
    })

    await applyAgentLoopStreamChunk(state, {
      type: 'tool-input-start',
      toolInputStart: { toolCallId: 'call_1', toolName: 'edit' },
    })
    await applyAgentLoopStreamChunk(state, {
      type: 'tool-input-end',
      toolInputEnd: { toolCallId: 'call_1', finalizedBy: 'parse' },
    })
    await applyAgentLoopStreamChunk(state, {
      type: 'tool-metadata',
      toolMetadata: {
        toolCallId: 'call_1',
        update: {
          title: 'Preview edit',
          metadata: {
            path: '/tmp/a.txt',
            diff: '-old\n+new',
            additions: 1,
            deletions: 1,
          },
        },
      },
    })
    await applyAgentLoopStreamChunk(state, {
      type: 'tool-partial-result',
      toolPartialResult: {
        toolCallId: 'call_1',
        update: { content: [{ type: 'text', text: 'halfway' }] },
      },
    })

    expect(state.emitter.sendStepUpdated).toHaveBeenCalledWith(
      'step-call_1',
      expect.objectContaining({
        title: 'Preview edit',
        toolCall: expect.objectContaining({
          changes: {
            diff: '-old\n+new',
            filePath: '/tmp/a.txt',
            additions: 1,
            deletions: 1,
          },
        }),
      }),
    )
    expect(state.emitter.sendToolExecutionUpdate).toHaveBeenCalledWith(
      'call_1',
      'step-call_1',
      { content: [{ type: 'text', text: 'halfway' }] },
    )
    expect(state.emitter.sendStepUpdated).toHaveBeenLastCalledWith(
      'step-call_1',
      expect.objectContaining({
        status: 'running',
        partialResultIsPartial: true,
        result: 'halfway',
      }),
    )
  })

  it('maps confirmation-gated tool results onto awaiting-confirmation state', async () => {
    const state = createState()

    vi.mocked(state.processor.handleToolInputEnd).mockImplementation((toolCallId) => {
      const toolCall = state.processor.toolCalls.find(existing => existing.id === toolCallId)
      if (!toolCall) return null
      toolCall.arguments = { cmd: 'rm -rf tmp' }
      toolCall.status = 'pending'
      delete toolCall.streamingArgs
      return toolCall
    })

    await applyAgentLoopStreamChunk(state, {
      type: 'tool-input-start',
      toolInputStart: { toolCallId: 'call_1', toolName: 'bash' },
    })
    await applyAgentLoopStreamChunk(state, {
      type: 'tool-input-end',
      toolInputEnd: { toolCallId: 'call_1', finalizedBy: 'parse' },
    })
    await applyAgentLoopStreamChunk(state, {
      type: 'tool-result',
      toolResult: {
        toolCallId: 'call_1',
        result: {
          content: '',
          error: 'Needs approval',
          requiresConfirmation: true,
          commandType: 'dangerous',
        },
      },
    })

    expect(state.processor.toolCalls[0]).toMatchObject({
      id: 'call_1',
      status: 'pending',
      requiresConfirmation: true,
      commandType: 'dangerous',
      error: 'Needs approval',
    })
    expect(state.toolIterations).toBe(1)
    expect(state.emitter.sendToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'call_1',
        status: 'pending',
        requiresConfirmation: true,
      }),
    )
    expect(state.emitter.sendStepUpdated).toHaveBeenLastCalledWith(
      'step-call_1',
      expect.objectContaining({
        status: 'awaiting-confirmation',
        error: 'Needs approval',
        toolCall: expect.objectContaining({
          id: 'call_1',
          requiresConfirmation: true,
          commandType: 'dangerous',
        }),
      }),
    )
  })

  it('creates a new assistant writer when a natural turn continues', async () => {
    const state = createState()
    const firstProcessor = state.processor

    await applyAgentLoopStreamChunk(state, {
      type: 'turn-start',
      turnStart: { turn: 1 },
    })
    await applyAgentLoopStreamChunk(state, {
      type: 'text',
      text: 'first answer',
    })
    await applyAgentLoopStreamChunk(state, {
      type: 'finish',
      finishReason: 'stop',
    })
    await applyAgentLoopStreamChunk(state, {
      type: 'turn-start',
      turnStart: { turn: 2 },
    })

    expect(vi.mocked(firstProcessor.finalize)).toHaveBeenCalled()
    expect(storeMocks.addMessage).toHaveBeenCalledWith('s1', expect.objectContaining({
      role: 'assistant',
      model: 'deepseek-v4-flash',
      provider: 'deepseek',
      isStreaming: true,
      content: '',
    }))
    expect(state.ctx.assistantMessageId).not.toBe('m1')
    expect(state.processor).not.toBe(firstProcessor)
    expect(state.turnIndex).toBe(2)
    expect(state.turn.content.value).toBe('')

    const nextAssistantMessageId = state.ctx.assistantMessageId
    await completeAgentLoopStream(state, 'Session')

    expect(storeMocks.updateMessageStreaming).toHaveBeenCalledWith('s1', nextAssistantMessageId, false)
  })

  it('keeps the same assistant writer across a tool-calls continuation without a boundary', async () => {
    const state = createState()
    const firstProcessor = state.processor

    await applyAgentLoopStreamChunk(state, {
      type: 'turn-start',
      turnStart: { turn: 1 },
    })
    await applyAgentLoopStreamChunk(state, {
      type: 'finish',
      finishReason: 'tool-calls',
    })
    await applyAgentLoopStreamChunk(state, {
      type: 'turn-start',
      turnStart: { turn: 2 },
    })

    expect(state.ctx.assistantMessageId).toBe('m1')
    expect(state.processor).toBe(firstProcessor)
  })

  it('creates a new assistant writer when a steering interrupt cuts the tool-call loop', async () => {
    const state = createState()
    const firstProcessor = state.processor

    await applyAgentLoopStreamChunk(state, {
      type: 'turn-start',
      turnStart: { turn: 1 },
    })
    await applyAgentLoopStreamChunk(state, {
      type: 'text',
      text: 'working on it',
    })
    // Mid tool-call loop: the turn ends with tool-calls, then a steering
    // message is injected before the next turn.
    await applyAgentLoopStreamChunk(state, {
      type: 'finish',
      finishReason: 'tool-calls',
    })
    await applyAgentLoopStreamChunk(state, {
      type: 'response-boundary',
      responseBoundary: { turn: 2 },
    })
    await applyAgentLoopStreamChunk(state, {
      type: 'turn-start',
      turnStart: { turn: 2 },
    })

    expect(vi.mocked(firstProcessor.finalize)).toHaveBeenCalled()
    expect(storeMocks.addMessage).toHaveBeenCalledWith('s1', expect.objectContaining({
      role: 'assistant',
      isStreaming: true,
      content: '',
    }))
    expect(state.ctx.assistantMessageId).not.toBe('m1')
    expect(state.processor).not.toBe(firstProcessor)
    expect(state.turn.content.value).toBe('')
  })

  it('handles Codex provider data for encrypted reasoning and image generation', async () => {
    const state = createState()

    await applyAgentLoopStreamChunk(state, {
      type: 'provider-data',
      providerData: {
        provider: 'codex',
        type: 'encrypted-reasoning',
        encryptedContent: 'encrypted-payload',
      },
    })
    await applyAgentLoopStreamChunk(state, {
      type: 'provider-data',
      providerData: {
        provider: 'codex',
        type: 'image-generation-start',
        callId: 'img_1',
      },
    })
    await applyAgentLoopStreamChunk(state, {
      type: 'provider-data',
      providerData: {
        provider: 'codex',
        type: 'image-generation-result',
        callId: 'img_1',
        status: 'completed',
        revisedPrompt: 'better moon',
        result: 'base64-image',
      },
    })

    expect(state.turn.orderedParts[0]).toEqual({
      type: 'provider-data',
      providerData: {
        provider: 'codex',
        type: 'encrypted-reasoning',
        encryptedContent: 'encrypted-payload',
      },
      turnIndex: 1,
    })
    expect(state.emitter.sendContentPart).toHaveBeenCalledWith({
      type: 'image-loading',
      turnIndex: 1,
      label: 'Generating image',
    })
    expect(mediaMocks.saveMediaImage).toHaveBeenCalledWith({
      base64: 'base64-image',
      prompt: 'draw moon',
      revisedPrompt: 'better moon',
      model: 'deepseek-v4-flash',
      sessionId: 's1',
      messageId: 'm1',
    })
    expect(state.processor.handleTextChunk).toHaveBeenCalledWith(
      expect.stringContaining('![Generated Image|mediaId:media_1](media://media_1.png)'),
      state.turn.content,
      1,
    )
    expect(state.turn.orderedParts).toContainEqual({
      type: 'text',
      content: expect.stringContaining('**Revised prompt:** better moon'),
      turnIndex: 1,
    })
    expect(state.ctx.sender.send).toHaveBeenCalledWith(
      IPC_CHANNELS.IMAGE_GENERATED,
      expect.objectContaining({
        id: 'media_1',
        mediaId: 'media_1',
        filePath: '/tmp/media_1.png',
        prompt: 'draw moon',
        revisedPrompt: 'better moon',
        sessionId: 's1',
        messageId: 'm1',
      }),
    )
  })

  it('runs post-response triggers and plugin hooks with agent-loop metadata', () => {
    const state = createState()
    Object.defineProperty(state.processor, 'accumulatedContent', {
      get: () => 'assistant answer',
    })

    runAgentLoopPostResponseHooks({
      state,
      prepared: supportedPrepared(),
      historyMessages: [
        { role: 'user', content: 'hello' },
      ],
    })

    expect(triggerManager.runPostResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
        lastUserMessage: 'hello',
        lastAssistantMessage: 'assistant answer',
        enabledToolNames: ['read', 'mcp_search'],
        toolIterations: 0,
        skillManageCalled: false,
      }),
    )
    expect(runAfterAssistantResponseHooks).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
        assistantMessageId: 'm1',
        lastAssistantMessage: 'assistant answer',
      }),
    )
  })
})
