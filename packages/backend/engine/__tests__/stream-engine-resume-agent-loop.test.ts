import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ChatSession, ToolDefinition } from '@shared/ipc.js'
import type { ResumeAfterConfirmCommand } from '@shared/events/session-commands.js'
import { EventBus } from '../../events/event-bus.js'

import type { BindableStreamSender, StreamSender } from '../stream-engine.js'

type SenderMock = Pick<BindableStreamSender, 'isDestroyed' | 'send' | 'on'>

const mocks = vi.hoisted(() => ({
  eventBus: {
    emit: vi.fn(async () => undefined),
    onAnySession: vi.fn(() => vi.fn()),
  },
  sender: {
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
    on: vi.fn(),
  },
  getSettings: vi.fn(() => ({
    ai: {
      provider: 'deepseek',
      providers: {
        deepseek: { model: 'deepseek-v4-flash', selectedModels: ['deepseek-v4-flash'] },
      },
    },
    tools: { enableToolCalls: true, tools: {} },
    skills: { enableSkills: true },
    chat: {},
  })),
  getSession: vi.fn(),
  addMessage: vi.fn(),
  deleteMessage: vi.fn(),
  getEffectiveProviderConfig: vi.fn(() => ({
    providerId: 'deepseek',
    providerConfig: { model: 'deepseek-v4-flash', selectedModels: ['deepseek-v4-flash'] },
    model: 'deepseek-v4-flash',
  })),
  resolveProviderAuth: vi.fn(async () => ({ kind: 'api-key', apiKey: 'key' })),
  getSkillsForSession: vi.fn(() => []),
  getEnabledToolsAsync: vi.fn(async () => []),
  initializeAsyncTools: vi.fn(async () => undefined),
  setInitContext: vi.fn(),
  getMCPToolsForAI: vi.fn(() => ({})),
  getMCPRouterToolDefinition: vi.fn<() => ToolDefinition | null>(() => null),
  modelSupportsTools: vi.fn(async () => true),
  buildProjectDirsPromptVars: vi.fn(() => ({ active: undefined, known: [] })),
  buildPrompt: vi.fn(async () => ({ systemPrompt: 'system', messages: [] })),
  executeAgentLoopStreamGeneration: vi.fn(async () => ({ pausedForConfirmation: false })),
}))

vi.mock('../../store.js', () => ({
  getSettings: mocks.getSettings,
  getSession: mocks.getSession,
  addMessage: mocks.addMessage,
  deleteMessage: mocks.deleteMessage,
}))

// 引擎的消息读走读门面(P0.2 C1):这份 mock 与上面的 store mock 是同一个假会话。
vi.mock('../../session/reads.js', () => ({
  sessionReads: {
    listMessages: (sessionId: string) => ({
      messages: mocks.getSession(sessionId)?.messages ?? [],
      changed: false,
    }),
    getMessage: (sessionId: string, messageId: string) =>
      mocks.getSession(sessionId)?.messages?.find(
        (message: { id: string }) => message.id === messageId,
      ),
  },
}))

vi.mock('../stream/provider-helpers.js', () => ({
  getEffectiveProviderConfig: mocks.getEffectiveProviderConfig,
  resolveProviderAuth: mocks.resolveProviderAuth,
  extractErrorDetails: vi.fn((error: { message?: string }) => error.message),
  getProviderApiType: vi.fn(() => 'chat'),
}))

vi.mock('../../wiring/providers/index.js', () => ({
  isProviderSupported: vi.fn(() => true),
  requiresOAuth: vi.fn(() => false),
  convertToolDefinitionsForProvider: vi.fn(() => ({})),
  generateChatTitle: vi.fn(async () => 'Generated title'),
}))

vi.mock('../stream/stream-executor.js', () => ({
  executeMessageStream: vi.fn(),
}))

vi.mock('../stream/agent-loop-executor.js', () => ({
  executeAgentLoopStreamGeneration: mocks.executeAgentLoopStreamGeneration,
}))

vi.mock('../stream-engine-runtime.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../stream-engine-runtime.js')>()
  return {
    ...actual,
    createMainStreamEngineRuntime: () => {
      const runtime = actual.createMainStreamEngineRuntime()
      return {
        ...runtime,
        provider: {
          ...runtime.provider,
          getEffectiveConfig: mocks.getEffectiveProviderConfig,
          resolveAuth: mocks.resolveProviderAuth,
          isSupported: () => true,
          requiresOAuth: () => false,
        },
        streams: {
          ...runtime.streams,
          executeAgentLoopStreamGeneration: mocks.executeAgentLoopStreamGeneration,
        },
      }
    },
  }
})

