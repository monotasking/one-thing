import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OAuthToken, OpenRouterModel, ToolSettings } from '@shared/ipc.js'
import { CODEX_NATIVE_IMAGE_GENERATION_TOOL } from '../codex-native-tools.js'
import { resolveProviderNativeTools, type ProviderNativeToolsRequest } from '../../../provider-native-tools.js'

// 原生工具判据住进行为名册的 `nativeTools` 钩子以后(providers 收口第二部分),这份测试从
// `engine/stream/__tests__/codex-native-tools.test.ts` 搬来:引擎从前那只包装把设置里的模型目录服务
// 绑成「取目录条目」,现在这一格由调用方注入,所以这里直接注入计数桩,不再 mock 设置模块。用例与断言照旧。
const mocks = vi.hoisted(() => ({
  getModelById: vi.fn<(modelId: string, providerId?: string) => Promise<OpenRouterModel | undefined>>(async () => undefined),
}))

type NativeToolsOptions = Omit<ProviderNativeToolsRequest, 'getModelInfo' | 'providerConfig'> & {
  providerConfig: { model?: string; authContext?: { kind?: string } & Record<string, unknown>; oauthToken?: OAuthToken }
}

function getCodexNativeToolsForConfig(options: NativeToolsOptions): Promise<string[]> {
  return resolveProviderNativeTools({ ...options, getModelInfo: mocks.getModelById })
}

const enabledTools: ToolSettings = {
  enableToolCalls: true,
  tools: {},
}

const disabledTools: ToolSettings = {
  enableToolCalls: false,
  tools: {},
}

const oauthToken: OAuthToken = {
  accessToken: 'token',
  expiresAt: Date.now() + 60_000,
  tokenType: 'Bearer',
}

function model(overrides: Partial<OpenRouterModel> = {}): OpenRouterModel {
  return {
    id: 'gpt-5-codex',
    name: 'GPT-5 Codex',
    context_length: 128000,
    architecture: {
      modality: 'text',
      input_modalities: ['text'],
      output_modalities: ['text'],
      tokenizer: 'cl100k_base',
    },
    pricing: {
      prompt: '0',
      completion: '0',
      request: '0',
      image: '0',
    },
    top_provider: {
      context_length: 128000,
      max_completion_tokens: 8192,
      is_moderated: false,
    },
    supported_parameters: ['tools'],
    ...overrides,
  }
}

describe('codex native tools resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not expose native tools outside Codex', async () => {
    const tools = await getCodexNativeToolsForConfig({
      providerId: 'deepseek',
      providerConfig: {
        model: 'deepseek-v4-flash',
        oauthToken,
      },
      toolSettings: enabledTools,
      supportsTools: true,
    })

    expect(tools).toEqual([])
    expect(mocks.getModelById).not.toHaveBeenCalled()
  })

  it('honors the global tool switch and model tool capability', async () => {
    await expect(getCodexNativeToolsForConfig({
      providerId: 'codex',
      providerConfig: {
        model: 'gpt-5-codex',
        oauthToken,
      },
      toolSettings: disabledTools,
      supportsTools: true,
    })).resolves.toEqual([])

    await expect(getCodexNativeToolsForConfig({
      providerId: 'codex',
      providerConfig: {
        model: 'gpt-5-codex',
        oauthToken,
      },
      toolSettings: enabledTools,
      supportsTools: false,
    })).resolves.toEqual([])

    expect(mocks.getModelById).not.toHaveBeenCalled()
  })

  it('requires Codex OAuth authentication', async () => {
    const tools = await getCodexNativeToolsForConfig({
      providerId: 'codex',
      providerConfig: {
        model: 'gpt-5-codex',
        authContext: { kind: 'api-key', apiKey: 'key' },
      },
      toolSettings: enabledTools,
      supportsTools: true,
    })

    expect(tools).toEqual([])
    expect(mocks.getModelById).not.toHaveBeenCalled()
  })

  it('uses provider metadata when native tools are declared', async () => {
    mocks.getModelById.mockResolvedValueOnce(model({
      providerMetadata: {
        codex: {
          nativeTools: [CODEX_NATIVE_IMAGE_GENERATION_TOOL],
        },
      },
    }))

    const tools = await getCodexNativeToolsForConfig({
      providerId: 'codex',
      providerConfig: {
        model: 'gpt-5-codex',
        authContext: { kind: 'oauth', token: oauthToken, account: {} },
      },
      toolSettings: enabledTools,
      supportsTools: true,
    })

    expect(tools).toEqual([CODEX_NATIVE_IMAGE_GENERATION_TOOL])
  })

  it('falls back to image input modality when metadata is absent', async () => {
    mocks.getModelById.mockResolvedValueOnce(model({
      architecture: {
        modality: 'multimodal',
        input_modalities: ['text', 'image'],
        output_modalities: ['text'],
        tokenizer: 'cl100k_base',
      },
    }))

    const tools = await getCodexNativeToolsForConfig({
      providerId: 'codex',
      providerConfig: {
        model: 'gpt-5-codex',
        oauthToken,
      },
      toolSettings: enabledTools,
      supportsTools: true,
    })

    expect(tools).toEqual([CODEX_NATIVE_IMAGE_GENERATION_TOOL])
  })

  it('does not infer image generation for text-only models', async () => {
    mocks.getModelById.mockResolvedValueOnce(model())

    const tools = await getCodexNativeToolsForConfig({
      providerId: 'codex',
      providerConfig: {
        model: 'gpt-5-codex',
        oauthToken,
      },
      toolSettings: enabledTools,
      supportsTools: true,
    })

    expect(tools).toEqual([])
  })
})
