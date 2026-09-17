/**
 * xAI Responses reasoning. Supported tiers come only from model-capability.ts.
 * Checked against https://docs.x.ai/developers/model-capabilities/text/reasoning
 * and model-specific 4.3 docs, 2026-09-16. 4.5/4.6 cannot disable reasoning;
 * their old disabled setting is represented by low, never a silent high default.
 */
import type { RequestBodyBuilder, ThinkingWire, TurnContext } from '../base/index.js'
import { grokReasoningEffortFor } from './grok-effort.js'
import { RESPONSES_ENCRYPTED_REASONING_INCLUDE, RESPONSES_INCLUDE_PATH, RESPONSES_REASONING_PATH } from './responses-reasoning.js'

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
