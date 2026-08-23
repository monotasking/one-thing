/**
 * 「用户意图 → thinking/effort」的归一化。
 *
 * P2-a 起这里**只剩通用规则**:各家的家规(Kimi 的三族模型)住在自己的方言
 * 配方里(`Dialect.thinkingIntent`),这个函数问注册表,问不到才走通用。
 *
 * `./dialects/index.js` 是**副作用 import**:它一加载就把 16 份配方登记进
 * `registerDialect` 的注册表。少了这一句,单独 import 本文件的调用方(测试就是
 * 这么用的)会问到一张空表,家规静默失效。
 */
import "./dialects/index.js";
import { getDialect } from "./base/index.js";

export interface OnethingAgentLoopThinkingProviderConfig {
  model: string
  thinkingByModel?: Record<string, boolean | undefined>
  thinkingEffortByModel?: Record<string, unknown>
}

export interface OnethingAgentLoopThinkingContext {
  providerId: string
  providerConfig: OnethingAgentLoopThinkingProviderConfig
}

export type OnethingAgentLoopReasoningEffort =
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'

export interface OnethingAgentLoopThinkingOptions {
  thinking?: 'enabled' | 'disabled'
  reasoningEffort?: OnethingAgentLoopReasoningEffort
}

const EFFORT_VALUES: readonly OnethingAgentLoopReasoningEffort[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

export function normalizeAgentLoopReasoningEffort(
  value: unknown,
): OnethingAgentLoopReasoningEffort | undefined {
  return EFFORT_VALUES.includes(value as OnethingAgentLoopReasoningEffort)
    ? (value as OnethingAgentLoopReasoningEffort)
    : undefined
}

export function normalizeDeepSeekReasoningEffort(value: unknown): 'high' | 'max' | undefined {
  return value === 'max' ? 'max' : value === 'high' ? 'high' : undefined
}

/**
 * Generic user-intent resolution: `thinkingByModel` decides on/off,
 * `thinkingEffortByModel` carries the abstract effort. The provider request
 * builders own the wire format (Anthropic thinking/output_config, OpenAI
 * reasoning_effort, Gemini thinkingConfig, …) and only emit parameters their
 * API accepts, so an unset toggle never changes the request.
 */
function getGenericThinkingOptions(
  config: OnethingAgentLoopThinkingProviderConfig,
): OnethingAgentLoopThinkingOptions {
  const model = config.model
  const enabled = config.thinkingByModel?.[model]
  if (enabled === false) return { thinking: 'disabled' }
  if (enabled !== true) return {}
  return {
    thinking: 'enabled',
    reasoningEffort: normalizeAgentLoopReasoningEffort(config.thinkingEffortByModel?.[model]),
  }
}

export function getOnethingAgentLoopThinkingOptions(
  ctx: OnethingAgentLoopThinkingContext,
): OnethingAgentLoopThinkingOptions {
  // 先问这家的方言配方有没有家规;没有(或压根没这份配方)才走通用规则。
  const intent = getDialect(ctx.providerId)?.thinkingIntent?.(
    ctx.providerConfig,
    ctx.providerConfig.model,
  )
  return intent ?? getGenericThinkingOptions(ctx.providerConfig)
}
