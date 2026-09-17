import { clampOnethingReasoningEffort } from '../../../providers/model-capability.js'
import type { RequestBodyBuilder } from '../base/request-body-builder.js'
import type { ThinkingWire } from '../base/thinking-wire.js'
import type { TurnContext } from '../base/turn-context.js'

/** A declarative encoder for compatible endpoints with provider-specific knobs. */
export const customReasoningWire: ThinkingWire = {
  id: 'custom',
  encode(turn: TurnContext, builder: RequestBodyBuilder): void {
    const profile = turn.profile.reasoningProfile
    const config = profile?.custom
    if (!profile || !config) return
    const enabled = !profile.toggleable || (turn.request.thinking === undefined
      ? profile.defaultOn
      : turn.request.thinking === 'enabled')
    const patch = enabled ? config.enabledBody : config.disabledBody
    // The builder may descend into this object when setting effortPath. Clone
    // configured values so consecutive turns never mutate persisted settings.
    for (const [field, value] of Object.entries(patch ?? {})) builder.set(field, structuredClone(value))
    if (!enabled) {
      if (config.disabledValue !== undefined) builder.set(config.effortPath, config.disabledValue)
      return
    }
    if (!profile.efforts.some(level => level !== 'none')) return
    const requested = turn.request.thinking === 'disabled' ? profile.disabledEffort ?? profile.defaultEffort : turn.request.reasoningEffort
    const effort = clampOnethingReasoningEffort(requested, profile)
    builder.set(config.effortPath, config.effortValues?.[effort] ?? effort)
  },
}
