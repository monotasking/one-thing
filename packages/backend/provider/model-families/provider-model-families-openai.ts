/**
 * OpenAI **型号家族**的知识(`docs/design/architecture-direction-2026-10.md` §4 P2「模型家族 ≠ 服务商」)。
 *
 * 这里说的是「gpt-5.x / o 系列这个型号的思考档位有哪几格、收不收 `none`、`input_image.detail` 收不收
 * `original`」—— 与哪一家在卖它无关:官方 `openai`、接口类型为 openai 的自定义服务商(借 openai 那张
 * 规则表)、openai-effort 线型(`thinking/provider-thinking-openai-effort.ts`)都按这里判。所以它不住 `vendors/openai/`
 * (那里只放只属于官方那一家的东西),而住在模型家族的家。
 *
 * 纯模块:只 import 类型(不许成环 —— `provider-model-capability.ts` 经 manifest 注册表间接读到这里)。
 * 内容从 `provider-model-capability.ts` 逐字搬来(服务商自述试点 P2 第 4 批)。
 */
import type {
  OnethingReasoningEffortOption,
  OnethingReasoningProfile,
} from '../provider-model-capability.js'
import type { OnethingModelContextLengthHint } from './provider-model-families-types.js'

/**
 * OpenAI 的档位表**逐代不同**(拍板 #14,官方各模型页「Reasoning.effort
 * supports」一句 + `/docs/guides/reasoning`「Supported values are
 * model-dependent」,2026-08-23 核):
 *
 * | 模型 | 档位 | 服务端默认 |
 * |---|---|---|
 * | o 系列(o1 / o3 / o4…) | low / medium / high | 未核,沿用今天的 medium |
 * | gpt-5(5.0,含 -mini / -nano) | minimal / low / medium / high | 未核,沿用今天的 medium |
 * | gpt-5.1 / 5.2 / 5.3 | none / low / medium / high | 未核,沿用今天的 medium |
 * | gpt-5.4 | none / low / medium / high / xhigh | **none**(官方逐字) |
 * | gpt-5.5 | none / low / medium / high / xhigh | medium(官方逐字) |
 * | gpt-5.6 及以后 | none / low / medium / high / xhigh / max | medium(官方逐字) |
 *
 * `'none'` 在 `efforts` 里是**线协议能力标记**而不是 picker 的一档(见
 * `OnethingReasoningEffortOption`),所以 gpt-5.4 的「默认不想」记在
 * `defaultOn: false` 上,不记在 `defaultEffort` 上 —— 后者的类型本身就排除
 * `'none'`。
 */
export const ONETHING_OPENAI_O_SERIES_EFFORTS = ['low', 'medium', 'high'] as const
/** gpt-5.0 家(含 -mini / -nano):`minimal` 只有这一代有,`none` 还没有。 */
export const ONETHING_OPENAI_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const
/**
 * gpt-5.1 and later add `reasoning_effort: 'none'` — the only way to tell an
 * OpenAI reasoning model not to think (the family still has no `thinking`
 * toggle). Older members (gpt-5 / gpt-5.0, the whole o-series) reject it, so
 * they keep the four-rung table above and send nothing when thinking is off.
 *
 * 同一代起 `minimal` 从官方档位表里消失(5.1+ 的模型页都不再列它),所以这份
 * 表不是「四档 + none」而是「三档 + none」。
 */
export const ONETHING_OPENAI_EFFORTS_WITH_NONE = [
  'none',
  'low',
  'medium',
  'high',
] as const
/** gpt-5.4 / 5.5:官方多一档 `xhigh`。 */
export const ONETHING_OPENAI_EFFORTS_WITH_XHIGH = [
  ...ONETHING_OPENAI_EFFORTS_WITH_NONE,
  'xhigh',
] as const
/** gpt-5.6 及以后:再多一档 `max`。 */
export const ONETHING_OPENAI_EFFORTS_WITH_MAX = [
  ...ONETHING_OPENAI_EFFORTS_WITH_XHIGH,
  'max',
] as const

const OPENAI_PROFILE: OnethingReasoningProfile = {
  // o-series / gpt-5 reasoning cannot be turned off — only the effort is
  // configurable, so the UI must not offer a (fake) Off.
  toggleable: false,
  defaultOn: true,
  efforts: ONETHING_OPENAI_EFFORTS,
  defaultEffort: 'medium',
  wire: 'openai-effort',
}

/**
 * The gpt-5 family's minor version, tolerating a "vendor/" path prefix like
 * every other row here. `gpt-5` / `gpt-5-mini` / `gpt-5-nano` / `gpt-5.0` all
 * read 0; `gpt-5.5` reads 5; `gpt-5.10` reads 10 (whole number, so it sorts
 * after `gpt-5.6` rather than between 5.1 and 5.2). Anything that is not a
 * gpt-5 id (the o-series, gpt-4.1, …) reads `undefined`.
 */
