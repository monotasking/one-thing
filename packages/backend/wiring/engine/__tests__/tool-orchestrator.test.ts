import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ChatSession, ToolCall } from '@shared/ipc'
import { createDefaultSettings } from '@shared/defaults/settings.js'
import type { JsonObject } from '@shared/json.js'
import type { IPCEmitter } from '@onething/runtime/engine/ipc-emitter.wiring'
import type { StreamContext, StreamProcessor } from '../stream/stream-processor.js'

const mockBus = {
  emit: vi.fn(async () => undefined),
}
vi.mock('../../../session/reads.js', async () => {
  const store = await import('../../../store.js')
  return { sessionReads: { getMessage: (sessionId: string, messageId: string) => store.getSession(sessionId)?.messages.find(message => message.id === messageId) } }
})

vi.mock('../../../store.js', () => ({
  updateMessageToolCalls: vi.fn(),
  updateMessageSteps: vi.fn(),
  updateMessageContentParts: vi.fn(),
  getSession: vi.fn(() => ({
    messages: [{
      id: 'msg',
      toolCalls: [],
      steps: [
        { id: 's1', type: 'tool-call', title: 'edit', status: 'running', timestamp: 0, toolCallId: 'edit' },
        { id: 's2', type: 'tool-call', title: 'read', status: 'running', timestamp: 0, toolCallId: 'read' },
      ],
      contentParts: [{ type: 'tool-call', toolCalls: [] }],
    }],
  })),
}))

vi.mock('../../../events/index.js', () => ({
  getEventBus: () => ({ emit: mockBus.emit }),
}))

vi.mock('../stream/tool-execution.js', () => ({
  executeToolDirectly: vi.fn(),
  executeToolAndUpdate: vi.fn(async (_ctx, toolCall: ToolCall) => {
    if (toolCall.id === 'edit') {
      toolCall.status = 'failed'
      toolCall.rejected = true
      return
    }
    if (toolCall.id === 'read') {
      throw new Error('read should have been discarded')
    }
  }),
}))

function toolCall(id: string, toolId: string): ToolCall {
  return {
    id,
    toolId,
    toolName: toolId,
    arguments: {},
    status: 'pending',
    timestamp: 0,
  }
}

function testSession(message: Partial<ChatMessage> = {}): ChatSession {
  const assistantMessage: ChatMessage = {
    id: 'msg',
    role: 'assistant',
    content: '',
    timestamp: 0,
    toolCalls: [],
    steps: [
      { id: 's1', type: 'tool-call', title: 'edit', status: 'running', timestamp: 0, toolCallId: 'edit' },
      { id: 's2', type: 'tool-call', title: 'read', status: 'running', timestamp: 0, toolCallId: 'read' },
    ],
    contentParts: [{ type: 'tool-call', toolCalls: [] }],
    ...message,
  }

  return {
    id: 'session',
    name: 'Tool session',
    createdAt: 0,
    updatedAt: 0,
    messages: [assistantMessage],
  }
}

function testContext(): StreamContext {
  return {
    sessionId: 'session',
    assistantMessageId: 'msg',
    abortSignal: new AbortController().signal,
    settings: createDefaultSettings(),
    providerConfig: {
      model: 'test-model',
      selectedModels: ['test-model'],
      apiKey: 'test-key',
    },
    providerId: 'deepseek',
    toolSettings: undefined,
    sender: {
      isDestroyed: () => false,
      send: vi.fn(),
    },
  }
}

function testProcessor(toolCalls: ToolCall[]): StreamProcessor {
  return {
    get accumulatedContent() { return '' },
    get accumulatedReasoning() { return '' },
    get toolCalls() { return toolCalls },
    handleTextChunk: vi.fn(text => text),
    handleReasoningChunk: vi.fn(),
    handleToolCallChunk: vi.fn(() => toolCalls[0]),
    handleToolInputStart: vi.fn(),
    handleToolInputDelta: vi.fn(),
    handleToolInputEnd: vi.fn(() => toolCalls[0] ?? null),
    getStepIdForToolCall: vi.fn(() => undefined),
    isToolCallHidden: () => false,
    finalize: vi.fn(async () => undefined),
  }
}

function testEmitter(overrides: Partial<IPCEmitter> = {}): IPCEmitter {
  return {
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
    ...overrides,
  }
}

function toolArgs(args: JsonObject): JsonObject {
  return args
}

