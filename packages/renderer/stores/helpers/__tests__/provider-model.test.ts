/**
 * The display-side resolver MUST stay rule-for-rule identical with the
 * engine's getEffectiveProviderConfig (packages/onething-runtime/src/
 * providers/provider-config.ts) — these cases mirror the engine tests in
 * apps/electron/src/main/engine/__tests__/core-provider-config.test.ts. Divergence is how
 * "the picker showed deepseek but the request went to codex" happens.
 */
import { describe, expect, it } from 'vitest'
import type { AppSettings } from '@/types'
import { isProviderEnabledIn, resolveProviderModelSelection } from '../provider-model'
import {
  resolveAgentProfile,
  type OnethingAgentDefinition,
} from '@onething/runtime/agents'
import { getEffectiveProviderConfig } from '@onething/runtime/providers/provider-config'

function settings(): AppSettings {
  return {
    ai: {
      provider: 'codex',
      providers: {
        codex: {
          model: 'gpt-5.5',
          selectedModels: ['gpt-5.5'],
        },
        deepseek: {
          model: 'deepseek-chat',
          selectedModels: ['deepseek-chat'],
        },
      },
      customProviders: [],
    },
  } as unknown as AppSettings
}

describe('resolveProviderModelSelection', () => {
  it('shows the session pair as-is when the provider config exists', () => {
    expect(
      resolveProviderModelSelection({
        settings: settings(),
        session: { lastProvider: 'deepseek', lastModel: 'deepseek-v4-pro' },
      }),
    ).toEqual({ providerId: 'deepseek', model: 'deepseek-v4-pro' })
  })

  it('falls back to the provider default model when only lastProvider is set', () => {
    expect(
      resolveProviderModelSelection({
        settings: settings(),
        session: { lastProvider: 'deepseek' },
      }),
    ).toEqual({ providerId: 'deepseek', model: 'deepseek-chat' })
  })

  it('falls back to the global selection when the session provider has no config', () => {
    expect(
      resolveProviderModelSelection({
        settings: settings(),
        session: { lastProvider: 'missing', lastModel: 'whatever' },
      }),
    ).toEqual({ providerId: 'codex', model: 'gpt-5.5' })
  })

  it('ignores a model-only session (no provider inference) and shows global', () => {
    expect(
      resolveProviderModelSelection({
        settings: settings(),
        session: { lastModel: 'deepseek-chat' },
      }),
    ).toEqual({ providerId: 'codex', model: 'gpt-5.5' })
  })

  it('shows global when the session has no selection at all', () => {
    expect(
      resolveProviderModelSelection({ settings: settings(), session: null }),
    ).toEqual({ providerId: 'codex', model: 'gpt-5.5' })
  })

  it('shows the agent binding over a session model the user never picked', () => {
    expect(
      resolveProviderModelSelection({
        settings: settings(),
        // lastProvider here is the auto-stamp every assistant message writes.
        session: { lastProvider: 'codex', lastModel: 'gpt-5.5' },
        agentModel: { providerId: 'deepseek', modelId: 'deepseek-chat' },
      }),
    ).toEqual({ providerId: 'deepseek', model: 'deepseek-chat' })
  })

  it('lets a pinned session model outrank the agent binding', () => {
    expect(
      resolveProviderModelSelection({
        settings: settings(),
        session: { lastProvider: 'codex', lastModel: 'gpt-5.5', modelPinned: true },
        agentModel: { providerId: 'deepseek', modelId: 'deepseek-chat' },
      }),
    ).toEqual({ providerId: 'codex', model: 'gpt-5.5' })
  })

  it('falls back to the binding provider default when it pins no model', () => {
    expect(
      resolveProviderModelSelection({
        settings: settings(),
        session: null,
        agentModel: { providerId: 'deepseek' },
      }),
    ).toEqual({ providerId: 'deepseek', model: 'deepseek-chat' })
  })

  it('ignores a binding whose provider has no config', () => {
    expect(
      resolveProviderModelSelection({
        settings: settings(),
        session: { lastProvider: 'deepseek', lastModel: 'deepseek-chat' },
        agentModel: { providerId: 'gone' },
      }),
    ).toEqual({ providerId: 'deepseek', model: 'deepseek-chat' })
  })

  it('does not repair a mismatched pair — what is shown is what will be sent', () => {
    // The old behavior rerouted the display to whichever provider had the
    // model, while the engine kept using the stored pair; the incident this
    // guards against is the picker and the request disagreeing.
    expect(
      resolveProviderModelSelection({
        settings: settings(),
        session: { lastProvider: 'deepseek', lastModel: 'gpt-5.5' },
      }),
    ).toEqual({ providerId: 'deepseek', model: 'gpt-5.5' })
  })
})

