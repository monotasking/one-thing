/**
 * per-space 默认 provider/model 的**解析**面(批 B9)。
 *
 * 用户 08-17 推翻了批 B7 的「默认模型有意留全局」:「不同的空间,它的默认模型
 * 以及这个模型列表都是要不一样的。」
 *
 * 这一层验的是那条唯一的解析缝:**会话显式 > 空间默认 > 全局默认**,默认空间
 * (适配器不给这一格)逐字等于今天的行为。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  getEffectiveProviderConfig,
  type CoreAppSettingsWithAI,
  type CoreProviderConfigLike,
} from '../provider-config.js'
import { getEffectiveOnethingProviderConfig } from '../provider-runtime.js'
import { createOnethingStreamProviderAdapter } from '../stream-provider-adapter.js'

interface TestProvider extends CoreProviderConfigLike {
  apiKey?: string
}

function settings(): CoreAppSettingsWithAI<TestProvider> {
  return {
    ai: {
      provider: 'deepseek',
      providers: {
        deepseek: { model: 'deepseek-chat', apiKey: 'sk-1' },
        zhipu: { model: 'glm-5', apiKey: 'zp-1' },
      },
    },
  } as unknown as CoreAppSettingsWithAI<TestProvider>
}

describe('getEffectiveProviderConfig —— 空间默认这一格(批 B9)', () => {
  it('空间没表达过 → 全局默认(default 空间就是这一支,零变化)', () => {
    const resolved = getEffectiveProviderConfig(settings(), null, null, undefined)
    expect(resolved.providerId).toBe('deepseek')
    expect(resolved.model).toBe('deepseek-chat')
  })

  it('空间表达过 → 以空间为准(压过全局 settings.ai.provider)', () => {
    const resolved = getEffectiveProviderConfig(settings(), null, null, {
      provider: 'zhipu',
      model: 'glm-5-air',
    })
    expect(resolved.providerId).toBe('zhipu')
    expect(resolved.model).toBe('glm-5-air')
    expect(resolved.providerConfig?.model).toBe('glm-5-air')
  })

  it('空间只钉 provider → model 落回该 provider 的全局默认模型', () => {
    const resolved = getEffectiveProviderConfig(settings(), null, null, { provider: 'zhipu' })
    expect(resolved).toMatchObject({ providerId: 'zhipu', model: 'glm-5' })
  })

  it('会话显式选择压过空间默认(空间默认只是这个空间的缺省)', () => {
    const resolved = getEffectiveProviderConfig(
      settings(),
      { lastProvider: 'deepseek', lastModel: 'deepseek-reasoner' },
      null,
      { provider: 'zhipu', model: 'glm-5' },
    )
    expect(resolved).toMatchObject({ providerId: 'deepseek', model: 'deepseek-reasoner' })
  })

  it('override(agent 绑定 / 会话置顶,由渲染层算好递进来)压过空间默认', () => {
    // agent 覆盖 > 空间默认 > 全局默认 —— agent 绑定在渲染层折进 override,
    // 引擎侧因此只需要保证 override 这一支仍然排第一。
    const resolved = getEffectiveProviderConfig(
      settings(),
      null,
      { providerId: 'deepseek', model: 'deepseek-reasoner' },
      { provider: 'zhipu', model: 'glm-5' },
    )
    expect(resolved).toMatchObject({ providerId: 'deepseek', model: 'deepseek-reasoner' })
  })

  it('空间默认指着 settings 里不存在的 provider → 落全局,不去猜', () => {
    const resolved = getEffectiveProviderConfig(settings(), null, null, { provider: 'ghost' })
    expect(resolved).toMatchObject({ providerId: 'deepseek', model: 'deepseek-chat' })
  })

  it('provider 存在但这个空间没配凭证 → 照样选中它(诚实),拦截交给 B3 的隔离闸', () => {
    // 「这个空间没配 key」不是「这个 provider 不存在」:静默改选别的才是说谎。
    const withGate = settings()
    const resolved = getEffectiveOnethingProviderConfig<TestProvider>(withGate, 's1', {
      resolveSpaceDefaultSelection: () => ({ provider: 'zhipu', model: 'glm-5' }),
      applySpaceCredentials: (_sessionId, _providerId, config) =>
        config && {
          ...config,
          spaceCredential: {
            spaceId: 'work',
            unavailable: { reason: 'no-entry' as const, message: '当前空间未配置 Zhipu 的凭证。' },
          },
        },
    })
    expect(resolved.providerId).toBe('zhipu')
    expect(resolved.providerConfig?.spaceCredential?.unavailable?.reason).toBe('no-entry')
  })
})

describe('注入缝(批 B9)—— 两条解析链共用同一个函数', () => {
  it('getEffectiveOnethingProviderConfig 把适配器那一格递下去,并按 sessionId 问', () => {
    const resolveSpaceDefaultSelection = vi.fn((sessionId: string) =>
      sessionId === 's-work' ? { provider: 'zhipu', model: 'glm-5' } : undefined,
    )
    const inWork = getEffectiveOnethingProviderConfig<TestProvider>(settings(), 's-work', {
      resolveSpaceDefaultSelection,
    })
    const inDefault = getEffectiveOnethingProviderConfig<TestProvider>(settings(), 's-default', {
      resolveSpaceDefaultSelection,
    })
    expect(inWork).toMatchObject({ providerId: 'zhipu', model: 'glm-5' })
    expect(inDefault).toMatchObject({ providerId: 'deepseek', model: 'deepseek-chat' })
    expect(resolveSpaceDefaultSelection).toHaveBeenCalledWith('s-work')
  })

  it('不给适配器 = 今天的行为(默认空间一字未改)', () => {
    const bare = getEffectiveOnethingProviderConfig<TestProvider>(settings(), 's1', {})
    expect(bare).toMatchObject({ providerId: 'deepseek', model: 'deepseek-chat' })
  })

  it('引擎那条链(StreamEngineProviderAdapter.getEffectiveConfig)走同一格', () => {
    const adapter = createOnethingStreamProviderAdapter<TestProvider>({
      getSession: () => null,
      resolveSpaceDefaultSelection: () => ({ provider: 'zhipu' }),
      isProviderSupported: () => true,
      isOAuthProvider: () => false,
      resolveApiKey: (_id, config) => config?.apiKey,
      resolveOAuthAuth: async () => null,
      generateTitle: async () => 'title',
    })
    const resolved = adapter.getEffectiveConfig(settings() as never, 's1', undefined)
    expect(resolved).toMatchObject({ providerId: 'zhipu', model: 'glm-5' })
  })
})
