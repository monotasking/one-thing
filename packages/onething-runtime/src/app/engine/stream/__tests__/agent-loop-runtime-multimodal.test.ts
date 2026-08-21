import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runAgentLoop } from '@onething/core/agent-loop'
import { PendingMessageQueue } from '../message-queue.js'
import {
  createDefaultSettings,
} from '@shared/defaults/settings.js'
import type { AppSettings, SkillDefinition, ToolDefinition, ToolSettings } from '@shared/ipc.js'
import type {
  AgentMessage,
  AgentModelCapabilities,
  AgentOutputModality,
  AgentProvider,
  AgentToolChoice,
  AgentTurnRequest,
  AgentTurnStreamEvent,
} from '@onething/core/agent-loop'
import type { BuildPromptOptions } from '../../prompt/index.js'
import type { HistoryMessage } from '../message-helpers.js'
import type { IPCEmitter } from '../ipc-emitter.js'
import type { StreamContext, StreamProviderConfig, StreamSender } from '../stream-processor.js'

interface SeenRequest {
  requestedOutputModalities?: AgentOutputModality[]
  toolChoice?: AgentToolChoice
  tools?: string[]
  thinking?: 'enabled' | 'disabled'
  reasoningEffort?: AgentTurnRequest['reasoningEffort']
}

interface TestVisionProvider extends AgentProvider {
  capabilities: AgentModelCapabilities
  streamTurn: (request: AgentTurnRequest) => AsyncIterable<AgentTurnStreamEvent>
}

function cloneAgentMessage(message: AgentMessage): AgentMessage {
  return { ...message }
}

function createVisionProvider(): TestVisionProvider {
  return {
    id: 'vision-runtime-provider',
    capabilities: {
      capabilities: ['text-input', 'vision-input', 'text-output', 'image-output', 'streaming'],
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
      supportsStreaming: true,
    },
    async *streamTurn(request: AgentTurnRequest) {
      mocks.seenMessages.push(request.messages.map(cloneAgentMessage))
      mocks.seenRequests.push({
        requestedOutputModalities: request.requestedOutputModalities,
        toolChoice: request.toolChoice,
        tools: request.tools?.map(tool => tool.name),
        thinking: request.thinking,
        reasoningEffort: request.reasoningEffort,
      })
      yield { type: 'text-delta', turn: request.turn, delta: 'vision ok' }
      yield { type: 'finish', turn: request.turn, finishReason: 'stop' }
    },
  }
}

function testSettings(toolCalls = false): AppSettings {
  const settings = createDefaultSettings()
  return {
    ...settings,
    skills: { enableSkills: false, skills: {} },
    tools: {
      ...settings.tools,
      enableToolCalls: toolCalls,
      tools: {},
    },
  }
}

function testToolSettings(enableToolCalls = false): ToolSettings {
  return {
    enableToolCalls,
    tools: {},
  }
}

function testSkill(): SkillDefinition {
  return {
    id: 'repo-skill',
    name: 'repo-skill',
    description: 'Repo workflow',
    instructions: 'Inspect the repo first.',
    source: 'user',
    path: '/skills/repo-skill/SKILL.md',
    directoryPath: '/skills/repo-skill',
    enabled: true,
  }
}

function enableToolsForContext(context: StreamContext): void {
  context.settings = testSettings(true)
  context.toolSettings = testToolSettings(true)
}

function messageContents(turnIndex: number) {
  return mocks.seenMessages[turnIndex].map(message => message.content)
}

function testProviderConfig(overrides: Partial<StreamProviderConfig> = {}): StreamProviderConfig {
  return {
    model: 'vision-model',
    selectedModels: ['vision-model'],
    apiKey: 'key',
    ...overrides,
  }
}

function testSender(): StreamSender {
  return { isDestroyed: () => false, send: vi.fn() }
}

function testEmitter(): IPCEmitter {
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
  }
}

