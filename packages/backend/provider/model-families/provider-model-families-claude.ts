/**
 * Claude **型号家族**的知识(`docs/design/architecture-direction-2026-10.md` §4 P2「模型家族 ≠ 服务商」)。
 *
 * 这里说的是「claude-* 这个型号是哪一代、思考参数怎么拼、档位有哪几格」—— 与哪一家服务商在卖
 * 它无关:官方 `claude`、订阅 `claude-code`、接口类型为 anthropic 的自定义服务商都按这里判,
 * anthropic-messages 线上的思考线型(`thinking/anthropic-*.ts`)与线本身也读它。所以它不住
 * `vendors/claude/`(那里只放只属于官方那一家的东西),而住在模型家族的家。
 *
 * 纯模块:只 import 类型(不许成环 —— `provider-model-capability.ts` 经 manifest 注册表间接读到这里)。
 * 内容从 `provider-model-capability.ts` 逐字搬来(服务商自述试点 P2 第 2 批)。
 */
import type {
  OnethingReasoningEffortLevel,
  OnethingReasoningProfile,
  OnethingReasoningWire,
} from '../provider-model-capability.js'
import type { OnethingModelContextLengthHint } from './provider-model-families-types.js'

// ---------------------------------------------------------------------------
// Claude model families (generation → parameter dialect)
// ---------------------------------------------------------------------------

export interface OnethingClaudeModelFamily {
  /** Fable/Mythos: thinking is always on; the `thinking` param must be omitted. */
  alwaysThinking: boolean
  /** 4.6+ family: `thinking: {type: 'adaptive'}` + `output_config.effort`. */
  adaptive: boolean
  /** xhigh effort exists on 4.7+, Sonnet 5, and Fable/Mythos. */
  supportsXhigh: boolean
  /** 4.7+/Sonnet 5/Fable reject temperature/top_p/top_k outright. */
  samplingRemoved: boolean
}

export function onethingClaudeModelFamily(model: string): OnethingClaudeModelFamily {
  const lower = model.toLowerCase()
  if (/fable|mythos/.test(lower)) {
    return { alwaysThinking: true, adaptive: true, supportsXhigh: true, samplingRemoved: true }
  }
  // Two id shapes, and the legacy one has a trap: "claude-opus-4-6" /
  // "claude-sonnet-5" put the version AFTER the name, while legacy ids like
  // "claude-3-7-sonnet-20250219" put it BEFORE and append an 8-digit release
  // date. Reading the name-first pattern on a legacy id matched
  // "sonnet-20250219" and read major = 20250219, so every dated 3.x model was
  // judged adaptive + modern (#11). Two guards fix it: strip the trailing date
  // first, then try the version-first shape (which is anchored on "claude-<n>"
  // followed by the family name, so it cannot fire on a modern id) before the
  // name-first one.
  const undated = lower.replace(/-\d{8}$/, '')
  const match = undated.match(/claude-(\d+)(?:[-.](\d+))?-(?:opus|sonnet|haiku)/)
    ?? undated.match(/(?:opus|sonnet|haiku)-(\d+)(?:[-.](\d+))?/)
    ?? undated.match(/claude-(\d+)(?:[-.](\d+))?/)
  const major = match ? Number(match[1]) : 0
  const minor = match?.[2] ? Number(match[2]) : 0
  const adaptive = major > 4 || (major === 4 && minor >= 6)
  const modern = major > 4 || (major === 4 && minor >= 7)
  return {
    alwaysThinking: false,
    adaptive,
    supportsXhigh: modern,
    samplingRemoved: modern,
  }
}

export const ONETHING_CLAUDE_EFFORTS = ['low', 'medium', 'high', 'max'] as const

/** Pre-4.6 Claude extended thinking: fixed budget_tokens, min 1024, < max_tokens. */
export const ONETHING_CLAUDE_THINKING_BUDGETS: Record<OnethingReasoningEffortLevel, number> = {
  minimal: 1024,
  low: 4096,
  medium: 8192,
  high: 16384,
  xhigh: 24576,
  max: 32000,
}

/**
 * The one Claude family judgement, shared by the profile and the wire lookup.
 * `onethingClaudeModelFamily` is the only regex — the provider layer used to
 * keep a second copy of this branch inside `AnthropicMessagesWire.thinkingFor`.
 */
export function onethingClaudeReasoningWire(model: string): OnethingReasoningWire {
  const family = onethingClaudeModelFamily(model)
  if (family.alwaysThinking) return 'anthropic-always'
  return family.adaptive ? 'anthropic-adaptive' : 'anthropic-budget'
}

/** Claude 型号的思考档案(型号规则表的 `profile` 读它)。 */
export function onethingClaudeReasoningProfile(model: string): OnethingReasoningProfile {
  const family = onethingClaudeModelFamily(model)
  return {
    toggleable: !family.alwaysThinking,
    // Only Sonnet 5 / Fable run adaptive thinking when the param is omitted.
    defaultOn: family.alwaysThinking || /sonnet-5/.test(model.toLowerCase()),
    efforts: ONETHING_CLAUDE_EFFORTS,
    defaultEffort: 'high',
    wire: onethingClaudeReasoningWire(model),
  }
}

// ---------------------------------------------------------------------------
// 列表口没给说明 / 上下文长度时的型号常识(从 `vendors/github-copilot/github-copilot-models.ts` 搬来,逐字;P2 第 4 批)
// ---------------------------------------------------------------------------

export const ONETHING_CLAUDE_MODEL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'claude-3.5-sonnet': 'Anthropic Claude 3.5 Sonnet',
  'claude-3.7-sonnet': 'Anthropic Claude 3.7 Sonnet',
  'claude-sonnet-4': 'Anthropic Claude Sonnet 4',
}

export const ONETHING_CLAUDE_CONTEXT_LENGTH_HINTS: readonly OnethingModelContextLengthHint[] = [
  { includes: ['claude-3.5', 'claude-3.7'], contextLength: 200000 },
  { includes: ['claude-sonnet-4', 'claude-opus'], contextLength: 200000 },
]
