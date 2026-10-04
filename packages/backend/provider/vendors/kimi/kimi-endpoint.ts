/**
 * Kimi / Moonshot AI — endpoint matrix.
 *
 * Two axes, but they are **not** symmetric, and that asymmetry is the whole
 * reason this file exists rather than a single toggle:
 *
 *   - region: 国内 (platform.moonshot.cn, `https://api.moonshot.cn/v1`) vs 海外
 *     (platform.moonshot.ai, `https://api.moonshot.ai/v1`). Separate accounts,
 *     separate keys, separate catalogs — the same pattern as 千问.
 *   - api mode: pay-as-you-go on the 开放平台 above, vs **Kimi Code**
 *     (编程套餐) — a subscription that issues its own key and lives on its own
 *     host, `https://api.kimi.com/coding/v1`. That host is global: the vendor
 *     ships exactly three platforms (Kimi Code / moonshot.cn / moonshot.ai),
 *     so the coding-plan row collapses across regions instead of doubling.
 *
 * Why the mode has to be an explicit choice rather than "just edit the URL":
 * a subscription key sent to the pay-as-you-go host 401s, and the reverse is
 * worse than an error — the general key on the general host silently bills
 * per-token **on top of** the subscription the user already paid for. Same
 * hazard 千问 documents; same remedy.
 *
 * 纯模块(壳经 manifest 也会走到这里):服务商自述试点 P2 从 `providers/kimi.ts` 搬回家。
 * 编程套餐那一半的目录键与缺省模型住在 `vendors/kimi-code/kimi-code-manifest.ts`(那是它的事实)。
 */
import { normalizeProviderBaseUrl } from '../../base-url.js'

export type OnethingKimiApiMode = 'standard' | 'coding-plan'
export type OnethingKimiRegion = 'cn' | 'intl'

export const ONETHING_KIMI_PROVIDER_ID = 'kimi'

export const ONETHING_KIMI_STANDARD_CN_BASE_URL = 'https://api.moonshot.cn/v1'
export const ONETHING_KIMI_STANDARD_INTL_BASE_URL = 'https://api.moonshot.ai/v1'
/**
 * Kimi Code (编程套餐). One address for both regions — not an omission: the
 * subscription is sold on api.kimi.com, which has no 国内/海外 split. Writing a
 * second, region-suffixed constant here would be inventing a host.
 */
export const ONETHING_KIMI_CODING_PLAN_BASE_URL = 'https://api.kimi.com/coding/v1'

export const ONETHING_KIMI_DEFAULT_BASE_URL = ONETHING_KIMI_STANDARD_CN_BASE_URL

export interface OnethingKimiEndpointConfig {
  baseUrl?: string
  kimiApiMode?: OnethingKimiApiMode
  kimiRegion?: OnethingKimiRegion
}

const KIMI_BASE_URLS: Record<
  OnethingKimiApiMode,
  Record<OnethingKimiRegion, string>
> = {
  standard: {
    cn: ONETHING_KIMI_STANDARD_CN_BASE_URL,
    intl: ONETHING_KIMI_STANDARD_INTL_BASE_URL,
  },
  // Both cells on purpose: the lookup stays a total function, and the
  // duplication says "region does not move this row" louder than a branch.
  'coding-plan': {
    cn: ONETHING_KIMI_CODING_PLAN_BASE_URL,
    intl: ONETHING_KIMI_CODING_PLAN_BASE_URL,
  },
}

/**
 * models.dev 目录键。**跟着地址走,不是跟着厂商走** —— 三个地址就是三本目录:
 *
 *  - 编程套餐(`api.kimi.com/coding/v1`)是独立的一本 `kimi-for-coding`,
 *    型号名字都不一样(`k3` / `k3-256k` / `kimi-for-coding[-highspeed]`),
 *    而且全部标价 0(月费买的额度,不按 token 计);
 *  - 按量的国内与海外各有一本,型号同名但账户与主机不同。
 *
 * 把套餐接到按量那本上,症状是「模型列表里没有 k3-256k」—— 因为那本里从来没有过
 * 这个 id。这段注释就是为了让下一个人不必再查一遍才知道。
 */
const KIMI_MODELS_DEV_IDS: Record<
  OnethingKimiApiMode,
  Record<OnethingKimiRegion, string>
> = {
  standard: { cn: 'moonshotai-cn', intl: 'moonshotai' },
  // 编程套餐那本目录(models.dev 的 `kimi-for-coding`,它的 `api` 字段正是套餐那个地址)。
  // 与 `vendors/kimi-code/kimi-code-manifest.ts` 的 `ONETHING_KIMI_CODE_MODELS_DEV_ID` 是同一个键。
  'coding-plan': {
    cn: 'kimi-for-coding',
    intl: 'kimi-for-coding',
  },
}

export function normalizeOnethingKimiApiMode(value: unknown): OnethingKimiApiMode {
  return value === 'coding-plan' ? 'coding-plan' : 'standard'
}

export function normalizeOnethingKimiRegion(value: unknown): OnethingKimiRegion {
  return value === 'intl' ? 'intl' : 'cn'
}

export function getOnethingKimiBaseUrl(
  mode: OnethingKimiApiMode,
  region: OnethingKimiRegion,
): string {
  return KIMI_BASE_URLS[mode][region]
}

/** models.dev 目录键:与地址同一张表,查的是同一对键。 */
export function resolveOnethingKimiModelsDevProviderId(
  config: OnethingKimiEndpointConfig | undefined,
): string {
  return KIMI_MODELS_DEV_IDS[
    normalizeOnethingKimiApiMode(config?.kimiApiMode)
  ][normalizeOnethingKimiRegion(config?.kimiRegion)]
}

/** 编程套餐是否受地区影响 —— 不受。设置页据此决定要不要画那一格。 */
export function onethingKimiRegionApplies(mode: OnethingKimiApiMode): boolean {
  return mode === 'standard'
}

function isKnownKimiBaseUrl(value: string): boolean {
  if (!value) return false
  for (const byRegion of Object.values(KIMI_BASE_URLS)) {
    for (const url of Object.values(byRegion)) {
      if (url === value) return true
    }
  }
  return false
}

/**
 * A base URL the user typed by hand always wins — except when it is one of the
 * three addresses we own, in which case the mode/region selects say what it
 * should be (the settings UI writes both, but an older config may carry a
 * stale URL from before a mode switch).
 */
export function resolveOnethingKimiBaseUrl(
  config: OnethingKimiEndpointConfig | undefined,
): string {
  const baseUrl = normalizeProviderBaseUrl(config?.baseUrl)
  if (baseUrl && !isKnownKimiBaseUrl(baseUrl)) return baseUrl

  return getOnethingKimiBaseUrl(
    normalizeOnethingKimiApiMode(config?.kimiApiMode),
    normalizeOnethingKimiRegion(config?.kimiRegion),
  )
}

/** 运行期 `providerOptions` 袋 → 档位与地区(拆袋即校验),只剩本家的运行时工厂用它。 */
export function readOnethingKimiOptions(
  providerOptions: Record<string, unknown> | undefined,
): {
  kimiApiMode: OnethingKimiApiMode
  kimiRegion: OnethingKimiRegion
} {
  return {
    kimiApiMode: normalizeOnethingKimiApiMode(providerOptions?.kimiApiMode),
    kimiRegion: normalizeOnethingKimiRegion(providerOptions?.kimiRegion),
  }
}
