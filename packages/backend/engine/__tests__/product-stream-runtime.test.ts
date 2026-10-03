import { describe, expect, it, vi } from 'vitest'
import {
  createOnethingProductStreamRuntime,
  createOnethingProductStreamRuntimeFromHostAdapters,
} from '../product-stream-runtime.js'

describe('createOnethingProductStreamRuntime', () => {
  it('assembles the onething product runtime provider adapter in runtime', async () => {
    const session = {
      id: 'session-1',
      name: 'Session',
      messages: [],
      lastProvider: 'openai',
      lastModel: 'gpt-4.1',
    }
    const settings = {
      ai: {
        provider: 'deepseek',
        providers: {
          openai: {
            model: 'gpt-4.1',
            apiKey: 'provider-key',
          },
          deepseek: {
            model: 'deepseek-chat',
          },
        },
      },
    }
    const generateTitle = vi.fn(async () => 'Generated title')

    const runtime = createOnethingProductStreamRuntime({
      store: {
        getSettings: () => settings,
        getSession: () => session,
        listMessages: () => session.messages,
        getMessage: (_id: string, messageId: string) =>
          session.messages.find((message: { id: string }) => message.id === messageId),
        addMessage: vi.fn(),
        renameSession: vi.fn(),
        updateMessageAndTruncate: vi.fn(() => true),
        deleteMessageAndTruncate: vi.fn(() => true),
        deleteMessage: vi.fn(() => true),
      },
      permission: {
        clearSession: vi.fn(),
      },
      skills: {
        getForSession: () => [],
      },
      prompts: {
        resolveReferences: content => ({
          modelContent: content,
          displayContent: content,
        }),
      },
      media: {
        ingestMessageAttachments: vi.fn(),
      },
      provider: {
        getSession: () => session,
        isProviderSupported: providerId => providerId === 'openai',
        isOAuthProvider: () => false,
        resolveApiKey: (_providerId, providerConfig) =>
          (providerConfig as { apiKey?: string } | undefined)?.apiKey,
        resolveOAuthAuth: async () => null,
        createApiKeyAuth: apiKey => ({ kind: 'api-key', apiKey }),
        generateTitle,
      },
      models: {
        getModelContextLength: async () => 128_000,
      },
      history: {
        buildMessages: messages => messages,
        buildResumeAfterToolConfirmation: messages => messages,
      },
      streams: {
        executeMessageStream: vi.fn(async () => undefined),
        executeAgentLoopStreamGeneration: vi.fn(async () => ({ text: 'ok' })),
      },
      compaction: {
        compactSessionContext: vi.fn(async () => ({ success: true })),
        getContextCompactReason: () => null,
        shouldSkipAutoCompactForProviderUsageMismatch: () => false,
      },
    })

    expect(runtime.provider.isSupported('openai')).toBe(true)
    expect(runtime.provider.getEffectiveConfig(settings, 'session-1')).toMatchObject({
      providerId: 'openai',
      model: 'gpt-4.1',
    })
    await expect(runtime.provider.resolveAuth('openai', settings.ai.providers.openai)).resolves.toEqual({
      kind: 'api-key',
      apiKey: 'provider-key',
    })
    await expect(runtime.provider.generateTitle('openai', settings.ai.providers.openai, 'hello')).resolves.toBe('Generated title')
    expect(generateTitle).toHaveBeenCalledWith('openai', settings.ai.providers.openai, 'hello', undefined)
  })

  it('assembles product runtime adapter groups from host functions', () => {
    const session = {
      id: 'session-1',
      name: 'Session',
      messages: [{ id: 'message-1', role: 'user', content: 'hello' }],
      lastProvider: 'openai',
      lastModel: 'gpt-4.1',
    }
    const clearPermissionSession = vi.fn()
    const getSkillsForSession = vi.fn(() => [{ id: 'skill-1' }])
    const resolvePromptReferences = vi.fn(content => ({
      modelContent: content,
      displayContent: content,
    }))
    const ingestMessageAttachments = vi.fn()
    const buildHistoryMessages = vi.fn(messages => messages)
    const buildResumeHistoryAfterToolConfirmation = vi.fn(messages => messages)
    const executeMessageStream = vi.fn(async () => undefined)
    const executeAgentLoopStreamGeneration = vi.fn(async () => ({ text: 'ok' }))
    const compactSessionContext = vi.fn(async () => ({ success: true }))

    const runtime = createOnethingProductStreamRuntimeFromHostAdapters({
      store: {
        getSettings: () => ({ ai: { provider: 'openai', providers: {} } }),
        getSession: () => session,
        listMessages: () => session.messages,
        getMessage: (_id: string, messageId: string) =>
          session.messages.find((message: { id: string }) => message.id === messageId),
        addMessage: vi.fn(),
        renameSession: vi.fn(),
        updateMessageAndTruncate: vi.fn(() => true),
        deleteMessageAndTruncate: vi.fn(() => true),
        deleteMessage: vi.fn(() => true),
      },
      clearPermissionSession,
      getSkillsForSession,
      resolvePromptReferences,
      ingestMessageAttachments,
      provider: {
        getSession: () => session,
        isProviderSupported: providerId => providerId === 'openai',
        isOAuthProvider: () => false,
        resolveApiKey: () => undefined,
        resolveOAuthAuth: async () => null,
        generateTitle: async () => 'Generated title',
      },
      models: {
        getModelContextLength: async () => 128_000,
      },
      buildHistoryMessages,
      buildResumeHistoryAfterToolConfirmation,
      executeMessageStream,
      executeAgentLoopStreamGeneration,
      compactSessionContext,
      getContextCompactReason: () => null,
      shouldSkipAutoCompactForProviderUsageMismatch: () => false,
    })

    runtime.permission.clearSession('session-1')
    expect(clearPermissionSession).toHaveBeenCalledWith('session-1')
    expect(runtime.skills.getForSession('/repo')).toEqual([{ id: 'skill-1' }])
    expect(getSkillsForSession).toHaveBeenCalledWith('/repo')
    expect(runtime.prompts.resolveReferences('hello', { skills: [] })).toMatchObject({
      modelContent: 'hello',
      displayContent: 'hello',
    })
    runtime.media.ingestMessageAttachments('session-1', 'message-1', 'user', [])
    expect(ingestMessageAttachments).toHaveBeenCalledWith('session-1', 'message-1', 'user', [])
    expect(runtime.history.buildMessages(session.messages, session)).toEqual(session.messages)
  })
})
