/**
 * xAI 的思考参数(`grok` / `grok-oauth` 两条通路共用):档位策略一份,两条线型各拼各的。
 *
 *  - `GrokEffortWire`(id `'grok-effort'`,chat-completions 的顶层 `reasoning_effort`):登记进进程级
 *    `thinkingWires`(经 `GROK_RUNTIME.thinkingWires`),`provider-openai-compatible.ts` 的构造门面按
 *    `reasoningStyle: 'grok-effort'` 取它;
 *  - `GrokResponsesReasoningWire`(同 id,Responses 的 `reasoning.effort` + 恒发 `include`):只挂在
 *    这家的方言配方上(`GROK_RESPONSES_THINKING_WIRES`),从来不进全局表。
 *
 * 服务商自述试点 P2 第 4 批从 `providers/thinking/{grok-effort,grok-responses-reasoning}.ts`
 * 搬回家(两条线型只服务这一家)。
 *
 * xAI effort policy shared by the Responses and legacy Chat transports.
 */
import {
  clampOnethingReasoningEffort,
  resolveOnethingModelCapabilities,
  type OnethingReasoningProfile,
} from '../../provider-model-capability.js'
import type { RequestBodyBuilder, ThinkingWire, TurnContext } from '../../base/provider-base.js'
import { OpenAIChatThinkingWire } from '../../thinking/provider-thinking-openai-chat-wire.js'
import {
  RESPONSES_ENCRYPTED_REASONING_INCLUDE,
  RESPONSES_INCLUDE_PATH,
  RESPONSES_REASONING_PATH,
} from '../../thinking/provider-thinking-responses-reasoning.js'

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

/**
 * xAI Responses reasoning. Supported tiers come only from provider-model-capability.ts.
 * Checked against https://docs.x.ai/developers/model-capabilities/text/reasoning
 * and model-specific 4.3 docs, 2026-09-16. 4.5/4.6 cannot disable reasoning;
 * their old disabled setting is represented by low, never a silent high default.
 */
export interface GrokResponsesReasoningOptions {
  effort: string
}

export class GrokResponsesReasoningWire implements ThinkingWire {
  readonly id = 'grok-effort'
  encode(turn: TurnContext, builder: RequestBodyBuilder): void {
    builder.set(RESPONSES_INCLUDE_PATH, [RESPONSES_ENCRYPTED_REASONING_INCLUDE])
    const effort = grokReasoningEffortFor(turn)
    if (effort !== undefined) builder.set(RESPONSES_REASONING_PATH, { effort })
  }
}

export const grokResponsesReasoningWire = new GrokResponsesReasoningWire()
export const GROK_RESPONSES_THINKING_WIRES: ThinkingWire[] = [grokResponsesReasoningWire]
