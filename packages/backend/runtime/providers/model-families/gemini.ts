/**
 * Gemini **型号家族**的知识(`docs/design/architecture-direction-2026-10.md` §4 P2「模型家族 ≠ 服务商」)。
 *
 * 「gemini 2.5 收数值预算、3.x 收档位名、每一代接受哪几档」说的是型号,不是哪一家服务商:
 * gemini-generateContent 线上的思考线型(`thinking/gemini-thinking.ts`,自定义服务商的
 * gemini 适配表也走它)与官方 `gemini` 那一家的型号规则表都读这里。
 *
 * 纯模块:只 import 类型(不许成环)。内容从 `model-capability.ts` 与 `model-registry.ts` 逐字搬来
 * (服务商自述试点 P2 第 2 批)。
 */
import type { OnethingReasoningProfile, OnethingReasoningWire } from '../model-capability.js'
import type { OnethingModelContextLengthHint } from './types.js'

/** 型号的展示名别称(目录里的名字太长或不是大家叫的那个)。从 `model-registry.ts` 逐字搬来。 */
export const ONETHING_GEMINI_MODEL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  'gemini-2.5-flash-image': 'Nano-Banana',
  'gemini-2.5-flash-image-preview': 'Nano-Banana Preview',
}

export const ONETHING_GEMINI_EFFORTS = ['low', 'medium', 'high'] as const

/** Gemini 2.5 has no named levels — approximate the abstract scale with budgets. */
export const ONETHING_GEMINI_THINKING_BUDGETS: Record<'minimal' | 'low' | 'medium' | 'high', number> = {
  minimal: 512,
  low: 2048,
  medium: 8192,
  high: 24576,
}

/**
 * Thinking levels each Gemini generation actually accepts (per the thinking
 * docs): 3-pro takes only low/high, 3.1-pro adds medium, flash tiers add
 * minimal, flash-lite-image is minimal/high only. 2.5 uses numeric budgets, so
 * the standard three tiers apply.
 */
export function onethingGeminiThinkingLevels(
  model: string,
): readonly ('minimal' | 'low' | 'medium' | 'high')[] {
  const lower = model.toLowerCase()
  if (lower.includes('flash-lite-image')) return ['minimal', 'high']
  if (lower.includes('3.1-pro')) return ['low', 'medium', 'high']
  if (/gemini-3-pro/.test(lower)) return ['low', 'high']
  if (lower.includes('2.5')) return ONETHING_GEMINI_EFFORTS
  if (/gemini-(?:3|[4-9])/.test(lower)) return ['minimal', 'low', 'medium', 'high']
  return ONETHING_GEMINI_EFFORTS
}

/**
 * 2.5 takes numeric budgets, everything else takes named levels. Same single
 * `includes('2.5')` judgement the gemini wire used to keep for itself.
 */
export function onethingGeminiReasoningWire(model: string): OnethingReasoningWire {
  return model.toLowerCase().includes('2.5') ? 'gemini-budget' : 'gemini-level'
}

/** Gemini 型号的思考档案(型号规则表的 `profile` 读它)。 */
export function onethingGeminiReasoningProfile(model: string): OnethingReasoningProfile {
  return {
    toggleable: true,
    defaultOn: true,
    efforts: onethingGeminiThinkingLevels(model),
    defaultEffort: 'high',
    wire: onethingGeminiReasoningWire(model),
  }
}

// ---------------------------------------------------------------------------
// 列表口没给说明 / 上下文长度时的型号常识(从 `vendors/github-copilot/models.ts` 搬来,逐字;P2 第 4 批)
// ---------------------------------------------------------------------------

export const ONETHING_GEMINI_MODEL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'gemini-1.5-pro': 'Google Gemini 1.5 Pro',
  'gemini-2.0-flash': 'Google Gemini 2.0 Flash',
  'gemini-2.0-flash-001': 'Google Gemini 2.0 Flash',
}

export const ONETHING_GEMINI_CONTEXT_LENGTH_HINTS: readonly OnethingModelContextLengthHint[] = [
  { includes: ['gemini-1.5-pro'], contextLength: 2000000 },
  { includes: ['gemini-2'], contextLength: 1000000 },
]
