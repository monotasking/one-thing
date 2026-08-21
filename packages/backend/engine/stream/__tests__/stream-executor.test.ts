import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultSettings } from '@shared/defaults/settings.js'
import type { ToolSettings } from '@shared/ipc.js'
import type { StreamSender } from '../stream-processor.js'
import type { ProviderConfigWithKey, StreamExecutionParams } from '../stream-executor.js'

const mocks = vi.hoisted(() => ({
  engine: {
    registerController: vi.fn(),
    removeController: vi.fn(),
    getSteeringQueue: vi.fn(() => ({ kind: 'steering-queue' })),
    getFollowUpQueue: vi.fn(() => ({ kind: 'follow-up-queue' })),
  },
  modelSupportsImageGeneration: vi.fn(async () => false),
  modelSupportsTools: vi.fn(async () => true),
  getModelById: vi.fn(async () => undefined),
  processImageGenerationStream: vi.fn(async () => true),
  executeAgentLoopStreamGeneration: vi.fn(async () => ({ pausedForConfirmation: false })),
}))

vi.mock('../../../providers/model-registry.js', () => ({
  modelSupportsImageGeneration: mocks.modelSupportsImageGeneration,
  modelSupportsTools: mocks.modelSupportsTools,
  getModelById: mocks.getModelById,
}))

vi.mock('../image-stream.js', () => ({
  processImageGenerationStream: mocks.processImageGenerationStream,
}))

vi.mock('../agent-loop-executor.js', () => ({
  executeAgentLoopStreamGeneration: mocks.executeAgentLoopStreamGeneration,
}))

vi.mock('../../index.js', () => ({
  getStreamEngine: () => mocks.engine,
}))

const { executeMessageStream } = await import('../stream-executor.js')

const sender: StreamSender = {
  isDestroyed: () => false,
  send: vi.fn(),
}

const configWithApiKey: ProviderConfigWithKey = {
  apiKey: 'key',
  model: 'deepseek-v4-flash',
  selectedModels: ['deepseek-v4-flash'],
}

const toolSettings: ToolSettings = {
  enableToolCalls: true,
  tools: {},
}

function params(overrides: Partial<StreamExecutionParams> = {}): StreamExecutionParams {
  return {
    sender,
    sessionId: 's1',
    assistantMessageId: 'm1',
    messageContent: 'hello',
    historyMessages: [{ role: 'user', content: 'hello' }],
    configWithApiKey,
    providerId: 'deepseek',
    settings: createDefaultSettings(),
    toolSettings,
    sessionName: 'Session',
    ...overrides,
  }
}

describe('stream executor agent-loop routing', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('routes text streams through agent-loop', async () => {
    const abortController = new AbortController()

    const result = await executeMessageStream(params({
      requestedOutputModalities: ['image'],
    }), abortController)

    expect(result).toEqual({
      handled: true,
      isImageGeneration: false,
      pausedForConfirmation: false,
    })
    expect(mocks.engine.registerController).toHaveBeenCalledWith('s1', abortController)
    expect(mocks.executeAgentLoopStreamGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
        assistantMessageId: 'm1',
        providerId: 'deepseek',
        requestedOutputModalities: ['image'],
        steeringQueue: { kind: 'steering-queue' },
        followUpQueue: { kind: 'follow-up-queue' },
      }),
      [{ role: 'user', content: 'hello' }],
      'Session',
    )
    expect(mocks.engine.removeController).toHaveBeenCalledWith('s1')
  })

  it('keeps the controller registered when agent-loop pauses for confirmation', async () => {
    mocks.executeAgentLoopStreamGeneration.mockResolvedValueOnce({ pausedForConfirmation: true })

    const result = await executeMessageStream(params())

    expect(result.pausedForConfirmation).toBe(true)
    expect(mocks.executeAgentLoopStreamGeneration).toHaveBeenCalled()
    expect(mocks.engine.removeController).not.toHaveBeenCalled()
  })

  it('ignores the legacy agent-loop opt-out setting for text streams', async () => {
    const settings = createDefaultSettings()
    settings.chat!.agentLoopStream = false

    const result = await executeMessageStream(params({
      providerId: 'openai',
      settings,
    }))

    expect(result.pausedForConfirmation).toBe(false)
    expect(mocks.executeAgentLoopStreamGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'openai',
        settings: expect.objectContaining({
          chat: expect.objectContaining({ agentLoopStream: false }),
        }),
      }),
      [{ role: 'user', content: 'hello' }],
      'Session',
    )
    expect(mocks.engine.removeController).toHaveBeenCalledWith('s1')
  })

  it('keeps image generation on the dedicated image path', async () => {
    mocks.modelSupportsImageGeneration.mockResolvedValueOnce(true)

    const result = await executeMessageStream(params({ messageContent: 'draw moon' }))

    expect(result).toEqual({
      handled: true,
      isImageGeneration: true,
      pausedForConfirmation: false,
    })
    expect(mocks.processImageGenerationStream).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'draw moon',
      providerId: 'deepseek',
      model: 'deepseek-v4-flash',
    }))
    expect(mocks.executeAgentLoopStreamGeneration).not.toHaveBeenCalled()
    expect(mocks.engine.removeController).toHaveBeenCalledWith('s1')
  })

  it('requests image output for codex oauth so the native image_generation tool attaches', async () => {
    await executeMessageStream(params({
      providerId: 'codex',
      configWithApiKey: {
        ...configWithApiKey,
        model: 'gpt-5.5',
        authContext: { kind: 'oauth' } as ProviderConfigWithKey['authContext'],
      },
    }))

    expect(mocks.executeAgentLoopStreamGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'codex',
        requestedOutputModalities: ['image'],
      }),
      [{ role: 'user', content: 'hello' }],
      'Session',
    )
  })

  it('does not request image output for codex without oauth', async () => {
    await executeMessageStream(params({
      providerId: 'codex',
      configWithApiKey: { ...configWithApiKey, model: 'gpt-5.5' },
    }))

    expect(mocks.executeAgentLoopStreamGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedOutputModalities: undefined,
      }),
      [{ role: 'user', content: 'hello' }],
      'Session',
    )
  })

  it('does not request image output for non-codex providers', async () => {
    await executeMessageStream(params())

    expect(mocks.executeAgentLoopStreamGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedOutputModalities: undefined,
      }),
      [{ role: 'user', content: 'hello' }],
      'Session',
    )
  })
})
