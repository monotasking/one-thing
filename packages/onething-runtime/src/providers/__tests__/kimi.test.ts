/**
 * Kimi endpoint matrix. Three hosts, two of which are not interchangeable with
 * the third: a Kimi Code (编程套餐) key 401s against the 开放平台 host, and the
 * reverse is the expensive one — the general key on the general host silently
 * bills per-token on top of a subscription the user already paid for.
 *
 * So what is worth pinning: mode × region resolves to the right host, the
 * coding plan does NOT sprout a fabricated regional twin, and a hand-typed base
 * URL is never silently overwritten.
 */
import { describe, expect, it } from 'vitest'
import {
  ONETHING_KIMI_CODE_DEFAULT_MODEL,
  ONETHING_KIMI_CODE_MODELS_DEV_ID,
} from '../vendors/kimi-code/manifest.js'
import {
  ONETHING_KIMI_CODING_PLAN_BASE_URL,
  ONETHING_KIMI_DEFAULT_BASE_URL,
  ONETHING_KIMI_STANDARD_CN_BASE_URL,
  ONETHING_KIMI_STANDARD_INTL_BASE_URL,
  getOnethingKimiBaseUrl,
  normalizeOnethingKimiApiMode,
  normalizeOnethingKimiRegion,
  onethingKimiRegionApplies,
  resolveOnethingKimiBaseUrl,
  resolveOnethingKimiModelsDevProviderId,
  readOnethingKimiOptions,
} from '../vendors/kimi/endpoint.js'
import { getOnethingModelsDevProviderId } from '../model-registry.js'
import { kimiCodeBuiltinProvider } from '../builtin-providers.js'
import { resolveOnethingProviderBaseUrl } from '../endpoint.js'
import { pickOnethingProviderOptions } from '../provider-options.js'
import { withResolvedProviderBaseUrl } from '../provider-config.js'
import type { CoreProviderConfigLike } from '../provider-config.js'

describe('kimi endpoint matrix', () => {
  it('开放平台按区分家，编程套餐不分家', () => {
    expect(resolveOnethingKimiBaseUrl({ kimiApiMode: 'standard', kimiRegion: 'cn' }))
      .toBe(ONETHING_KIMI_STANDARD_CN_BASE_URL)
    expect(resolveOnethingKimiBaseUrl({ kimiApiMode: 'standard', kimiRegion: 'intl' }))
      .toBe(ONETHING_KIMI_STANDARD_INTL_BASE_URL)
    // 同一个地址:Kimi Code 只有一个全球 host。这两行相等**是**契约,
    // 不是复制粘贴 —— 编出一个 api.kimi.cn 才是错的。
    expect(resolveOnethingKimiBaseUrl({ kimiApiMode: 'coding-plan', kimiRegion: 'cn' }))
      .toBe(ONETHING_KIMI_CODING_PLAN_BASE_URL)
    expect(resolveOnethingKimiBaseUrl({ kimiApiMode: 'coding-plan', kimiRegion: 'intl' }))
      .toBe(ONETHING_KIMI_CODING_PLAN_BASE_URL)
  })

  it('三个地址各自是vendor给的那一个', () => {
    expect(ONETHING_KIMI_STANDARD_CN_BASE_URL).toBe('https://api.moonshot.cn/v1')
    expect(ONETHING_KIMI_STANDARD_INTL_BASE_URL).toBe('https://api.moonshot.ai/v1')
    expect(ONETHING_KIMI_CODING_PLAN_BASE_URL).toBe('https://api.kimi.com/coding/v1')
  })

  it('拿不准就回到国内按量 —— 猜错方向要往便宜的那边猜', () => {
    expect(normalizeOnethingKimiApiMode('coding-plan')).toBe('coding-plan')
    expect(normalizeOnethingKimiApiMode('nonsense')).toBe('standard')
    expect(normalizeOnethingKimiApiMode(undefined)).toBe('standard')
    expect(normalizeOnethingKimiRegion('intl')).toBe('intl')
    expect(normalizeOnethingKimiRegion('mars')).toBe('cn')

    expect(resolveOnethingKimiBaseUrl(undefined)).toBe(ONETHING_KIMI_DEFAULT_BASE_URL)
    expect(resolveOnethingKimiBaseUrl({})).toBe(ONETHING_KIMI_DEFAULT_BASE_URL)
    expect(ONETHING_KIMI_DEFAULT_BASE_URL).toBe(ONETHING_KIMI_STANDARD_CN_BASE_URL)
  })

  it('手写的地址赢过档位，但我们自己那三个不算手写', () => {
    expect(resolveOnethingKimiBaseUrl({
      baseUrl: 'https://kimi.internal.corp/v1',
      kimiApiMode: 'coding-plan',
    })).toBe('https://kimi.internal.corp/v1')

    // 旧配置里可能还留着换档之前的地址 —— 那种情况档位说了算。
    expect(resolveOnethingKimiBaseUrl({
      baseUrl: ONETHING_KIMI_STANDARD_CN_BASE_URL,
      kimiApiMode: 'coding-plan',
      kimiRegion: 'cn',
    })).toBe(ONETHING_KIMI_CODING_PLAN_BASE_URL)

    // 末尾斜杠不该把地址变成「陌生的」。
    expect(resolveOnethingKimiBaseUrl({
      baseUrl: `${ONETHING_KIMI_CODING_PLAN_BASE_URL}/`,
      kimiApiMode: 'standard',
      kimiRegion: 'intl',
    })).toBe(ONETHING_KIMI_STANDARD_INTL_BASE_URL)
  })

  it('区域这一格只在按量时有意义(设置页据此收行)', () => {
    expect(onethingKimiRegionApplies('standard')).toBe(true)
    expect(onethingKimiRegionApplies('coding-plan')).toBe(false)
    expect(getOnethingKimiBaseUrl('coding-plan', 'intl'))
      .toBe(getOnethingKimiBaseUrl('coding-plan', 'cn'))
  })

  it('走通用分发口时认得 kimi(否则装配层拿到的是原样 baseUrl)', () => {
    expect(resolveOnethingProviderBaseUrl('kimi', { kimiApiMode: 'coding-plan' }))
      .toBe(ONETHING_KIMI_CODING_PLAN_BASE_URL)
    expect(resolveOnethingProviderBaseUrl('kimi', undefined))
      .toBe(ONETHING_KIMI_DEFAULT_BASE_URL)
  })
})