/**
 * Not a re-statement of the rule — the engine's own functions are run here and
 * the two answers are compared. The agent binding gave the picker a second
 * input, and a second input is a second chance to diverge.
 */
describe('display resolver mirrors the engine', () => {
  function engineSelection(input: {
    session: { lastProvider?: string; lastModel?: string; modelPinned?: boolean } | null
    agent: Partial<OnethingAgentDefinition>
  }) {
    const agent: OnethingAgentDefinition = {
      id: 'agent-a',
      name: 'A',
      systemPrompt: '',
      createdAt: 0,
      updatedAt: 0,
      ...input.agent,
    }
    // What StreamEngine.withAgentModelBinding stamps onto the command…
    const binding = resolveAgentProfile({
      agent,
      session: { modelPinned: input.session?.modelPinned },
    }).model
    // …and what the engine then resolves it to.
    const resolved = getEffectiveProviderConfig(
      settings() as never,
      input.session,
      binding?.providerId
        ? { providerId: binding.providerId, model: binding.modelId }
        : null,
    )
    return { providerId: resolved.providerId, model: resolved.model }
  }

  const cases: Array<{
    name: string
    session: { lastProvider?: string; lastModel?: string; modelPinned?: boolean } | null
    agent: Partial<OnethingAgentDefinition>
  }> = [
    { name: 'no binding, no session', session: null, agent: {} },
    { name: 'no binding, session pair', session: { lastProvider: 'deepseek', lastModel: 'deepseek-chat' }, agent: {} },
    { name: 'binding, no session', session: null, agent: { model: { providerId: 'deepseek', modelId: 'deepseek-chat' } } },
    {
      name: 'binding over an auto-stamped session',
      session: { lastProvider: 'codex', lastModel: 'gpt-5.5' },
      agent: { model: { providerId: 'deepseek', modelId: 'deepseek-chat' } },
    },
    {
      name: 'pinned session over a binding',
      session: { lastProvider: 'codex', lastModel: 'gpt-5.5', modelPinned: true },
      agent: { model: { providerId: 'deepseek', modelId: 'deepseek-chat' } },
    },
    {
      name: 'binding with no model pinned',
      session: null,
      agent: { model: { providerId: 'deepseek' } },
    },
    {
      name: 'binding at a provider with no config',
      session: { lastProvider: 'deepseek', lastModel: 'deepseek-chat' },
      agent: { model: { providerId: 'gone' } },
    },
  ]

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(
        resolveProviderModelSelection({
          settings: settings(),
          session: testCase.session,
          agentModel: testCase.agent.model ?? null,
        }),
      ).toEqual(engineSelection(testCase))
    })
  }
})

/**
 * A family card has ONE switch, so a member reads as enabled off the family
 * (the API member's flag); the subscription member's own flag survives only
 * as the legacy per-provider override that can switch it on when the API
 * side is off. Both directions of legacy drift are covered.
 */
describe('isProviderEnabledIn — provider families', () => {
  it('api ON / subscription OFF: the subscription member is enabled (kimi true / kimi-code false)', () => {
    const providers = { kimi: { enabled: true }, 'kimi-code': { enabled: false } }
    expect(isProviderEnabledIn(providers, 'kimi')).toBe(true)
    expect(isProviderEnabledIn(providers, 'kimi-code')).toBe(true)
  })

  it('api OFF / subscription ON: the API member stays off (openai false / codex true)', () => {
    const providers = { openai: { enabled: false }, codex: { enabled: true } }
    expect(isProviderEnabledIn(providers, 'openai')).toBe(false)
    expect(isProviderEnabledIn(providers, 'codex')).toBe(true)
  })

  it('both OFF: both hidden; missing sibling counts as unset (= enabled)', () => {
    expect(isProviderEnabledIn({ grok: { enabled: false }, 'grok-oauth': { enabled: false } }, 'grok-oauth')).toBe(false)
    expect(isProviderEnabledIn({ 'kimi-code': { enabled: false } }, 'kimi-code')).toBe(true)
  })

  it('non-family providers read their own flag only', () => {
    expect(isProviderEnabledIn({ deepseek: { enabled: false } }, 'deepseek')).toBe(false)
    expect(isProviderEnabledIn({}, 'deepseek')).toBe(true)
  })
})

/* ── 批 B9:空间默认 + 空间开关覆盖 ─────────────────────────────────────── */