vi.mock('../prompt/index.js', () => ({
  buildPrompt: mocks.buildPrompt,
}))

vi.mock('../../wiring/skills/session-skills.js', () => ({
  getSkillsForSession: mocks.getSkillsForSession,
}))

vi.mock('../../wiring/tools/index.js', () => ({
  getEnabledToolsAsync: mocks.getEnabledToolsAsync,
  initializeAsyncTools: mocks.initializeAsyncTools,
  setInitContext: mocks.setInitContext,
}))

vi.mock('@onething/runtime/mcp/index.wiring', () => ({
  getMCPToolsForAI: mocks.getMCPToolsForAI,
  getMCPRouterToolDefinition: mocks.getMCPRouterToolDefinition,
}))

vi.mock('../../wiring/providers/model-registry.js', () => ({
  modelSupportsTools: mocks.modelSupportsTools,
}))

vi.mock('../../wiring/variables/index.js', () => ({
}))

vi.mock('../../wiring/project-dirs/index.js', () => ({
  buildProjectDirsPromptVars: mocks.buildProjectDirsPromptVars,
}))

vi.mock('@onething/runtime/media/library-service-bound', () => ({
  mediaLibraryService: {
    ingestMessageAttachments: vi.fn(),
  },
}))

vi.mock('../context-compact.js', () => ({
  compactSessionContext: vi.fn(),
  getContextCompactReason: vi.fn(() => null),
}))

vi.mock('@onething/runtime/prompts/resolver.wiring', () => ({
  resolvePromptReferences: vi.fn((content: string) => ({
    modelContent: content,
    displayContent: content,
    contentParts: undefined,
  })),
}))

const { StreamEngine } = await import('../stream-engine.js')

function sender(): StreamSender {
  return mocks.sender as SenderMock as unknown as StreamSender
}

function resumeCommand(messageId = 'm1'): ResumeAfterConfirmCommand {
  return { type: 'command:resume-after-confirm', messageId }
}

function session(): ChatSession {
  return {
    id: 's1',
    name: 'Resume Session',
    createdAt: 1,
    updatedAt: 2,
    workingDirectory: '/tmp/project',
    messages: [
      {
        id: 'u1',
        role: 'user',
        content: 'delete tmp',
        timestamp: 1,
      },
      {
        id: 'm1',
        role: 'assistant',
        content: 'I need approval.',
        reasoning: 'The command is destructive.',
        timestamp: 2,
        isStreaming: true,
        toolCalls: [{
          id: 'call_1',
          toolId: 'bash',
          toolName: 'Bash',
          arguments: { cmd: 'rm -rf tmp' },
          status: 'completed',
          result: { output: 'removed' },
          timestamp: 2,
        }],
      },
    ],
  }
}