/**
 * 这一组是从一次真实误配倒推出来的:`kimi-code` 曾被接到按量那本 `moonshotai`
 * 上,症状是「模型列表里没有 k3-256k」—— 那个 id 只存在于套餐自己那本目录。
 * 两本目录**一个 id 都不重名**,所以接错了不会报错,只会静静地少一半模型、
 * 且默认模型 404。
 */
describe('models.dev 目录跟着地址走', () => {
  it('套餐读自己那本,按量按地区读各自那本', () => {
    expect(resolveOnethingKimiModelsDevProviderId({ kimiApiMode: 'standard', kimiRegion: 'cn' }))
      .toBe('moonshotai-cn')
    expect(resolveOnethingKimiModelsDevProviderId({ kimiApiMode: 'standard', kimiRegion: 'intl' }))
      .toBe('moonshotai')
    expect(resolveOnethingKimiModelsDevProviderId({ kimiApiMode: 'coding-plan', kimiRegion: 'cn' }))
      .toBe(ONETHING_KIMI_CODE_MODELS_DEV_ID)
    // 地址不分区,目录也就不分区。
    expect(resolveOnethingKimiModelsDevProviderId({ kimiApiMode: 'coding-plan', kimiRegion: 'intl' }))
      .toBe(ONETHING_KIMI_CODE_MODELS_DEV_ID)
  })

  it('订阅那个 provider 无条件读套餐目录(它只有一个地址)', () => {
    expect(getOnethingModelsDevProviderId('kimi-code')).toBe('kimi-for-coding')
    // 按量那条要把配置带进去,否则国内用户读到的是海外那本。
    expect(getOnethingModelsDevProviderId('kimi', { kimiApiMode: 'standard', kimiRegion: 'cn' }))
      .toBe('moonshotai-cn')
    expect(getOnethingModelsDevProviderId('kimi', { kimiApiMode: 'coding-plan' }))
      .toBe('kimi-for-coding')
  })

  it('订阅档的默认模型必须是套餐目录里的 id,不是按量那本的', () => {
    // `kimi-k2.7-code-highspeed` 是按量那本的名字 —— 写它在套餐上会 404。
    expect(kimiCodeBuiltinProvider.info.defaultModel).toBe(ONETHING_KIMI_CODE_DEFAULT_MODEL)
    expect(kimiCodeBuiltinProvider.info.defaultModel).not.toMatch(/^kimi-k/)
  })
})

describe('kimi 的私有旋钮进袋子', () => {
  it('存下来的两枚字段照原样装袋，别的 provider 不沾', () => {
    expect(pickOnethingProviderOptions('kimi', { kimiApiMode: 'coding-plan', kimiRegion: 'intl' }))
      .toEqual({ kimiApiMode: 'coding-plan', kimiRegion: 'intl' })
    // 没配过也给一份完整的:端点是一对键的查表,缺一格就查不出来。
    expect(pickOnethingProviderOptions('kimi', { model: 'kimi-k3' }))
      .toEqual({ kimiApiMode: 'standard', kimiRegion: 'cn' })
    expect(pickOnethingProviderOptions('openai', { kimiApiMode: 'coding-plan' })).toBeUndefined()
  })

  it('拆袋子的地方才做收敛 —— 袋子本身是无类型的', () => {
    expect(readOnethingKimiOptions({ kimiApiMode: 'nonsense', kimiRegion: 'mars' }))
      .toEqual({ kimiApiMode: 'standard', kimiRegion: 'cn' })
    expect(readOnethingKimiOptions(undefined))
      .toEqual({ kimiApiMode: 'standard', kimiRegion: 'cn' })
  })

  it('存 → 跑 的那道边界上，地址与袋子一起备好', () => {
    const stored: CoreProviderConfigLike = {
      model: 'kimi-k3',
      kimiApiMode: 'coding-plan',
      kimiRegion: 'cn',
    }
    const packed = withResolvedProviderBaseUrl('kimi', stored)
    expect(packed?.baseUrl).toBe(ONETHING_KIMI_CODING_PLAN_BASE_URL)
    expect(packed?.providerOptions).toEqual({ kimiApiMode: 'coding-plan', kimiRegion: 'cn' })
  })
})
