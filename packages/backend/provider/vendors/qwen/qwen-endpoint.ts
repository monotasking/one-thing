/**
 * 千问 AI 平台 (QwenCloud / DashScope) — endpoint matrix.
 *
 * Two orthogonal axes, both of which the platform ships independently:
 *
 *   - region: 国内版 (platform.qianwenai.com, Beijing) vs 海外版
 *     (docs.qwencloud.com, Singapore). Different accounts, different keys,
 *     different model catalogs.
 *   - api mode: pay-as-you-go API key (`sk-ws-…`) vs the Token Plan and Coding
 *     Plan subscriptions, which each issue their OWN key (`sk-sp-…`) AND their
 *     own host. Sending a subscription key to the pay-as-you-go host 401s; the
 *     reverse is worse than an error — per the vendor FAQ, a subscriber who
 *     leaves the general key/URL in place gets silently billed pay-as-you-go on
 *     top of the subscription. Picking the mode here is what prevents that.
 *
 * So the base URL is a 3x2 lookup, not a single default with a toggle.
 *
 * 纯模块(壳经 manifest 也会走到这里):服务商自述试点 P2 从 `providers/qwen.ts` 搬回家。
 */
import { normalizeProviderBaseUrl } from '../../provider-normalize-base-url.js'

export type OnethingQwenApiMode = 'standard' | 'token-plan' | 'coding-plan'
export type OnethingQwenRegion = 'cn' | 'intl'

export const ONETHING_QWEN_PROVIDER_ID = 'qwen'

export const ONETHING_QWEN_STANDARD_CN_BASE_URL =
  'https://dashscope.aliyuncs.com/compatible-mode/v1'
export const ONETHING_QWEN_STANDARD_INTL_BASE_URL =
  'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
export const ONETHING_QWEN_TOKEN_PLAN_CN_BASE_URL =
  'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'
export const ONETHING_QWEN_TOKEN_PLAN_INTL_BASE_URL =
  'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1'
// Coding Plan is the odd one out: its path is plain /v1, not /compatible-mode/v1.
export const ONETHING_QWEN_CODING_PLAN_CN_BASE_URL =
  'https://coding.dashscope.aliyuncs.com/v1'
export const ONETHING_QWEN_CODING_PLAN_INTL_BASE_URL =
  'https://coding-intl.dashscope.aliyuncs.com/v1'

export const ONETHING_QWEN_DEFAULT_BASE_URL = ONETHING_QWEN_STANDARD_CN_BASE_URL
export const ONETHING_QWEN_DEFAULT_MODEL = 'qwen3.7-plus'

export interface OnethingQwenEndpointConfig {
  baseUrl?: string
  qwenApiMode?: OnethingQwenApiMode
  qwenRegion?: OnethingQwenRegion
}

const QWEN_BASE_URLS: Record<
  OnethingQwenApiMode,
  Record<OnethingQwenRegion, string>
> = {
  standard: {
    cn: ONETHING_QWEN_STANDARD_CN_BASE_URL,
    intl: ONETHING_QWEN_STANDARD_INTL_BASE_URL,
  },
  'token-plan': {
    cn: ONETHING_QWEN_TOKEN_PLAN_CN_BASE_URL,
    intl: ONETHING_QWEN_TOKEN_PLAN_INTL_BASE_URL,
  },
  'coding-plan': {
    cn: ONETHING_QWEN_CODING_PLAN_CN_BASE_URL,
    intl: ONETHING_QWEN_CODING_PLAN_INTL_BASE_URL,
  },
}

/**
 * models.dev registry keys. The catalogs genuinely differ — qwen3.8-max only
 * appears under the Token Plan keys, and the CN keys additionally carry the
 * GLM / Kimi / DeepSeek models the platform resells.
 */
const QWEN_MODELS_DEV_IDS: Record<
  OnethingQwenApiMode,
  Record<OnethingQwenRegion, string>
> = {
  standard: { cn: 'alibaba-cn', intl: 'alibaba' },
  'token-plan': {
    cn: 'alibaba-token-plan-cn',
    intl: 'alibaba-token-plan',
  },
  'coding-plan': {
    cn: 'alibaba-coding-plan-cn',
    intl: 'alibaba-coding-plan',
  },
}

export function normalizeOnethingQwenApiMode(value: unknown): OnethingQwenApiMode {
  if (value === 'token-plan' || value === 'coding-plan') return value
  return 'standard'
}

export function normalizeOnethingQwenRegion(value: unknown): OnethingQwenRegion {
  return value === 'intl' ? 'intl' : 'cn'
}

export function getOnethingQwenBaseUrl(
  mode: OnethingQwenApiMode,
  region: OnethingQwenRegion,
): string {
  return QWEN_BASE_URLS[mode][region]
}

function isKnownQwenBaseUrl(value: string): boolean {
  if (!value) return false
  for (const byRegion of Object.values(QWEN_BASE_URLS)) {
    for (const url of Object.values(byRegion)) {
      if (url === value) return true
    }
  }
  return false
}

