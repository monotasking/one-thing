import { clampOnethingReasoningEffort, type OnethingCustomReasoningConfig } from '../model-capability.js'
import type { RequestBodyBuilder } from '../base/request-body-builder.js'
import type { ThinkingWire } from '../base/thinking-wire.js'
import type { TurnContext } from '../base/turn-context.js'

/**
 * The declarative custom mapping itself — shared by the per-model override
 * (`reasoningProfile.custom`, below) and the batch 4 adapter spec
 * (`dialects/custom-from-spec.ts`, whose `request.reasoning` is the same shape).
 *
 * With a ledger profile the behaviour is exactly the per-model override's.
 * Without one (a relay's model the ledger knows nothing about) it follows the
 * request literally: no thinking intent = send nothing, `enabled` = the requested
 * effort (default `high`) through `effortValues`, `disabled` = the off shape.
 */
export function encodeCustomReasoning(
  turn: TurnContext,
  builder: RequestBodyBuilder,
  config: OnethingCustomReasoningConfig,
): void {
  const profile = turn.profile.reasoningProfile
  let enabled: boolean
  if (profile) {
    enabled = !profile.toggleable || (turn.request.thinking === undefined
      ? profile.defaultOn
      : turn.request.thinking === 'enabled')
  } else {
    if (turn.request.thinking === undefined) return
    enabled = turn.request.thinking === 'enabled'
  }
  const patch = enabled ? config.enabledBody : config.disabledBody
  // The builder may descend into this object when setting effortPath. Clone
  // configured values so consecutive turns never mutate persisted settings.
  for (const [field, value] of Object.entries(patch ?? {})) builder.set(field, structuredClone(value))
  if (!enabled) {
    if (config.disabledValue !== undefined) builder.set(config.effortPath, config.disabledValue)
    return
  }
  if (!profile) {
    const effort = turn.request.reasoningEffort ?? 'high'
    builder.set(config.effortPath, config.effortValues?.[effort] ?? effort)
    return
  }
  if (!profile.efforts.some(level => level !== 'none')) return
  const requested = turn.request.thinking === 'disabled' ? profile.disabledEffort ?? profile.defaultEffort : turn.request.reasoningEffort
  const effort = clampOnethingReasoningEffort(requested, profile)
  builder.set(config.effortPath, config.effortValues?.[effort] ?? effort)
}

/** A declarative encoder for compatible endpoints with provider-specific knobs. */
export const customReasoningWire: ThinkingWire = {
  id: 'custom',
  encode(turn: TurnContext, builder: RequestBodyBuilder): void {
    const profile = turn.profile.reasoningProfile
    const config = profile?.custom
    if (!profile || !config) return
    encodeCustomReasoning(turn, builder, config)
  },
}