describe('StreamEngine resume-after-confirm agent-loop path', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('resumes through agent-loop with reconstructed assistant/tool history', async () => {
    mocks.getSession.mockReturnValue(session())
    const engine = new StreamEngine()
    engine.setEventBus(new EventBus())

    await engine.handleResumeAfterConfirm(
      's1',
      resumeCommand(),
      sender(),
    )

    expect(mocks.executeAgentLoopStreamGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
        assistantMessageId: 'm1',
        providerId: 'deepseek',
      }),
      [
        { role: 'user', content: 'delete tmp' },
        {
          role: 'assistant',
          content: 'I need approval.',
          reasoningContent: 'The command is destructive.',
          toolCalls: [{
            toolCallId: 'call_1',
            toolName: 'bash',
            args: { cmd: 'rm -rf tmp' },
          }],
        },
        {
          role: 'tool',
          content: [{
            type: 'tool-result',
            toolCallId: 'call_1',
            toolName: 'bash',
            result: { output: 'removed' },
          }],
        },
      ],
      'Resume Session',
      {
        initialContent: {
          content: 'I need approval.',
          reasoning: 'The command is destructive.',
        },
      },
    )
    expect(engine.getController('s1')).toBeUndefined()
  })

  it('keeps the active controller when resumed agent-loop pauses again', async () => {
    mocks.getSession.mockReturnValue(session())
    mocks.executeAgentLoopStreamGeneration.mockResolvedValueOnce({ pausedForConfirmation: true })
    const engine = new StreamEngine()
    engine.setEventBus(new EventBus())

    await engine.handleResumeAfterConfirm(
      's1',
      resumeCommand(),
      sender(),
    )

    expect(mocks.executeAgentLoopStreamGeneration).toHaveBeenCalled()
    expect(engine.getController('s1')).toBeInstanceOf(AbortController)
  })

  it('subscribes to abort commands through the event bus', () => {
    const engine = new StreamEngine()
    const bus = new EventBus()
    const onAnySessionSpy = vi.spyOn(bus, 'onAnySession')
    engine.setEventBus(bus)

    const abortSubscription = onAnySessionSpy.mock.calls.find(([eventType]) => eventType === 'command:abort')
    expect(abortSubscription?.[0]).toBe('command:abort')
    expect(typeof abortSubscription?.[1]).toBe('function')
    expect(abortSubscription?.[2]).toBe('StreamEngine')
  })

  it('persists and emits steering user messages immediately', () => {
    mocks.getSession.mockReturnValue(session())
    const engine = new StreamEngine()
    engine.setEventBus(mocks.eventBus as unknown as EventBus)

    engine.steerMessage('s1', 'steer now', 'user')

    expect(mocks.addMessage).toHaveBeenCalledWith('s1', expect.objectContaining({
      role: 'user',
      content: 'steer now',
      source: 'user',
      steered: true,
    }))
    const addedMessage = mocks.addMessage.mock.calls[0][1] as ChatMessage
    expect(mocks.eventBus.emit).toHaveBeenCalledWith('s1', {
      type: 'message:user-created',
      message: addedMessage,
    })

    const queued = engine.getSteeringQueue('s1').drain()
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({
      content: 'steer now',
      source: 'user',
      timestamp: addedMessage.timestamp,
      id: addedMessage.id,
      modelContent: 'steer now',
      persisted: true,
    })
  })

  it('retracts a pending steering message: dequeues, deletes, and notifies', () => {
    mocks.getSession.mockReturnValue(session())
    mocks.deleteMessage.mockReturnValue(true)
    const engine = new StreamEngine()
    engine.setEventBus(mocks.eventBus as unknown as EventBus)

    engine.steerMessage('s1', 'steer now', 'user')
    const addedMessage = mocks.addMessage.mock.calls[0][1] as ChatMessage
    expect(mocks.eventBus.emit).toHaveBeenCalledWith('s1', {
      type: 'steering:queued',
      messageId: addedMessage.id,
    })

    const retracted = engine.retractSteerMessage('s1', addedMessage.id)

    expect(retracted).toBe(true)
    expect(engine.getSteeringQueue('s1').size).toBe(0)
    expect(mocks.deleteMessage).toHaveBeenCalledWith('s1', addedMessage.id)
    expect(mocks.eventBus.emit).toHaveBeenCalledWith('s1', {
      type: 'message:deleted',
      messageId: addedMessage.id,
    })
    expect(mocks.eventBus.emit).toHaveBeenCalledWith('s1', {
      type: 'steering:retracted',
      messageId: addedMessage.id,
    })
  })

  it('refuses to retract a steering message the loop already consumed', () => {
    mocks.getSession.mockReturnValue(session())
    const engine = new StreamEngine()
    engine.setEventBus(mocks.eventBus as unknown as EventBus)

    engine.steerMessage('s1', 'steer now', 'user')
    const addedMessage = mocks.addMessage.mock.calls[0][1] as ChatMessage
    engine.getSteeringQueue('s1').drain()

    const retracted = engine.retractSteerMessage('s1', addedMessage.id)

    expect(retracted).toBe(false)
    expect(mocks.deleteMessage).not.toHaveBeenCalled()
    expect(mocks.eventBus.emit).not.toHaveBeenCalledWith('s1', expect.objectContaining({
      type: 'message:deleted',
    }))
  })

  it('aborts active streams and clears queued agent messages', () => {
    const engine = new StreamEngine()
    const controller = new AbortController()
    engine.registerController('s1', controller)
    engine.steerMessage('s1', 'stop after this', 'test')
    engine.followUpMessage('s1', 'next thing', 'test')

    expect(engine.getSteeringQueue('s1').size).toBe(1)
    expect(engine.getFollowUpQueue('s1').size).toBe(1)

    const aborted = engine.handleAbort('s1', { type: 'command:abort', reason: 'test stop' })

    expect(aborted).toBe(true)
    expect(controller.signal.aborted).toBe(true)
    expect(engine.getController('s1')).toBeUndefined()
    expect(engine.getSteeringQueue('s1').size).toBe(0)
    expect(engine.getFollowUpQueue('s1').size).toBe(0)
  })
})
