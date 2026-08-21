import { describe, expect, it } from 'vitest'
import {
  CODEX_NATIVE_IMAGE_GENERATION_TOOL,
  providerConfigUsesCodexOAuth,
  resolveCodexNativeToolsFromModelInfo,
  shouldResolveCodexNativeTools,
} from '@onething/runtime/providers'

describe('onething runtime Codex native tools helpers', () => {
  it('gates native tools to Codex OAuth with tool support enabled', () => {
    expect(providerConfigUsesCodexOAuth({
      authContext: { kind: 'oauth' },
    })).toBe(true)
    expect(providerConfigUsesCodexOAuth({
      oauthToken: { accessToken: 'token' },
    })).toBe(true)
    expect(providerConfigUsesCodexOAuth({
      authContext: { kind: 'api-key' },
    })).toBe(false)

    expect(shouldResolveCodexNativeTools({
      providerId: 'codex',
      providerConfig: { oauthToken: { accessToken: 'token' } },
      toolSettings: { enableToolCalls: true },
      supportsTools: true,
    })).toBe(true)
    expect(shouldResolveCodexNativeTools({
      providerId: 'openai',
      providerConfig: { oauthToken: { accessToken: 'token' } },
      toolSettings: { enableToolCalls: true },
      supportsTools: true,
    })).toBe(false)
  })

  it('resolves native image generation from model metadata or image input modality', () => {
    expect(resolveCodexNativeToolsFromModelInfo({
      providerMetadata: {
        codex: {
          nativeTools: [CODEX_NATIVE_IMAGE_GENERATION_TOOL],
        },
      },
    })).toEqual([CODEX_NATIVE_IMAGE_GENERATION_TOOL])

    expect(resolveCodexNativeToolsFromModelInfo({
      providerMetadata: {
        codex: {
          nativeTools: ['other_tool'],
        },
      },
      architecture: {
        input_modalities: ['image'],
      },
    })).toEqual([])

    expect(resolveCodexNativeToolsFromModelInfo({
      architecture: {
        input_modalities: ['text', 'image'],
      },
    })).toEqual([CODEX_NATIVE_IMAGE_GENERATION_TOOL])

    expect(resolveCodexNativeToolsFromModelInfo({
      architecture: {
        input_modalities: ['text'],
      },
    })).toEqual([])

    expect(resolveCodexNativeToolsFromModelInfo(undefined)).toEqual([CODEX_NATIVE_IMAGE_GENERATION_TOOL])
  })
})