/**
 * A base URL the user typed by hand always wins — except when it is one of the
 * four addresses we own, in which case the mode/region selects say what it
 * should be (the settings UI writes both, but an older config may carry a
 * stale URL from before a mode switch).
 */
export function resolveOnethingQwenBaseUrl(
  config: OnethingQwenEndpointConfig | undefined,
): string {
  const baseUrl = normalizeProviderBaseUrl(config?.baseUrl)
  if (baseUrl && !isKnownQwenBaseUrl(baseUrl)) return baseUrl

  return getOnethingQwenBaseUrl(
    normalizeOnethingQwenApiMode(config?.qwenApiMode),
    normalizeOnethingQwenRegion(config?.qwenRegion),
  )
}

/** models.dev provider key for the configured region + plan. */
export function resolveOnethingQwenModelsDevProviderId(
  config: OnethingQwenEndpointConfig | undefined,
): string {
  return QWEN_MODELS_DEV_IDS[
    normalizeOnethingQwenApiMode(config?.qwenApiMode)
  ][normalizeOnethingQwenRegion(config?.qwenRegion)]
}

// ---------------------------------------------------------------------------
// Pay-as-you-go backfill
// ---------------------------------------------------------------------------

/**
 * models.dev files the Qwen3.8 flagship only under the Token Plan catalogs;
 * `alibaba` / `alibaba-cn` (pay-as-you-go) still top out at qwen3.7-max, so a
 * plain refresh hides the flagship from anyone not on a subscription. The
 * vendor sells it per-token — its model page lists ¥12/¥36 per 1M — so the
 * absence is an upstream lag, not a capability boundary.
 *
 * These rows fill that gap and NOTHING else: they are only consulted for the
 * pay-as-you-go modes, and only for ids the fetched catalog lacks. The day
 * models.dev adds them, the real entries win and this table goes dead (at
 * which point it can be deleted).
 *
 * Borrowing the sibling Token Plan entry instead was the obvious shortcut and
 * is wrong: those rows price everything at 0 because the plan is a
 * subscription, which would tell the cost ledger the flagship is free.
 * Pricing below is the vendor's own USD list price — it matches the CNY page
 * at a flat 6.0 and matches what models.dev records for the same model on
 * openrouter/vercel.
 */
export interface OnethingQwenBackfillModel {
  id: string
  name: string
  description: string
  release_date: string
  last_updated: string
  reasoning: boolean
  tool_call: boolean
  temperature: boolean
  modalities: { input: string[]; output: string[] }
  limit: { context: number; output: number }
  cost: { input: number; output: number; cache_read: number; cache_write: number }
}

export const ONETHING_QWEN_PAY_AS_YOU_GO_BACKFILL: readonly OnethingQwenBackfillModel[] = [
  {
    id: 'qwen3.8-max',
    name: 'Qwen3.8 Max',
    description:
      '2.4-trillion-parameter MoE flagship for coding, professional work, multimodal understanding, and long-horizon agentic workflows',
    release_date: '2026-08-03',
    last_updated: '2026-08-03',
    reasoning: true,
    tool_call: true,
    temperature: true,
    modalities: { input: ['text', 'image', 'video'], output: ['text'] },
    limit: { context: 1000000, output: 131072 },
    cost: { input: 2, output: 6, cache_read: 0.25, cache_write: 2.5 },
  },
  {
    id: 'qwen3.8-max-preview',
    name: 'Qwen3.8 Max Preview',
    description:
      'Preview Qwen flagship for million-token multimodal reasoning and long-horizon agentic workflows',
    release_date: '2026-07-19',
    last_updated: '2026-07-19',
    reasoning: true,
    tool_call: true,
    temperature: true,
    modalities: { input: ['text', 'image', 'video'], output: ['text'] },
    limit: { context: 1000000, output: 131072 },
    cost: { input: 2, output: 6, cache_read: 0.25, cache_write: 2.5 },
  },
]

/**
 * Only the pay-as-you-go catalogs are short a flagship. Both subscriptions
 * carry their own complete (and deliberately narrower) allowlists — injecting
 * a model the plan does not cover would produce a picker entry that 4xxs.
 */
export function onethingQwenBackfillModels(
  config: OnethingQwenEndpointConfig | undefined,
): readonly OnethingQwenBackfillModel[] {
  return normalizeOnethingQwenApiMode(config?.qwenApiMode) === 'standard'
    ? ONETHING_QWEN_PAY_AS_YOU_GO_BACKFILL
    : []
}

/** 运行期 `providerOptions` 袋 → 档位与地区(拆袋即校验),只剩本家的运行时工厂用它。 */
export function readOnethingQwenOptions(
  providerOptions: Record<string, unknown> | undefined,
): { qwenApiMode: OnethingQwenApiMode; qwenRegion: OnethingQwenRegion } {
  return {
    qwenApiMode: normalizeOnethingQwenApiMode(providerOptions?.qwenApiMode),
    qwenRegion: normalizeOnethingQwenRegion(providerOptions?.qwenRegion),
  }
}