const mocks = vi.hoisted(() => ({
  seenMessages: [] as AgentMessage[][],
  seenRequests: [] as SeenRequest[],
  promptInputs: [] as BuildPromptOptions[],
  visionProvider: createVisionProvider(),
  addMessage: vi.fn(),
  emit: vi.fn(async () => undefined),
  getSession: vi.fn(() => ({
    id: 's1',
    name: 'Session',
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    workingDirectory: '/tmp/project',
  })),
  getSkillsForSession: vi.fn<() => SkillDefinition[]>(() => []),
  getMCPRouterToolDefinition: vi.fn<() => ToolDefinition | null>(() => null),
  getMCPToolDefinitionsForModel: vi.fn<() => ToolDefinition[]>(() => []),
  getModelContextLength: vi.fn(async () => 128000),
  getModelMaxOutputTokens: vi.fn(async () => 8192),
  getEnabledToolsAsync: vi.fn<() => Promise<ToolDefinition[]>>(async () => []),
  initializeAsyncTools: vi.fn(async () => undefined),
  setInitContext: vi.fn(),
  buildProjectDirsPromptVars: vi.fn(() => ({ active: undefined, known: [] })),
  getContextCompactReason: vi.fn(() => null),
}))

vi.mock('../../../store.js', () => ({
  getSession: mocks.getSession,
  addMessage: mocks.addMessage,
}))

vi.mock('../../../mcp/index.js', () => ({
  getMCPRouterToolDefinition: mocks.getMCPRouterToolDefinition,
  getMCPToolDefinitionsForModel: mocks.getMCPToolDefinitionsForModel,
}))

vi.mock('../../../providers/model-registry.js', () => ({
  getModelContextLength: mocks.getModelContextLength,
  getModelMaxOutputTokens: mocks.getModelMaxOutputTokens,
  getModelCapabilityEntry: vi.fn(() => undefined),
}))

vi.mock('../../../tools/index.js', () => ({
  getEnabledToolsAsync: mocks.getEnabledToolsAsync,
  initializeAsyncTools: mocks.initializeAsyncTools,
  setInitContext: mocks.setInitContext,
}))

vi.mock('../../prompt/index.js', () => ({
  buildPrompt: vi.fn(async (input) => {
    mocks.promptInputs.push(input)
    return {
      systemPrompt: 'system prompt',
      messages: [
        { role: 'system', content: 'system prompt' },
        ...input.historyMessages,
      ],
    }
  }),
}))

vi.mock('../../../variables/index.js', () => ({
}))

vi.mock('../../../project-dirs/index.js', () => ({
  buildProjectDirsPromptVars: mocks.buildProjectDirsPromptVars,
}))

vi.mock('../../../providers/agent-runtime.js', () => {
  const createAgentProviderFromRuntime = vi.fn(
    (_providerId?: string, _config?: unknown) => mocks.visionProvider,
  )
  return {
    createAgentProviderFromRuntime,
    isACPProviderRuntime: vi.fn((providerId: string) => providerId === 'acp'),
    isDeepSeekProviderRuntime: vi.fn((providerId: string) => providerId === 'deepseek'),
    // Mirrors the real implementation: acp/deepseek short-circuit, otherwise
    // route to the (mocked) agent provider factory.
    resolveProviderRuntimeRoute: vi.fn((providerId: string, config: unknown) => {
      if (providerId === 'acp') return { kind: 'acp' }
      if (providerId === 'deepseek') return { kind: 'deepseek' }
      const provider = createAgentProviderFromRuntime(providerId, config)
      return provider ? { kind: 'agent', provider } : { kind: 'unsupported' }
    }),
  }
})

vi.mock('../../context-compact.js', () => ({
  compactSessionContext: vi.fn(),
  getContextCompactReason: mocks.getContextCompactReason,
}))

vi.mock('../../../events/index.js', () => ({
  getEventBus: () => ({ emit: mocks.emit }),
}))

vi.mock('@onething/runtime/prompts/resolver.wiring', () => ({
  resolvePromptReferences: vi.fn((content: string) => ({
    modelContent: content,
    displayContent: content,
    contentParts: undefined,
  })),
}))

const { buildAgentLoopRuntimeFromStreamContext } = await import('../agent-loop-runtime.js')
const { createAgentProviderFromRuntime } = await import('../../../providers/agent-runtime.js')

function ctx(): StreamContext {
  return {
    sessionId: 's1',
    assistantMessageId: 'm1',
    abortSignal: new AbortController().signal,
    settings: testSettings(false),
    providerConfig: testProviderConfig(),
    providerId: 'deepseek',
    toolSettings: testToolSettings(false),
    sender: testSender(),
  }
}

