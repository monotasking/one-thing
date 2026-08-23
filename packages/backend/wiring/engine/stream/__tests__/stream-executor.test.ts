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
  modelServesImageOutputInLoop: vi.fn(() => false),
  modelSupportsTools: vi.fn(async () => true),
  getModelById: vi.fn(async () => undefined),
  processImageGenerationStream: vi.fn(async () => true),
  executeAgentLoopStreamGeneration: vi.fn(async () => ({ pausedForConfirmation: false })),
}))

vi.mock('../../../providers/model-registry.js', () => ({
  modelSupportsImageGeneration: mocks.modelSupportsImageGeneration,
  modelServesImageOutputInLoop: mocks.modelServesImageOutputInLoop,
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
    mocks.modelServesImageOutputInLoop.mockReturnValue(false)
    mocks.modelSupportsTools.mockResolvedValue(true)
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

  it('does not request image output for a provider whose ledger says nothing', async () => {
    await executeMessageStream(params())

    expect(mocks.modelServesImageOutputInLoop).toHaveBeenCalledWith('deepseek-v4-flash', 'deepseek')
    expect(mocks.executeAgentLoopStreamGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedOutputModalities: undefined,
      }),
      [{ role: 'user', content: 'hello' }],
      'Session',
    )
  })

  /**
   * 拍板 #13 的引擎闸:codex 之外的家改问账本的 `imageOutputServedBy`。
   * 判据是「图在回合里出」,不是「哪一家」—— openai / openrouter / gemini 的
   * in-loop 模型走的是同一句话。
   */
  it('requests image output for any provider whose ledger serves images in-loop', async () => {
    mocks.modelServesImageOutputInLoop.mockReturnValue(true)

    await executeMessageStream(params({
      providerId: 'openai',
      configWithApiKey: { ...configWithApiKey, model: 'gpt-5.5' },
    }))

    expect(mocks.modelServesImageOutputInLoop).toHaveBeenCalledWith('gpt-5.5', 'openai')
    expect(mocks.executeAgentLoopStreamGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'openai',
        requestedOutputModalities: ['image'],
      }),
      [{ role: 'user', content: 'hello' }],
      'Session',
    )
  })

  it('does not request image output when tool calls are off or the model has no tools', async () => {
    // 原生出图是**工具表里的一项**:工具关了还要图是自相矛盾的。
    mocks.modelServesImageOutputInLoop.mockReturnValue(true)

    await executeMessageStream(params({
      providerId: 'openai',
      configWithApiKey: { ...configWithApiKey, model: 'gpt-5.5' },
      toolSettings: { enableToolCalls: false, tools: {} },
    }))
    expect(mocks.executeAgentLoopStreamGeneration).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestedOutputModalities: undefined }),
      [{ role: 'user', content: 'hello' }],
      'Session',
    )

    mocks.modelSupportsTools.mockResolvedValueOnce(false)
    await executeMessageStream(params({
      providerId: 'openai',
      configWithApiKey: { ...configWithApiKey, model: 'gpt-5.5' },
    }))
    expect(mocks.executeAgentLoopStreamGeneration).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestedOutputModalities: undefined }),
      [{ role: 'user', content: 'hello' }],
      'Session',
    )
  })

  it('never asks the ledger for codex — the native tool table (with OAuth) is the judge there', async () => {
    // codex 的判据含「这次用的是订阅凭据还是 API key」,账本回答不了。命中就
    // 返回,没命中就到此为止 —— 目录条目上的 nativeTools 不能让 API-key 的
    // codex 悄悄拿到图(那是行为变更)。
    mocks.modelServesImageOutputInLoop.mockReturnValue(true)

    await executeMessageStream(params({
      providerId: 'codex',
      configWithApiKey: { ...configWithApiKey, model: 'gpt-5.5' },
    }))

    expect(mocks.modelServesImageOutputInLoop).not.toHaveBeenCalled()
    expect(mocks.executeAgentLoopStreamGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ requestedOutputModalities: undefined }),
      [{ role: 'user', content: 'hello' }],
      'Session',
    )
  })
})
