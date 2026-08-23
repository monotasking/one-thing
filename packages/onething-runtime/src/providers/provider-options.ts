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

import {
  ONETHING_KIMI_PROVIDER_ID,
  normalizeOnethingKimiApiMode,
  normalizeOnethingKimiRegion,
} from './kimi.js'
import {
  ONETHING_QWEN_PROVIDER_ID,
  normalizeOnethingQwenApiMode,
  normalizeOnethingQwenRegion,
} from './qwen.js'
import type { OnethingZhipuApiMode } from './zhipu.js'

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

export const ONETHING_ZHIPU_PROVIDER_ID = 'zhipu'

function normalizeZhipuApiMode(value: unknown): OnethingZhipuApiMode | undefined {
  return value === 'coding-plan' || value === 'standard' ? value : undefined
}

/**
 * The single place that knows which providers have private knobs and what the
 * stored fields are called. Returns undefined when a provider has none, so the
 * common case adds no key to the runtime config.
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
  const carried = request ? { [ONETHING_PROVIDER_REQUEST_OPTIONS_KEY]: request } : undefined

  if (providerId === ONETHING_ZHIPU_PROVIDER_ID) {
    const zhipuApiMode = normalizeZhipuApiMode(storedConfig.zhipuApiMode)
    if (!zhipuApiMode) return carried
    return { ...carried, zhipuApiMode }
  }

  if (providerId === ONETHING_QWEN_PROVIDER_ID) {
    // Both normalizers fall back to a default rather than returning undefined,
    // so qwen always gets a bag — its endpoint depends on the pair.
    return {
      ...carried,
      qwenApiMode: normalizeOnethingQwenApiMode(storedConfig.qwenApiMode),
      qwenRegion: normalizeOnethingQwenRegion(storedConfig.qwenRegion),
    }
  }

  if (providerId === ONETHING_KIMI_PROVIDER_ID) {
    // Same shape as qwen: the endpoint is a lookup on the pair, so the bag is
    // always present and always complete.
    return {
      ...carried,
      kimiApiMode: normalizeOnethingKimiApiMode(storedConfig.kimiApiMode),
      kimiRegion: normalizeOnethingKimiRegion(storedConfig.kimiRegion),
    }
  }

  return carried
}

/** Unpack + narrow, for the zhipu factory. */
export function readOnethingZhipuOptions(
  providerOptions: OnethingProviderOptions | undefined,
): { zhipuApiMode?: OnethingZhipuApiMode } {
  const zhipuApiMode = normalizeZhipuApiMode(providerOptions?.zhipuApiMode)
  return zhipuApiMode ? { zhipuApiMode } : {}
}

/** Unpack + narrow, for the kimi factory. */
export function readOnethingKimiOptions(
  providerOptions: OnethingProviderOptions | undefined,
): {
  kimiApiMode: ReturnType<typeof normalizeOnethingKimiApiMode>
  kimiRegion: ReturnType<typeof normalizeOnethingKimiRegion>
} {
  return {
    kimiApiMode: normalizeOnethingKimiApiMode(providerOptions?.kimiApiMode),
    kimiRegion: normalizeOnethingKimiRegion(providerOptions?.kimiRegion),
  }
}

/** Unpack + narrow, for the qwen factory. */
export function readOnethingQwenOptions(
  providerOptions: OnethingProviderOptions | undefined,
): { qwenApiMode: ReturnType<typeof normalizeOnethingQwenApiMode>; qwenRegion: ReturnType<typeof normalizeOnethingQwenRegion> } {
  return {
    qwenApiMode: normalizeOnethingQwenApiMode(providerOptions?.qwenApiMode),
    qwenRegion: normalizeOnethingQwenRegion(providerOptions?.qwenRegion),
  }
}