const OPENAI_GPT5_PATTERN = /(?:^|\/)gpt-5(?:\.(\d+))?/

function openAIGpt5Minor(modelLower: string): number | undefined {
  const match = modelLower.match(OPENAI_GPT5_PATTERN)
  if (!match) return undefined
  return match[1] ? Number(match[1]) : 0
}

/**
 * gpt-5.1 and later take `reasoning_effort: 'none'`; `gpt-5` / `gpt-5.0` and
 * the whole o-series do not. The single judge behind `OpenAIEffortWire`'s
 * "can this model be told not to think at all" question.
 */
export function onethingOpenAIAcceptsNoneEffort(model: string): boolean {
  const minor = openAIGpt5Minor(model.toLowerCase())
  return minor !== undefined && minor >= 1
}

/**
 * `input_image.detail: 'original'` —— 官方 `/docs/guides/images-vision`:
 * 「Available on `gpt-5.4` and future models」(且「On `gpt-5.5` and GPT-5.6
 * models, `auto` and the omitted/default behavior are equivalent to
 * `original`」)。值域是**按模型**开的,所以判据放在账本这一份名字表里,由
 * openai 方言在取袋时问一次(见 `wires/provider-wires-openai-responses-options.ts`)。
 */
export function onethingOpenAIAcceptsOriginalImageDetail(model: string): boolean {
  const minor = openAIGpt5Minor(model.toLowerCase())
  return minor !== undefined && minor >= 4
}

/** 见 `ONETHING_OPENAI_EFFORTS` 抬头那张按代分档的表。 */
function openAIEffortsForMinor(minor: number): readonly OnethingReasoningEffortOption[] {
  if (minor === 0) return ONETHING_OPENAI_EFFORTS
  if (minor <= 3) return ONETHING_OPENAI_EFFORTS_WITH_NONE
  if (minor <= 5) return ONETHING_OPENAI_EFFORTS_WITH_XHIGH
  return ONETHING_OPENAI_EFFORTS_WITH_MAX
}

/** o1 / o3 / o4:官方模型页只列 low / medium / high(没有 minimal,没有 none)。 */
const OPENAI_O_SERIES_PROFILE: OnethingReasoningProfile = {
  ...OPENAI_PROFILE,
  efforts: ONETHING_OPENAI_O_SERIES_EFFORTS,
}

/** OpenAI 型号的思考档案(按代分档;o 系列一张表)。规则表那一行的 `profile`。 */
export function onethingOpenAIReasoningProfile(model: string): OnethingReasoningProfile {
  const minor = openAIGpt5Minor(model.toLowerCase())
  if (minor === undefined) return OPENAI_O_SERIES_PROFILE
  return {
    ...OPENAI_PROFILE,
    efforts: openAIEffortsForMinor(minor),
    // gpt-5.4 的服务端默认是 `none` —— 不发参数 = 不思考。这一格记的是
    // 「什么都不发时服务端怎么办」,与 `toggleable: false`(这一家永远没有
    // UI 上的 Off 开关)不冲突:前者是事实,后者是控件。
    ...(minor === 4 ? { defaultOn: false } : {}),
  }
}

// ---------------------------------------------------------------------------
// 列表口没给说明 / 上下文长度时的型号常识(从 `vendors/github-copilot/github-copilot-models.ts` 的
// `getCopilotModelDescription` 与 `detectCopilotModelCapabilities` 搬来,逐字;P2 第 4 批)
// ---------------------------------------------------------------------------

export const ONETHING_OPENAI_MODEL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'gpt-4o': 'Most capable OpenAI model',
  'gpt-4o-mini': 'Fast and affordable',
  'gpt-4.1': 'Latest GPT-4 update',
  'gpt-4-turbo': 'GPT-4 Turbo with vision',
  'o1': 'Deep reasoning model',
  'o1-mini': 'Reasoning, cost-effective',
  'o1-preview': 'Reasoning preview',
  'o3': 'Advanced reasoning',
  'o3-mini': 'Advanced reasoning, fast',
  'o4-mini': 'Latest reasoning, fast',
}

/** gpt 系列那几行 —— 汇总时排在**最前**(`gpt-4o` 先于一切)。 */
export const ONETHING_OPENAI_GPT_CONTEXT_LENGTH_HINTS: readonly OnethingModelContextLengthHint[] = [
  { includes: ['gpt-4o'], contextLength: 128000 },
  { includes: ['gpt-4-turbo'], contextLength: 128000 },
  { includes: ['gpt-4.1'], contextLength: 1000000 },
]

/** o 系列那一行 —— 汇总时排在**最后**(`o1` / `o3` 是很短的片段,排前面会抢走别家的 id)。 */
export const ONETHING_OPENAI_O_SERIES_CONTEXT_LENGTH_HINTS: readonly OnethingModelContextLengthHint[] = [
  { includes: ['o1', 'o3'], contextLength: 200000 },
]
