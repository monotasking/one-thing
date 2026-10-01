/**
 * Provider-private runtime knobs.
 *
 * Some providers have dials nobody else understands: zhipu's coding-plan
 * endpoint, qwen's and kimi's api mode and region. Those used to travel as named fields on
 * every config type between the settings store and the provider factory — nine
 * files had to list `zhipuApiMode` by name just to hand it along, including
 * `packages/core`, which is supposed to be provider-agnostic.
 *
 * The failure mode was not the ugliness. `CoreAgentLoopProviderRuntimeConfigFor`
 * is a `Pick<>` whitelist: a field nobody remembered to add there is dropped
 * silently, typecheck stays green, and you find out on a real machine when the
 * request goes to the wrong endpoint. Same shape as the mergeWithDefaults
 * whitelist that quietly ate `settings.storage`.
 *
 * So the knobs now travel as one opaque bag. Every layer in between forwards
 * `providerOptions` without looking inside; only the owning provider's factory
 * unpacks it, and unpacking is where validation happens. Adding a provider with
 * its own dial touches this file and that provider's factory — nothing else.
 *
 * The stored shape (`settings.ai.providers[id]`) keeps its flat fields: it is a
 * persisted contract, and the settings UI legitimately knows what it is editing.
 * This is the boundary between "what the user saved" and "what the runtime
 * carries". See docs/design/provider-abstraction.md §7.1.
 */

import { getProviderManifest } from './manifest.js'
import { normalizeOnethingReasoningProfileOverride } from './model-capability.js'

/** Opaque to everything between the settings store and the owning factory. */
export type OnethingProviderOptions = Record<string, unknown>

/**
 * The one sub-key of the bag that is NOT a construction dial: request-level
 * knobs, forwarded onto every turn as `AgentTurnRequest.providerOptions[id]`
 * and whitelisted by the owning dialect (P3-3).
 *
 * It has no settings UI on purpose. These are experimental / vendor-private
 * request parameters (OpenAI's `verbosity`, `image_url.detail`); a user who
 * wants one hand-edits `settings.json`:
 *
 *   "openai": { "providerOptions": { "request": { "verbosity": "low" } } }
 *
 * Unlike the dials around it, this sub-key IS persisted — it is the user's own
 * writing, so it must survive the stored → runtime hop below verbatim.
 */
export const ONETHING_PROVIDER_REQUEST_OPTIONS_KEY = 'request'

function readStoredRequestOptions(
  storedConfig: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const bag = storedConfig.providerOptions
  if (!bag || typeof bag !== 'object' || Array.isArray(bag)) return undefined
  const request = (bag as Record<string, unknown>)[ONETHING_PROVIDER_REQUEST_OPTIONS_KEY]
  if (!request || typeof request !== 'object' || Array.isArray(request)) return undefined
  return request as Record<string, unknown>
}

/** Unpack the request-level sub-bag, for the turn-request builder. */
export function readOnethingRequestProviderOptions(
  providerOptions: OnethingProviderOptions | undefined,
): Record<string, unknown> {
  const request = providerOptions?.[ONETHING_PROVIDER_REQUEST_OPTIONS_KEY]
  return request && typeof request === 'object' && !Array.isArray(request)
    ? (request as Record<string, unknown>)
    : {}
}

/**
 * The per-turn request bag (`AgentTurnRequest.providerOptions`) for one provider:
 * the request half of that provider's own config, under that provider's id.
 *
 * One formula, two callers: the turn-request builder (the provider the run starts
 * with) and credential rotation (the provider a failed turn is handed to — a
 * subscription that ran dry relays to the same vendor's API half, and that half
 * has its own knobs under its own key). Keyed by the provider that will actually
 * receive the request, because each provider reads only its own slot.
 */
export function buildOnethingRequestProviderOptionsBag(
  providerId: string,
  providerOptions: OnethingProviderOptions | undefined,
): Record<string, Record<string, unknown>> {
  return { [providerId]: readOnethingRequestProviderOptions(providerOptions) }
}

/**
 * 存档配置 → 运行期的 `providerOptions`。各家的专属格子(档位 / 地区)由各家 manifest 的
 * `endpoint.pickOptions` 说;没有专属格子的家只带公共的两样(`request` 与
 * `reasoningProfile`),一样都没有就回 `undefined`,常见情况不往运行期配置里加键。
 */
export function pickOnethingProviderOptions(
  providerId: string,
  storedConfig: Record<string, unknown> | undefined,
): OnethingProviderOptions | undefined {
  if (!storedConfig) return undefined

  // The user's own hand-written request knobs ride along with every provider's
  // dials — a provider that has dials would otherwise have its `request` sub-key
  // overwritten by the packed bag below (the failure is silent: the knob simply
  // never reaches the turn).
  const request = readStoredRequestOptions(storedConfig)
  const storedBag = storedConfig.providerOptions
  const reasoningProfile = storedBag && typeof storedBag === 'object' && !Array.isArray(storedBag)
    ? normalizeOnethingReasoningProfileOverride((storedBag as Record<string, unknown>).reasoningProfile)
    : undefined
  if (storedBag && typeof storedBag === 'object' && 'reasoningProfile' in storedBag && storedBag.reasoningProfile !== undefined && !reasoningProfile) {
    throw new Error(`Invalid reasoning profile for provider '${providerId}'`)
  }
  const carried = request || reasoningProfile ? {
    ...(request ? { [ONETHING_PROVIDER_REQUEST_OPTIONS_KEY]: request } : {}),
    ...(reasoningProfile ? { reasoningProfile } : {}),
  } : undefined

  // 有档位的家把「存档里哪几格要跟进请求」写在自己的 manifest 里(`vendors/<id>/`);
  // 这里不认识任何一家。
  const own = getProviderManifest(providerId)?.endpoint?.pickOptions?.(storedConfig)
  if (own) return { ...carried, ...own }
  return carried
}

// 拆袋(把运行期的袋子还原成某一家的档位 / 地区)是那一家运行时工厂的事:各家的
// `read…Options` 住在自己的 `vendors/<id>/endpoint.ts`(服务商自述试点 P2)。