describe('ToolOrchestrator', () => {
  beforeEach(async () => {
    mockBus.emit.mockClear()
    const { executeToolAndUpdate } = await import('../stream/tool-execution')
    vi.mocked(executeToolAndUpdate).mockReset()
    vi.mocked(executeToolAndUpdate).mockImplementation(async (_ctx: StreamContext, toolCall: ToolCall) => {
      if (toolCall.id === 'edit') {
        toolCall.status = 'failed'
        toolCall.rejected = true
        return
      }
      if (toolCall.id === 'read') {
        throw new Error('read should have been discarded')
      }
    })
    const store = await import('../../../store.js')
    vi.mocked(store.getSession).mockReturnValue(testSession({
        toolCalls: [],
        steps: [
          { id: 's1', type: 'tool-call', title: 'edit', status: 'running', timestamp: 0, toolCallId: 'edit' },
          { id: 's2', type: 'tool-call', title: 'read', status: 'running', timestamp: 0, toolCallId: 'read' },
        ],
        contentParts: [{ type: 'tool-call', toolCalls: [] }],
    }))
  })

  it('does not emit a stale message update for a hidden tool that was never published', async () => {
    const { ToolOrchestrator } = await import('../stream/tool-orchestrator')
    const { executeToolAndUpdate } = await import('../stream/tool-execution')
    const store = await import('../../../store.js')
    vi.mocked(executeToolAndUpdate).mockReset()
    mockBus.emit.mockClear()

    let releaseFirst!: () => void
    const firstExecution = new Promise<void>(resolve => { releaseFirst = resolve })
    vi.mocked(executeToolAndUpdate)
      .mockImplementationOnce(async () => firstExecution)
      .mockImplementationOnce(async (_ctx: StreamContext, toolCall: ToolCall) => {
        toolCall.status = 'completed'
      })

    vi.mocked(store.getSession).mockReturnValue(testSession({
        toolCalls: [toolCall('permissioned-bash', 'bash')],
        steps: [
          { id: 's1', type: 'command', title: 'bash', status: 'running', timestamp: 0, toolCallId: 'permissioned-bash' },
        ],
        contentParts: [{ type: 'data-steps', turnIndex: 1 }],
    }))

    const visible = toolCall('permissioned-bash', 'bash')
    const hidden = toolCall('hidden-read', 'read')
    const processorToolCalls = [visible]
    const orchestrator = new ToolOrchestrator({
      ctx: testContext(),
      processor: testProcessor(processorToolCalls),
      enabledSkills: [],
      turnIndex: 1,
      turnToolCalls: [],
      emitter: testEmitter(),
      beforeFirstTool: vi.fn(),
    })

    orchestrator.start(visible, { toolName: 'bash', args: toolArgs({ command: 'npm run build' }) })
    orchestrator.start(hidden, { toolName: 'read', args: toolArgs({ path: 'README.md' }) })

    expect(mockBus.emit).not.toHaveBeenCalledWith(
      'session',
      expect.objectContaining({ type: 'message:updated' }),
    )

    releaseFirst()
    await orchestrator.waitForAll()
  })

  it('hides and discards tail after a rejected barrier', async () => {
    const { ToolOrchestrator } = await import('../stream/tool-orchestrator')
    const processorToolCalls = [toolCall('edit', 'edit'), toolCall('read', 'read')]
    const turnToolCalls: ToolCall[] = []
    const sent: ToolCall[] = []

    const orchestrator = new ToolOrchestrator({
      ctx: testContext(),
      processor: testProcessor(processorToolCalls),
      enabledSkills: [],
      turnIndex: 1,
      turnToolCalls,
      emitter: testEmitter({
        sendToolCall: (tc: ToolCall) => sent.push({ ...tc }),
      }),
      beforeFirstTool: vi.fn(),
    })

    orchestrator.start(processorToolCalls[0], { toolName: 'edit', args: toolArgs({}) })
    orchestrator.start(processorToolCalls[1], { toolName: 'read', args: toolArgs({}) })

    expect(sent.map(tc => `${tc.id}:${tc.status}`)).toEqual([])
    expect(processorToolCalls.map(tc => tc.id)).toEqual(['edit'])

    await orchestrator.waitForAll()

    expect(processorToolCalls.map(tc => tc.id)).toEqual(['edit'])
    expect(turnToolCalls.map(tc => tc.id)).toEqual(['edit'])
    expect(sent.map(tc => `${tc.id}:${tc.status}`)).toEqual([])
  })

  it('publishes a hidden tail only after the preceding barrier succeeds', async () => {
    const { ToolOrchestrator } = await import('../stream/tool-orchestrator')
    const { executeToolAndUpdate } = await import('../stream/tool-execution')
    vi.mocked(executeToolAndUpdate).mockReset()
    vi.mocked(executeToolAndUpdate)
      .mockImplementationOnce(async (_ctx: StreamContext, toolCall: ToolCall) => {
        toolCall.status = 'completed'
      })
      .mockImplementationOnce(async (_ctx: StreamContext, toolCall: ToolCall) => {
        toolCall.status = 'completed'
      })

    const processorToolCalls = [toolCall('edit-success', 'edit'), toolCall('bash-after-success', 'bash')]
    const turnToolCalls: ToolCall[] = []
    const sent: ToolCall[] = []

    const orchestrator = new ToolOrchestrator({
      ctx: testContext(),
      processor: testProcessor(processorToolCalls),
      enabledSkills: [],
      turnIndex: 1,
      turnToolCalls,
      emitter: testEmitter({
        sendToolCall: (tc: ToolCall) => sent.push({ ...tc }),
      }),
      beforeFirstTool: vi.fn(),
    })

    orchestrator.start(processorToolCalls[0], { toolName: 'edit', args: toolArgs({}) })
    orchestrator.start(processorToolCalls[1], { toolName: 'bash', args: toolArgs({ command: 'npm run build' }) })

    expect(sent.map(tc => `${tc.id}:${tc.status}`)).toEqual([])
    expect(processorToolCalls.map(tc => tc.id)).toEqual(['edit-success'])

    await orchestrator.waitForAll()

    expect(processorToolCalls.map(tc => `${tc.id}:${tc.status}`)).toEqual(['edit-success:completed', 'bash-after-success:completed'])
    expect(turnToolCalls.map(tc => tc.id)).toEqual(['edit-success', 'bash-after-success'])
  })

  it('continues hidden tail after a failed tool that is not a rejection', async () => {
    const { ToolOrchestrator } = await import('../stream/tool-orchestrator')
    const { executeToolAndUpdate } = await import('../stream/tool-execution')
    vi.mocked(executeToolAndUpdate).mockReset()
    vi.mocked(executeToolAndUpdate)
      .mockImplementationOnce(async (_ctx: StreamContext, toolCall: ToolCall) => {
        toolCall.status = 'failed'
        toolCall.error = 'Exact edit text not found'
      })
      .mockImplementationOnce(async (_ctx: StreamContext, toolCall: ToolCall) => {
        toolCall.status = 'completed'
      })

    const processorToolCalls = [toolCall('edit-failed', 'edit'), toolCall('bash-after-edit', 'bash')]
    const turnToolCalls: ToolCall[] = []
    const sent: ToolCall[] = []

    const orchestrator = new ToolOrchestrator({
      ctx: testContext(),
      processor: testProcessor(processorToolCalls),
      enabledSkills: [],
      turnIndex: 1,
      turnToolCalls,
      emitter: testEmitter({
        sendToolCall: (tc: ToolCall) => sent.push({ ...tc }),
      }),
      beforeFirstTool: vi.fn(),
    })

    orchestrator.start(processorToolCalls[0], { toolName: 'edit', args: toolArgs({}) })
    orchestrator.start(processorToolCalls[1], { toolName: 'bash', args: toolArgs({ command: 'npm run build' }) })

    await orchestrator.waitForAll()

    expect(processorToolCalls.map(tc => tc.id)).toEqual(['edit-failed', 'bash-after-edit'])
    expect(turnToolCalls.map(tc => tc.id)).toEqual(['edit-failed', 'bash-after-edit'])
    expect(sent.map(tc => `${tc.id}:${tc.status}`)).toEqual([])
  })

  it('fails repeated identical tool calls before executing the fourth copy', async () => {
    const { ToolOrchestrator } = await import('../stream/tool-orchestrator')
    const processorToolCalls = [
      toolCall('read-1', 'read'),
      toolCall('read-2', 'read'),
      toolCall('read-3', 'read'),
      toolCall('read-4', 'read'),
    ]
    const turnToolCalls: ToolCall[] = []
    const sent: ToolCall[] = []
    const results: ToolCall[] = []

    const orchestrator = new ToolOrchestrator({
      ctx: testContext(),
      processor: testProcessor(processorToolCalls),
      enabledSkills: [],
      turnIndex: 1,
      turnToolCalls,
      emitter: testEmitter({
        sendToolCall: (tc: ToolCall) => sent.push({ ...tc }),
        sendToolResult: (tc: ToolCall) => results.push({ ...tc }),
      }),
      beforeFirstTool: vi.fn(),
    })

    for (const call of [...processorToolCalls]) {
      orchestrator.start(call, { toolName: 'read', args: toolArgs({ path: 'same.txt' }) })
    }

    await orchestrator.waitForAll()

    const repeated = processorToolCalls.find(tc => tc.id === 'read-4')
    expect(repeated?.status).toBe('failed')
    expect(repeated?.error).toContain('Repeated identical tool call detected')
    expect(sent.some(tc => tc.id === 'read-4' && tc.status === 'failed')).toBe(true)
    expect(results.some(tc => tc.id === 'read-4' && tc.status === 'failed')).toBe(true)
  })
})