describe('agent loop stream runtime multimodal input', () => {
  beforeEach(() => {
    mocks.seenMessages.length = 0
    mocks.seenRequests.length = 0
    mocks.promptInputs.length = 0
    vi.clearAllMocks()
  })

  it('preserves image content parts from history for capable providers', async () => {
    const imageContent = [
      { type: 'text' as const, text: 'look' },
      { type: 'image' as const, image: 'data:image/png;base64,abc', mediaType: 'image/png' },
    ]
    const prepared = await buildAgentLoopRuntimeFromStreamContext(ctx(), [
      { role: 'user', content: imageContent },
    ] satisfies HistoryMessage[])

    expect(prepared.supported).toBe(true)
    if (!prepared.supported) return

    const result = await runAgentLoop(prepared.runtime)
    expect(result.text).toBe('vision ok')
    expect(mocks.seenMessages[0][1].content).toEqual(imageContent)
  })

  it('passes requested output modalities from stream context into provider turns', async () => {
    const context = ctx()
    context.requestedOutputModalities = ['image']

    const prepared = await buildAgentLoopRuntimeFromStreamContext(context, [
      { role: 'user', content: 'draw this' },
    ] satisfies HistoryMessage[])

    expect(prepared.supported).toBe(true)
    if (!prepared.supported) return

    await runAgentLoop(prepared.runtime)

    expect(mocks.seenRequests[0].requestedOutputModalities).toEqual(['image'])
  })

  it('passes DeepSeek native-thinking disabled from provider model settings into provider turns', async () => {
    const context = ctx()
    context.providerConfig = testProviderConfig({
      model: 'deepseek-v4-pro',
      selectedModels: ['deepseek-v4-pro'],
      thinkingByModel: { 'deepseek-v4-pro': false },
      thinkingEffortByModel: { 'deepseek-v4-pro': 'max' },
    })

    const prepared = await buildAgentLoopRuntimeFromStreamContext(context, [
      { role: 'user', content: 'no thinking' },
    ] satisfies HistoryMessage[])

    expect(prepared.supported).toBe(true)
    if (!prepared.supported) return

    await runAgentLoop(prepared.runtime)

    expect(mocks.seenRequests[0]).toMatchObject({
      thinking: 'disabled',
      reasoningEffort: undefined,
    })
  })

  it('passes provider auth context into the agent provider runtime factory', async () => {
    const context = ctx()
    const oauthToken = {
      accessToken: 'oauth-access-token',
      expiresAt: Date.now() + 60_000,
      tokenType: 'Bearer',
      accountId: 'acct_123',
    }
    context.providerId = 'codex'
    context.providerConfig = testProviderConfig({
      model: 'gpt-5.5',
      selectedModels: ['gpt-5.5'],
      apiKey: 'api-key',
      oauthToken,
      authContext: {
        kind: 'oauth',
        token: oauthToken,
        account: { email: 'dev@example.test' },
      },
    })

    const prepared = await buildAgentLoopRuntimeFromStreamContext(context, [
      { role: 'user', content: 'hello' },
    ] satisfies HistoryMessage[])

    expect(prepared.supported).toBe(true)
    expect(createAgentProviderFromRuntime).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({
        apiKey: 'api-key',
        model: 'gpt-5.5',
        oauthToken,
        authContext: expect.objectContaining({
          kind: 'oauth',
          token: oauthToken,
        }),
      }),
      expect.objectContaining({
        workingDirectory: '/tmp/project',
        localSessionId: 's1',
      }),
    )
  })

  it('uses provider-declared token limits for context budgeting before registry fallback', async () => {
    const originalCapabilities = mocks.visionProvider.capabilities
    ;mocks.visionProvider.capabilities = {
      ...originalCapabilities,
      maxInputTokens: 32000,
      maxOutputTokens: 2000,
    }

    try {
      const prepared = await buildAgentLoopRuntimeFromStreamContext(ctx(), [
        { role: 'user', content: 'hello' },
      ] satisfies HistoryMessage[])

      expect(prepared.supported).toBe(true)
      if (!prepared.supported) return

      expect(prepared.modelContextLength).toBe(32000)
      expect(prepared.reservedOutputTokens).toBe(1000)
      expect(prepared.runtime.maxTokens).toBe(1000)
      expect(mocks.getModelContextLength).not.toHaveBeenCalled()
      expect(mocks.getModelMaxOutputTokens).not.toHaveBeenCalled()
    } finally {
      ;mocks.visionProvider.capabilities = originalCapabilities
    }
  })

  it('rejects agent provider runtimes that do not implement a turn execution interface', async () => {
    vi.mocked(createAgentProviderFromRuntime).mockReturnValueOnce({ id: 'incomplete-provider' })

    const prepared = await buildAgentLoopRuntimeFromStreamContext(ctx(), [
      { role: 'user', content: 'hello' },
    ] satisfies HistoryMessage[])

    expect(prepared).toMatchObject({
      supported: false,
      reason: 'Provider deepseek AgentProvider runtime does not implement streamTurn or runTurn',
    })
  })
  it('does not load or inject skills when skill settings are disabled', async () => {
    mocks.getSkillsForSession.mockReturnValueOnce([testSkill()])

    const prepared = await buildAgentLoopRuntimeFromStreamContext(ctx(), [
      { role: 'user', content: 'hello' },
    ] satisfies HistoryMessage[])

    expect(prepared.supported).toBe(true)
    if (!prepared.supported) return

    expect(mocks.getSkillsForSession).not.toHaveBeenCalled()
    expect(prepared.enabledSkills).toEqual([])
    expect(prepared.runtime.skills).toEqual([])
    expect(mocks.promptInputs[0].skills).toEqual([])

    await runAgentLoop(prepared.runtime)

    expect(messageContents(0)).toEqual(['system prompt', 'hello'])
  })

  it('does not load tools when provider capabilities do not advertise tool calls', async () => {
    const context = ctx()
    enableToolsForContext(context)

    const prepared = await buildAgentLoopRuntimeFromStreamContext(context, [
      { role: 'user', content: 'hello' },
    ] satisfies HistoryMessage[])

    expect(prepared.supported).toBe(true)
    if (!prepared.supported) return

    expect(prepared.hasTools).toBe(false)
    expect(prepared.toolNames).toEqual([])
    expect(mocks.promptInputs[0]).toMatchObject({
      hasTools: false,
      toolNames: [],
      mcpToolNames: [],
    })
    expect(mocks.getEnabledToolsAsync).not.toHaveBeenCalled()
    expect(mocks.getMCPRouterToolDefinition).not.toHaveBeenCalled()
    await runAgentLoop(prepared.runtime)

    expect(mocks.seenRequests[0]).toMatchObject({
      toolChoice: 'none',
      tools: [],
    })
  })

  it('includes MCP router tools in the agent-loop runtime when tools are enabled', async () => {
    const originalCapabilities = mocks.visionProvider.capabilities
    ;mocks.visionProvider.capabilities = {
      ...originalCapabilities,
      capabilities: [...originalCapabilities.capabilities, 'tool-calls'],
      supportsTools: true,
    }
    mocks.getEnabledToolsAsync.mockResolvedValueOnce([])
    mocks.getMCPToolDefinitionsForModel.mockReturnValueOnce([{
      id: 'mcp_search',
      name: 'MCP Search',
      description: 'Search and call MCP tools',
      category: 'custom',
      source: 'mcp',
      enabled: true,
      autoExecute: false,
      parameters: [{
        name: 'action',
        type: 'string',
        description: 'MCP action',
        required: true,
      }],
      parameterSchema: {
        type: 'object',
        properties: {
          action: { type: 'string' },
        },
        required: ['action'],
      },
    }])

    try {
      const context = ctx()
      enableToolsForContext(context)

      const prepared = await buildAgentLoopRuntimeFromStreamContext(context, [
        { role: 'user', content: 'hello' },
      ] satisfies HistoryMessage[])

      expect(prepared.supported).toBe(true)
      if (!prepared.supported) return

      expect(prepared.hasTools).toBe(true)
      expect(prepared.toolNames).toEqual([])
      expect(prepared.mcpToolNames).toEqual(['mcp_search'])
      expect(mocks.promptInputs[0]).toMatchObject({
        hasTools: true,
        toolNames: [],
        mcpToolNames: ['mcp_search'],
      })

      await runAgentLoop(prepared.runtime)

      expect(mocks.seenRequests[0]).toMatchObject({
        toolChoice: 'auto',
        tools: ['mcp_search'],
      })
    } finally {
      ;mocks.visionProvider.capabilities = originalCapabilities
    }
  })

  it('injects queued steering messages before the next provider turn', async () => {
    const steeringQueue = new PendingMessageQueue('one-at-a-time')
    steeringQueue.enqueue({ content: 'steer now', source: 'test', timestamp: 123 })
    const context = ctx()
    context.steeringQueue = steeringQueue

    const prepared = await buildAgentLoopRuntimeFromStreamContext(context, [
      { role: 'user', content: 'hello' },
    ] satisfies HistoryMessage[])

    expect(prepared.supported).toBe(true)
    if (!prepared.supported) return

    await runAgentLoop(prepared.runtime)

    expect(messageContents(0)).toEqual([
      'system prompt',
      'hello',
      'steer now',
    ])
    expect(mocks.addMessage).toHaveBeenCalledWith('s1', expect.objectContaining({
      role: 'user',
      content: 'steer now',
      timestamp: 123,
    }))
    expect(mocks.emit).toHaveBeenCalledWith('s1', expect.objectContaining({
      type: 'message:user-created',
      message: expect.objectContaining({ content: 'steer now' }),
    }))
  })

  it('continues with queued follow-up messages after a natural stop', async () => {
    const followUpQueue = new PendingMessageQueue('all')
    followUpQueue.enqueue({ content: 'follow up', source: 'test', timestamp: 456 })
    const context = ctx()
    context.followUpQueue = followUpQueue

    const prepared = await buildAgentLoopRuntimeFromStreamContext(context, [
      { role: 'user', content: 'hello' },
    ] satisfies HistoryMessage[])

    expect(prepared.supported).toBe(true)
    if (!prepared.supported) return

    const result = await runAgentLoop(prepared.runtime)

    expect(result.turns).toBe(2)
    expect(messageContents(1)).toEqual([
      'system prompt',
      'hello',
      'vision ok',
      'follow up',
    ])
    expect(mocks.addMessage).toHaveBeenCalledWith('s1', expect.objectContaining({
      role: 'user',
      content: 'follow up',
      timestamp: 456,
    }))
  })

  it('prioritizes queued steering over follow-up after a natural stop', async () => {
    const steeringQueue = new PendingMessageQueue('one-at-a-time')
    const followUpQueue = new PendingMessageQueue('all')
    followUpQueue.enqueue({ content: 'follow up', source: 'test', timestamp: 456 })

    const originalStreamTurn = mocks.visionProvider.streamTurn
    mocks.visionProvider.streamTurn = async function* streamTurn(request: AgentTurnRequest) {
      mocks.seenMessages.push(request.messages.map((message: AgentMessage) => ({ ...message })))
      if (request.turn === 1) {
        steeringQueue.enqueue({ content: 'late steering', source: 'test', timestamp: 789 })
      }
      yield { type: 'text-delta', turn: request.turn, delta: `turn ${request.turn}` }
      yield { type: 'finish', turn: request.turn, finishReason: 'stop' }
    }

    try {
      const context = ctx()
      context.steeringQueue = steeringQueue
      context.followUpQueue = followUpQueue

      const prepared = await buildAgentLoopRuntimeFromStreamContext(context, [
        { role: 'user', content: 'hello' },
      ] satisfies HistoryMessage[])

      expect(prepared.supported).toBe(true)
      if (!prepared.supported) return

      const result = await runAgentLoop(prepared.runtime)

      expect(result.turns).toBe(3)
      expect(messageContents(1)).toEqual([
        'system prompt',
        'hello',
        'turn 1',
        'late steering',
      ])
      expect(messageContents(2)).toEqual([
        'system prompt',
        'hello',
        'turn 1',
        'late steering',
        'turn 2',
        'follow up',
      ])
      expect(mocks.addMessage).toHaveBeenNthCalledWith(1, 's1', expect.objectContaining({
        role: 'user',
        content: 'late steering',
        timestamp: 789,
      }))
      expect(mocks.addMessage).toHaveBeenNthCalledWith(2, 's1', expect.objectContaining({
        role: 'user',
        content: 'follow up',
        timestamp: 456,
      }))
    } finally {
      mocks.visionProvider.streamTurn = originalStreamTurn
    }
  })
})
