/**
 * 智谱的地址与档位:按量(Standard)与编程套餐(Coding Plan)两个地址,没有地区。
 *
 * 纯模块(壳经 manifest 也会走到这里)。
 */
import { normalizeProviderBaseUrl } from '../../base-url.js'

export type OnethingZhipuApiMode = 'standard' | 'coding-plan'

export const ONETHING_ZHIPU_STANDARD_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4'
export const ONETHING_ZHIPU_CODING_PLAN_BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4'

export interface OnethingZhipuBaseUrlConfig {
  baseUrl?: string
  zhipuApiMode?: OnethingZhipuApiMode
}

/** 只认两个合法值;其余 = 没选(与「缺席」同一个答案)。 */
export function normalizeOnethingZhipuApiMode(value: unknown): OnethingZhipuApiMode | undefined {
  return value === 'coding-plan' || value === 'standard' ? value : undefined
}

function isKnownZhipuBaseUrl(value: string | undefined): boolean {
  const normalized = normalizeProviderBaseUrl(value)
  return normalized === ONETHING_ZHIPU_STANDARD_BASE_URL ||
    normalized === ONETHING_ZHIPU_CODING_PLAN_BASE_URL
}

/**
 * 档位选了、而地址是空的或是我们自己的那两个之一 → 档位说了算;用户手填的地址永远赢。
 */
export function resolveOnethingZhipuBaseUrl(
  config: OnethingZhipuBaseUrlConfig | undefined,
): string {
  const baseUrl = normalizeProviderBaseUrl(config?.baseUrl)
  const mode = config?.zhipuApiMode

  if (mode === 'coding-plan' && (!baseUrl || isKnownZhipuBaseUrl(baseUrl))) {
    return ONETHING_ZHIPU_CODING_PLAN_BASE_URL
  }
  if (mode === 'standard' && (!baseUrl || isKnownZhipuBaseUrl(baseUrl))) {
    return ONETHING_ZHIPU_STANDARD_BASE_URL
  }

  return baseUrl || ONETHING_ZHIPU_STANDARD_BASE_URL
}

/** 存档配置 → `providerOptions` 里的档位格;没选就不带(与搬家前逐字同口径)。 */
export function pickOnethingZhipuOptions(
  stored: Record<string, unknown>,
): { zhipuApiMode: OnethingZhipuApiMode } | undefined {
  const zhipuApiMode = normalizeOnethingZhipuApiMode(stored.zhipuApiMode)
  return zhipuApiMode ? { zhipuApiMode } : undefined
}