describe('resolveProviderModelSelection —— 空间默认这一格(批 B9)', () => {
  it('会话/agent 都没表达过 → 空间默认压过全局', () => {
    expect(
      resolveProviderModelSelection({
        settings: settings(),
        spaceDefault: { provider: 'deepseek', model: 'deepseek-chat' },
      }),
    ).toEqual({ providerId: 'deepseek', model: 'deepseek-chat' })
  })

  it('空间只钉 provider → model 落回该 provider 的全局默认模型', () => {
    expect(
      resolveProviderModelSelection({ settings: settings(), spaceDefault: { provider: 'deepseek' } }),
    ).toEqual({ providerId: 'deepseek', model: 'deepseek-chat' })
  })

  it('缺席(default 空间 / 这个空间没表达过)→ 逐字等于今天', () => {
    expect(resolveProviderModelSelection({ settings: settings(), spaceDefault: undefined }))
      .toEqual({ providerId: 'codex', model: 'gpt-5.5' })
  })

  it('优先级:agent 绑定 > 空间默认 > 全局', () => {
    expect(
      resolveProviderModelSelection({
        settings: settings(),
        agentModel: { providerId: 'codex', modelId: 'gpt-5.5' },
        spaceDefault: { provider: 'deepseek', model: 'deepseek-chat' },
      }),
    ).toEqual({ providerId: 'codex', model: 'gpt-5.5' })
  })

  it('优先级:会话 lastProvider > 空间默认', () => {
    expect(
      resolveProviderModelSelection({
        settings: settings(),
        session: { lastProvider: 'codex', lastModel: 'gpt-5.5' },
        spaceDefault: { provider: 'deepseek', model: 'deepseek-chat' },
      }),
    ).toEqual({ providerId: 'codex', model: 'gpt-5.5' })
  })

  it('空间默认指着不存在的 provider → 落全局(与 agent/session 同一条不变式)', () => {
    expect(
      resolveProviderModelSelection({ settings: settings(), spaceDefault: { provider: 'ghost' } }),
    ).toEqual({ providerId: 'codex', model: 'gpt-5.5' })
  })

  it('与引擎侧逐条同形(同一组输入,两边同解)', () => {
    const spaceDefault = { provider: 'deepseek', model: 'deepseek-chat' }
    const engine = getEffectiveProviderConfig(settings() as never, null, null, spaceDefault)
    const display = resolveProviderModelSelection({ settings: settings(), spaceDefault })
    expect(display).toEqual({ providerId: engine.providerId, model: engine.model })
  })
})

describe('isProviderEnabledIn —— 空间覆盖(批 B9),家族语义不变', () => {
  it('逐 id 缺席 = 回落全局;整个覆盖缺席 = 逐字等于今天', () => {
    const providers = { deepseek: { enabled: false }, zhipu: { enabled: true } }
    expect(isProviderEnabledIn(providers, 'deepseek', undefined)).toBe(false)
    expect(isProviderEnabledIn(providers, 'deepseek', {})).toBe(false)
    expect(isProviderEnabledIn(providers, 'deepseek', { zhipu: false })).toBe(false)
  })

  it('表达过即以空间为准(两个方向都能翻)', () => {
    const providers = { deepseek: { enabled: false }, zhipu: { enabled: true } }
    expect(isProviderEnabledIn(providers, 'deepseek', { deepseek: true })).toBe(true)
    expect(isProviderEnabledIn(providers, 'zhipu', { zhipu: false })).toBe(false)
  })

  it('家族派生看的是**经过空间层之后**的成员开关(Kimi 家族)', () => {
    // 全局 kimi 关着,空间里把 API 成员打开 → 订阅成员 kimi-code 跟着可见。
    const providers = { kimi: { enabled: false }, 'kimi-code': { enabled: false } }
    expect(isProviderEnabledIn(providers, 'kimi-code', { kimi: true })).toBe(true)
    expect(isProviderEnabledIn(providers, 'kimi', { kimi: true })).toBe(true)
  })

  it('家族:空间里关掉 API 成员,订阅成员自己的 legacy 开关仍能把它救回来', () => {
    const providers = { kimi: { enabled: true }, 'kimi-code': { enabled: true } }
    expect(isProviderEnabledIn(providers, 'kimi', { kimi: false })).toBe(false)
    // kimi-code 自己那格没被空间表达过 → 回落全局 true,家族读法照旧放行。
    expect(isProviderEnabledIn(providers, 'kimi-code', { kimi: false })).toBe(true)
    // 两个成员都在空间里关掉 → 都不可见。
    expect(isProviderEnabledIn(providers, 'kimi-code', { kimi: false, 'kimi-code': false })).toBe(false)
  })
})
