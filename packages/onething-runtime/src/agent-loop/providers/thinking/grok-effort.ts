/** xAI effort policy shared by the Responses and legacy Chat transports. */
import {
  clampOnethingReasoningEffort,
  resolveOnethingModelCapabilities,
  type OnethingReasoningProfile,
} from '../../../providers/model-capability.js'
import type { RequestBodyBuilder, TurnContext } from '../base/index.js'
import { OpenAIChatThinkingWire } from './openai-chat-thinking-wire.js'

export function clampGrokReasoningEffort(effort: string | undefined, model: string): string | undefined {
  const profile = resolveOnethingModelCapabilities({ providerId: 'grok', modelId: model }).reasoningProfile
  return profile?.efforts.length ? clampOnethingReasoningEffort(effort, profile) : undefined
}

/** Models without a documented effort knob must never receive one. */
export function grokReasoningEffortFor(turn: TurnContext): string | undefined {
  const profile: OnethingReasoningProfile | undefined = turn.profile.reasoningProfile
  if (!profile || !profile.efforts.length) return undefined
  const { thinking, reasoningEffort } = turn.request
  if (thinking === 'disabled') {
    if (profile.toggleable && profile.efforts.includes('none')) return 'none'
    // Legacy 'off' on an always-on Grok now means its explicit lowest tier.
    return profile.disabledEffort ? clampOnethingReasoningEffort(profile.disabledEffort, profile) : undefined
  }
  if (thinking !== 'enabled') return undefined
  const effort = clampOnethingReasoningEffort(reasoningEffort, profile)
  if (reasoningEffort !== undefined && reasoningEffort !== effort) {
    turn.warn('setting-clamped', 'reasoning effort was clamped to a level this xAI model accepts', { requested: reasoningEffort, sent: effort })
  }
  return effort
}

export class GrokEffortWire extends OpenAIChatThinkingWire {
  readonly id = 'grok-effort'
  encode(turn: TurnContext, builder: RequestBodyBuilder): void {
    const effort = grokReasoningEffortFor(turn)
    if (effort !== undefined) builder.set('reasoning_effort', effort)
  }
}

export const grokEffortWire = new GrokEffortWire()
