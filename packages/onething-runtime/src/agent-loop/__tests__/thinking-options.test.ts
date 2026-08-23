import { describe, expect, it } from 'vitest'
import { getOnethingAgentLoopThinkingOptions } from '../providers/thinking-options.js'

function options(providerId: string, model: string, thinkingByModel?: Record<string, boolean | undefined>, thinkingEffortByModel?: Record<string, unknown>) {
  return getOnethingAgentLoopThinkingOptions({
    providerId,
    providerConfig: { model, thinkingByModel, thinkingEffortByModel },
  })
}

describe('getOnethingAgentLoopThinkingOptions', () => {
  // deepseek used to have a branch here purely to default the effort to 'high'.
  // That default is deepseek's own business and now lives in deepseek.ts, which
  // also clamps anything below high — so this layer just carries user intent.
  // The wire-level guarantees are asserted in the deepseek provider's own tests.
  it('carries plain user intent for deepseek', () => {
    expect(options('deepseek', 'deepseek-v4')).toEqual({})
    expect(options('deepseek', 'deepseek-v4', { 'deepseek-v4': false })).toEqual({ thinking: 'disabled' })
    expect(options('deepseek', 'deepseek-v4', { 'deepseek-v4': true })).toEqual({
      thinking: 'enabled',
      reasoningEffort: undefined,
    })
    expect(options('deepseek', 'deepseek-v4', { 'deepseek-v4': true }, { 'deepseek-v4': 'max' })).toEqual({
      thinking: 'enabled',
      reasoningEffort: 'max',
    })
  })

  it('sends reasoning_effort max for kimi-k3 unless the toggle is off', () => {
    expect(options('kimi', 'kimi-k3')).toEqual({ reasoningEffort: 'max' })
    expect(options('kimi', 'kimi-k3', { 'kimi-k3': true })).toEqual({ reasoningEffort: 'max' })
    expect(options('kimi', 'kimi-k3', { 'kimi-k3': false })).toEqual({})
  })

  it('sends no thinking params for always-thinking kimi models', () => {
    expect(options('kimi', 'kimi-k2.7-code')).toEqual({})
    expect(options('kimi', 'kimi-k2.7-code-highspeed', { 'kimi-k2.7-code-highspeed': false })).toEqual({})
    expect(options('kimi', 'kimi-k2-thinking', { 'kimi-k2-thinking': false })).toEqual({})
  })

  it('maps the kimi toggle onto thinking.type for toggleable models', () => {
    expect(options('kimi', 'kimi-k2.6')).toEqual({})
    expect(options('kimi', 'kimi-k2.6', { 'kimi-k2.6': true })).toEqual({ thinking: 'enabled' })
    expect(options('kimi', 'kimi-k2.5', { 'kimi-k2.5': false })).toEqual({ thinking: 'disabled' })
  })

  /**
   * #8 —— Code Plan 通路跑的是开放平台那几族模型,所以家规是同一份
   * (`kimiThinkingIntent` 挂在两份配方上)。在它挂上之前,`kimi-code` 走通用
   * 规则:关思考会发出 k2.7-code **拒收**的 `thinking:{type:'disabled'}`。
   */
  it('applies the same kimi family rules on the Code Plan route', () => {
    expect(options('kimi-code', 'kimi-k2.7-code', { 'kimi-k2.7-code': false })).toEqual({})
    expect(options('kimi-code', 'kimi-k2-thinking', { 'kimi-k2-thinking': false })).toEqual({})
    expect(options('kimi-code', 'kimi-k3', { 'kimi-k3': false })).toEqual({})
    expect(options('kimi-code', 'kimi-k3')).toEqual({ reasoningEffort: 'max' })
    // 可切换的那一族仍然照常发开关 —— 家规只对「常开」的模型闭嘴。
    expect(options('kimi-code', 'kimi-k2.6', { 'kimi-k2.6': false })).toEqual({ thinking: 'disabled' })
    expect(options('kimi-code', 'kimi-k2.6', { 'kimi-k2.6': true })).toEqual({ thinking: 'enabled' })
  })

  it('resolves the generic toggle + effort for every other provider', () => {
    expect(options('openai', 'gpt-5.2')).toEqual({})
    expect(options('openai', 'gpt-5.2', { 'gpt-5.2': true })).toEqual({ thinking: 'enabled' })
    expect(options('openai', 'gpt-5.2', { 'gpt-5.2': true }, { 'gpt-5.2': 'minimal' })).toEqual({
      thinking: 'enabled',
      reasoningEffort: 'minimal',
    })
    expect(options('claude', 'claude-opus-4-8', { 'claude-opus-4-8': false })).toEqual({
      thinking: 'disabled',
    })
    expect(options('zhipu', 'glm-5.2', { 'glm-5.2': true })).toEqual({ thinking: 'enabled' })
    expect(options('gemini', 'gemini-3-pro', { 'gemini-3-pro': true }, { 'gemini-3-pro': 'medium' })).toEqual({
      thinking: 'enabled',
      reasoningEffort: 'medium',
    })
  })

  it('drops effort values outside the abstract scale', () => {
    expect(options('openai', 'gpt-5.2', { 'gpt-5.2': true }, { 'gpt-5.2': 'turbo' })).toEqual({
      thinking: 'enabled',
    })
  })
})
