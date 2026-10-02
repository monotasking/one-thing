/**
 * N7-b —— 受管 LLM 调用口的**协议层**验收。
 *
 * 打的是 core 说了算的那一半:声明门(未声明即抛,不计熔断)、输入校验、宿主
 * 没接线时的诚实降级、以及**插件拿不到 apiKey / registry**(受管口只收 messages)。
 * 受管三要素(计费 / 超时 / 配额)的真实行为在装配层那一份(app/plugins llm.test.ts)。
 */
import { describe, expect, it } from 'vitest'
import { createCorePluginAPI } from '../api-builder.js'
import {
  PLUGIN_LLM_MAX_OUTPUT_TOKENS_CEILING,
  PLUGIN_PERMISSION_LLM_COMPLETE,
  PluginLlmError,
  clampPluginLlmMaxTokens,
  describePluginPermission,
  normalizePluginLlmMessages,
  type PluginLlmCompleteOptions,
} from '../index.js'

function build(options: { permissions?: string[]; withLlmPort?: boolean } = {}) {
  const calls: PluginLlmCompleteOptions[] = []
  const errors: string[] = []
  const failures: string[] = []
  const llmPort = options.withLlmPort === false
    ? {}
    : {
      async llmComplete(_pluginId: string, opts: PluginLlmCompleteOptions) {
        calls.push(opts)
        return { text: 'model said hi' }
      },
    }

  const built = createCorePluginAPI<any, any, any, any, any, any, any, any, any, any, any>({
    pluginId: 'smart',
    store: {} as never,
    scheduler: {} as never,
    declaredPermissions: options.permissions ?? [],
    logger: { log() {}, error(message: string) { errors.push(message) } },
    onPluginFailure({ scope }: { scope: string }) { failures.push(scope) },
    host: {
      registerTool() {},
      subscribeEvent() { return () => {} },
      steer() {},
      followUp() {},
      notify() {},
      registerPromptContextProvider() { return () => {} },
      registerBeforeContextCompactHook() { return () => {} },
      registerAfterAssistantResponseHook() { return () => {} },
      registerSkillRoot() { return () => {} },
      ...llmPort,
    } as never,
  })
  return { api: built.api as any, calls, errors, failures }
}

describe('pure helpers', () => {
  it('normalizePluginLlmMessages rejects empty / malformed, passes valid', () => {
    expect(() => normalizePluginLlmMessages([])).toThrow(PluginLlmError)
    expect(() => normalizePluginLlmMessages([{ role: 'boss', content: 'x' }])).toThrow(/role must be/)
    expect(() => normalizePluginLlmMessages([{ role: 'user', content: 3 }])).toThrow(/content must be/)
    expect(normalizePluginLlmMessages([{ role: 'user', content: 'hi' }]))
      .toEqual([{ role: 'user', content: 'hi' }])
  })

  it('clampPluginLlmMaxTokens defaults and clamps to the ceiling', () => {
    expect(clampPluginLlmMaxTokens(undefined)).toBeGreaterThan(0)
    expect(clampPluginLlmMaxTokens(-5)).toBeGreaterThan(0)
    expect(clampPluginLlmMaxTokens(1_000_000)).toBe(PLUGIN_LLM_MAX_OUTPUT_TOKENS_CEILING)
    expect(clampPluginLlmMaxTokens(100)).toBe(100)
  })

  it('discloses the token-spend permission in human words', () => {
    expect(describePluginPermission(PLUGIN_PERMISSION_LLM_COMPLETE))
      .toContain('can make AI model calls on your behalf (uses tokens)')
  })
})

describe('api.llm.complete declaration gate', () => {
  it('未声明 llm:complete → 抛 not-declared,不触达宿主,不计熔断', async () => {
    const { api, calls, errors, failures } = build({ permissions: [] })
    await expect(api.llm.complete({ messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toMatchObject({ code: 'not-declared' })
    expect(calls).toHaveLength(0)
    expect(errors.join('\n')).toContain(PLUGIN_PERMISSION_LLM_COMPLETE)
    // manifest 笔误不该连坐整个插件(与 sendMessage / interceptInput 同规)。
    expect(failures).toEqual([])
  })

  it('宿主没接这条线 → 抛 unsupported', async () => {
    const { api } = build({ permissions: [PLUGIN_PERMISSION_LLM_COMPLETE], withLlmPort: false })
    await expect(api.llm.complete({ messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toMatchObject({ code: 'unsupported' })
  })

  it('声明 + 宿主在场 → 委托宿主,messages 已归一', async () => {
    const { api, calls } = build({ permissions: [PLUGIN_PERMISSION_LLM_COMPLETE] })
    const result = await api.llm.complete({
      messages: [{ role: 'user', content: 'summarize this' }],
      maxTokens: 512,
      temperature: 0,
    })
    expect(result).toEqual({ text: 'model said hi' })
    expect(calls).toHaveLength(1)
    expect(calls[0].messages).toEqual([{ role: 'user', content: 'summarize this' }])
  })

  it('空 messages → 抛 invalid-input,不触达宿主', async () => {
    const { api, calls } = build({ permissions: [PLUGIN_PERMISSION_LLM_COMPLETE] })
    await expect(api.llm.complete({ messages: [] }))
      .rejects.toMatchObject({ code: 'invalid-input' })
    expect(calls).toHaveLength(0)
  })

  it('插件拿不到 apiKey / registry —— 受管口只把 messages 交给宿主', async () => {
    const { api, calls } = build({ permissions: [PLUGIN_PERMISSION_LLM_COMPLETE] })
    // 插件手里的 api 没有任何 provider / apiKey / registry 面。
    expect((api as Record<string, unknown>).modelRegistry).toBeUndefined()
    expect(Object.keys(api.llm)).toEqual(['complete'])
    await api.llm.complete({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 64 })
    // 宿主收到的是受管请求 —— 没有 apiKey 字段可读。
    expect(Object.keys(calls[0]).sort()).toEqual(['maxTokens', 'messages', 'signal', 'temperature'])
    expect((calls[0] as unknown as Record<string, unknown>).apiKey).toBeUndefined()
  })
})
