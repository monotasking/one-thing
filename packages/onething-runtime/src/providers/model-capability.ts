/**
 * Model capability ledger — the single source of truth for "what can model X
 * do" and "how is its thinking configured".
 *
 * Resolution order, uniform for every capability and every consumer (UI and
 * engine must call this module instead of keeping their own pattern lists):
 *
 *   1. user override        (providerConfig.modelCapabilitiesByModel)
 *   2. registry entry       (models.dev fetch stored in providerConfig.models,
 *                            or the wire-shaped model metadata the renderer holds)
 *   3. built-in rules table (PROVIDER_MODEL_RULES below)
 *   4. provider default
 *
 * Every answer carries its source so tests and debugging can tell where a
 * verdict came from.
 *
 * Inside step 2 there is one sub-rule: a Codex entry/metadata carrying
 * `providerMetadata.codex.nativeTools: ['image_generation']` declares image
 * output regardless of its own `supportsImageOutput` / `output_modalities`
 * (Codex /models never reports output modalities). See
 * `codexMetadataDeclaresImageOutput` below.
 *
 * This module must stay pure (no Node/Electron imports) — the renderer and the
 * web build import it directly.
 */

export type OnethingReasoningEffortLevel =
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'

/** How the thinking intent is expressed on the wire by the owning provider. */
export type OnethingReasoningWire =
  | 'anthropic-adaptive'
  | 'anthropic-budget'
  /** Fable / Mythos: thinking is always on, the `thinking` param is rejected. */
  | 'anthropic-always'
  | 'openai-effort'
  | 'gemini-level'
  | 'gemini-budget'
  | 'thinking-type'
  | 'zhipu-thinking'
  | 'qwen-thinking'
  | 'grok-effort'
  | 'openrouter-reasoning'
  | 'codex'
  | 'none'

export interface OnethingReasoningProfile {
  /** Whether the user can turn thinking off (o-series/grok always reason). */
  toggleable: boolean
  /** Server-side behavior when no parameter is sent. */
  defaultOn: boolean
  /** Levels the UI offers — identical to what the wire accepts after clamping. */
  efforts: readonly OnethingReasoningEffortLevel[]
  defaultEffort: OnethingReasoningEffortLevel
  wire: OnethingReasoningWire
}

export type OnethingCapabilitySource = 'override' | 'registry' | 'pattern' | 'default'

export interface OnethingResolvedModelCapabilities {
  reasoning: boolean
  vision: boolean
  tools: boolean
  imageOutput: boolean
  temperature: boolean
  /**
   * How this model expresses its thinking intent on the wire — answered even
   * when `reasoning` is false, because the wire format is a property of the
   * model family, not of whether thinking happens to be available. This is the
   * single judge `HttpAgentProvider.thinkingFor()` asks (P2-a); before it, each
   * wire kept its own model-name regex.
   */
  reasoningWire: OnethingReasoningWire
  /**
   * Whether a "must call a tool" round is possible. Only present when the
   * rules table has an opinion; absent = the provider's own transport
   * declaration stands (today's behavior: tools ⇒ forced tool use).
   */
  forcedToolUse?: boolean
  source: {
    reasoning: OnethingCapabilitySource
    vision: OnethingCapabilitySource
    tools: OnethingCapabilitySource
    imageOutput: OnethingCapabilitySource
    temperature: OnethingCapabilitySource
  }
  /** Present when reasoning is true. */
  reasoningProfile?: OnethingReasoningProfile
}

/** Per-model override stored in settings (modelCapabilitiesByModel). */
export interface OnethingCapabilityOverrideLike {
  tools?: boolean
  vision?: boolean
  reasoning?: boolean
  imageOutput?: boolean
}

/** Storage-shaped registry entry (models.dev fetch persisted in settings). */
export interface OnethingCapabilityEntryLike {
  supportsTools?: boolean
  supportsVision?: boolean
  supportsReasoning?: boolean
  supportsImageOutput?: boolean
  supportsTemperature?: boolean
  /**
   * `OnethingModelCapabilityEntry.providerMetadata` (a JsonObject) — kept
   * `unknown` here so this module stays import-free; only
   * `codexMetadataDeclaresImageOutput` reads into it.
   */
  providerMetadata?: unknown
}

/** Wire-shaped model metadata (what the renderer's model cache holds). */
export interface OnethingModelMetadataLike {
  supported_parameters?: string[]
  architecture?: {
    input_modalities?: string[]
    output_modalities?: string[]
  }
  providerMetadata?: Record<string, unknown>
}

export interface ResolveOnethingModelCapabilitiesInput {
  providerId: string
  modelId: string
  /** apiType of a custom provider ('custom-*'), when known. */
  customApiType?: 'openai' | 'anthropic'
  override?: OnethingCapabilityOverrideLike
  registryEntry?: OnethingCapabilityEntryLike
  modelMetadata?: OnethingModelMetadataLike
}

// ---------------------------------------------------------------------------
// Provider kinds
// ---------------------------------------------------------------------------

export type OnethingProviderKind =
  | 'claude'
  | 'openai'
  | 'gemini'
  | 'zhipu'
  | 'qwen'
  | 'grok'
  | 'openrouter'
  | 'deepseek'
  | 'kimi'
  | 'codex'
  | 'copilot'
  | 'acp'
  | 'unknown'

export function resolveOnethingProviderKind(
  providerId: string,
  customApiType?: 'openai' | 'anthropic',
): OnethingProviderKind {
  if (providerId === 'claude' || providerId === 'claude-code' || providerId === 'claude-code-agent') return 'claude'
  if (providerId === 'openai') return 'openai'
  if (providerId === 'gemini') return 'gemini'
  if (providerId === 'zhipu') return 'zhipu'
  if (providerId === 'qwen') return 'qwen'
  if (providerId === 'grok' || providerId === 'grok-oauth') return 'grok'
  if (providerId === 'openrouter') return 'openrouter'
  if (providerId === 'deepseek') return 'deepseek'
  if (providerId === 'kimi' || providerId === 'kimi-code') return 'kimi'
  if (providerId === 'codex') return 'codex'
  if (providerId === 'github-copilot') return 'copilot'
  if (providerId === 'acp') return 'acp'
  if (providerId.startsWith('custom-')) {
    return customApiType === 'anthropic' ? 'claude' : 'openai'
  }
  return 'unknown'
}

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
  // "claude-opus-4-6", "claude-sonnet-5" put the version after the name;
  // legacy ids like "claude-3-7-sonnet-20250219" put it before.
  const match = lower.match(/(?:opus|sonnet|haiku)-(\d+)(?:[-.](\d+))?/)
    ?? lower.match(/claude-(\d+)(?:[-.](\d+))?/)
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

// ---------------------------------------------------------------------------
// Shared effort tables and budgets (single copy — UI options, provider clamps,
// and thinking budgets all read from here)
// ---------------------------------------------------------------------------

export const ONETHING_CLAUDE_EFFORTS = ['low', 'medium', 'high', 'max'] as const
export const ONETHING_OPENAI_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const
export const ONETHING_GEMINI_EFFORTS = ['low', 'medium', 'high'] as const
export const ONETHING_GROK_EFFORTS = ['low', 'medium', 'high'] as const
export const ONETHING_OPENROUTER_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export const ONETHING_DEEPSEEK_EFFORTS = ['high', 'max'] as const
/**
 * Qwen3.8-Max is the only Qwen family that takes reasoning_effort, and it
 * accepts exactly low|medium|xhigh (it 400s if thinking_budget is sent too).
 * Every other hybrid Qwen model is budget-driven, so it exposes no effort tier.
 */
export const ONETHING_QWEN_MAX_EFFORTS = ['low', 'medium', 'xhigh'] as const
export const ONETHING_CODEX_FALLBACK_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const

/** Pre-4.6 Claude extended thinking: fixed budget_tokens, min 1024, < max_tokens. */
export const ONETHING_CLAUDE_THINKING_BUDGETS: Record<OnethingReasoningEffortLevel, number> = {
  minimal: 1024,
  low: 4096,
  medium: 8192,
  high: 16384,
  xhigh: 24576,
  max: 32000,
}

/** Gemini 2.5 has no named levels — approximate the abstract scale with budgets. */
export const ONETHING_GEMINI_THINKING_BUDGETS: Record<'minimal' | 'low' | 'medium' | 'high', number> = {
  minimal: 512,
  low: 2048,
  medium: 8192,
  high: 24576,
}

// ---------------------------------------------------------------------------
// Built-in rules table — the ONE place model-name patterns live.
// Row order matters: first match wins. A missing `caps` field falls through to
// the kind's default row (test: /(?:)/ matches everything).
// ---------------------------------------------------------------------------

type OnethingRuleCapability = 'reasoning' | 'vision' | 'tools' | 'imageOutput' | 'temperature'

type OnethingModelRuleCaps = Partial<
  Pick<OnethingResolvedModelCapabilities, OnethingRuleCapability | 'forcedToolUse'>
>

type OnethingModelRuleCapsKey = OnethingRuleCapability | 'forcedToolUse'

interface OnethingModelRule {
  test: RegExp
  caps?: OnethingModelRuleCaps | ((model: string) => OnethingModelRuleCaps)
  profile?: OnethingReasoningProfile | ((model: string) => OnethingReasoningProfile)
  /**
   * Wire format for the thinking intent, for rows whose models may resolve
   * `reasoning: false` and therefore carry no `profile`. A row that has a
   * `profile` already answers this through it.
   */
  wire?: OnethingReasoningWire | ((model: string) => OnethingReasoningWire)
}

function claudeProfile(model: string): OnethingReasoningProfile {
  const family = onethingClaudeModelFamily(model)
  return {
    toggleable: !family.alwaysThinking,
    // Only Sonnet 5 / Fable run adaptive thinking when the param is omitted.
    defaultOn: family.alwaysThinking || /sonnet-5/.test(model.toLowerCase()),
    efforts: ONETHING_CLAUDE_EFFORTS,
    defaultEffort: 'high',
    wire: claudeReasoningWire(model),
  }
}

/**
 * The one Claude family judgement, shared by the profile and the wire lookup.
 * `onethingClaudeModelFamily` is the only regex — the provider layer used to
 * keep a second copy of this branch inside `AnthropicMessagesWire.thinkingFor`.
 */
function claudeReasoningWire(model: string): OnethingReasoningWire {
  const family = onethingClaudeModelFamily(model)
  if (family.alwaysThinking) return 'anthropic-always'
  return family.adaptive ? 'anthropic-adaptive' : 'anthropic-budget'
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
function geminiReasoningWire(model: string): OnethingReasoningWire {
  return model.toLowerCase().includes('2.5') ? 'gemini-budget' : 'gemini-level'
}

function geminiProfile(model: string): OnethingReasoningProfile {
  return {
    toggleable: true,
    defaultOn: true,
    efforts: onethingGeminiThinkingLevels(model),
    defaultEffort: 'high',
    wire: geminiReasoningWire(model),
  }
}

const OPENAI_PROFILE: OnethingReasoningProfile = {
  // o-series / gpt-5 reasoning cannot be turned off — only the effort is
  // configurable, so the UI must not offer a (fake) Off.
  toggleable: false,
  defaultOn: true,
  efforts: ONETHING_OPENAI_EFFORTS,
  defaultEffort: 'medium',
  wire: 'openai-effort',
}

const COPILOT_REASONING_PATTERN = /o1|o3|o4|deepseek-r1|reasoner/
const COPILOT_VISION_PATTERN = /gpt-4o|gpt-4-turbo|gpt-4-vision|gpt-4\.1|claude-3|claude-sonnet-4|claude-opus|gemini-1\.5|gemini-2|gemini-pro-vision/
const COPILOT_IMAGE_GEN_PATTERN = /dall-e|dalle|gpt-image|imagen/
const COPILOT_NO_TOOLS_PATTERN = /o1-preview|o1-mini/

/** Generic fallbacks used when the provider kind is unknown (matches the old renderer heuristics). */
const GENERIC_REASONING_PATTERN = /o1|o3|o4|deepseek-r1|reasoner|grok-3-mini|grok-mini|thinking/
const GENERIC_IMAGE_GEN_PATTERN = /dall-e|dalle|gpt-image|imagen|stable-diffusion|midjourney/

const PROVIDER_MODEL_RULES: Record<OnethingProviderKind, OnethingModelRule[]> = {
  claude: [
    // Every currently served Claude chat model supports thinking. 4.7+ /
    // Sonnet 5 / Fable reject sampling params (temperature) outright.
    {
      test: /(?:)/,
      caps: model => ({
        reasoning: true,
        vision: true,
        tools: true,
        temperature: !onethingClaudeModelFamily(model).samplingRemoved,
        // Forced tool use is paired with thinking off, and Fable/Mythos cannot
        // take that half of the bargain (the API rejects an explicit
        // `disabled`) — so the honest answer is that they cannot be forced.
        forcedToolUse: !onethingClaudeModelFamily(model).alwaysThinking,
      }),
      profile: claudeProfile,
    },
  ],
  openai: [
    // Anchored to the id start, tolerating "vendor/" path prefixes.
    { test: /(?:^|\/)(o[134]|gpt-5)/, caps: { reasoning: true }, profile: OPENAI_PROFILE },
    // Kind-level vision default mirrors the engine's historical provider-level flag.
    { test: /(?:)/, caps: { reasoning: false, vision: true } },
  ],
  gemini: [
    { test: /gemini-(?:2\.5|[3-9])/, caps: { reasoning: true }, profile: geminiProfile },
    // Even a model the ledger grants no reasoning to has a wire format: the
    // gemini wire must know which of the two thinking encoders to reach for.
    { test: /(?:)/, caps: { reasoning: false, vision: true }, wire: geminiReasoningWire },
  ],
  zhipu: [
    {
      test: /glm-(?:4\.[5-9]|[5-9])/,
      caps: { reasoning: true },
      profile: {
        toggleable: true,
        defaultOn: true,
        efforts: [],
        defaultEffort: 'high',
        wire: 'zhipu-thinking',
      },
    },
    { test: /(?:)/, caps: { reasoning: false } },
  ],
  // 千问 AI 平台 resells GLM / Kimi / DeepSeek / MiniMax next to its own Qwen
  // models, and each family keeps its own effort vocabulary on this endpoint.
  qwen: [
    {
      // The preview shares 3.8-max's effort ladder but carries no thinking
      // toggle (models.dev lists effort + budget only, and the API docs leave
      // Qwen3.8 out of the enable_thinking model list) — so no fake Off.
      test: /qwen3\.8-max-preview/,
      caps: { reasoning: true, vision: true },
      profile: {
        toggleable: false,
        defaultOn: true,
        efforts: ONETHING_QWEN_MAX_EFFORTS,
        defaultEffort: 'xhigh',
        wire: 'qwen-thinking',
      },
    },
    {
      // Only the 3.8-max family takes reasoning_effort; it thinks by default
      // and, unlike the preview, still accepts the toggle.
      test: /qwen3\.8-max/,
      caps: { reasoning: true, vision: true },
      profile: {
        toggleable: true,
        defaultOn: true,
        efforts: ONETHING_QWEN_MAX_EFFORTS,
        defaultEffort: 'xhigh',
        wire: 'qwen-thinking',
      },
    },
    {
      // GLM and DeepSeek-V4/V3.2 keep the high|max pair the vendors use.
      test: /^glm-|^deepseek-v[34]/,
      caps: { reasoning: true },
      profile: {
        toggleable: true,
        defaultOn: true,
        efforts: ONETHING_DEEPSEEK_EFFORTS,
        defaultEffort: 'high',
        wire: 'qwen-thinking',
      },
    },
    {
      // k2.7-code / k2-thinking always think and expose no knob.
      test: /^kimi.*(code|thinking)/,
      caps: { reasoning: true },
      profile: {
        toggleable: false,
        defaultOn: true,
        efforts: [],
        defaultEffort: 'high',
        wire: 'none',
      },
    },
    {
      // Qwen3.5+ hybrids and the resold Kimi K2.x: thinking on by default,
      // toggled with enable_thinking, depth set by thinking_budget (no tiers).
      test: /^qwen3\.\d|^kimi/,
      caps: { reasoning: true, vision: true },
      profile: {
        toggleable: true,
        defaultOn: true,
        efforts: [],
        defaultEffort: 'high',
        wire: 'qwen-thinking',
      },
    },
    {
      // Older hybrids (qwen3-*, qwen-plus/turbo/flash, qwq/qvq): the API does
      // not think unless enable_thinking is sent.
      test: /^qwen3-|^qwen-(?:plus|turbo|flash)|^q[wv]q/,
      caps: { reasoning: true },
      profile: {
        toggleable: true,
        defaultOn: false,
        efforts: [],
        defaultEffort: 'high',
        wire: 'qwen-thinking',
      },
    },
    { test: /-vl|vl-|omni/, caps: { reasoning: false, vision: true } },
    { test: /(?:)/, caps: { reasoning: false } },
  ],
  grok: [
    {
      test: /grok-(?:4\.5|4\.20|3-mini)/,
      caps: { reasoning: true },
      profile: {
        // Grok reasoning cannot be disabled — effort is the only knob.
        toggleable: false,
        defaultOn: true,
        efforts: ONETHING_GROK_EFFORTS,
        defaultEffort: 'high',
        wire: 'grok-effort',
      },
    },
    { test: /(?:)/, caps: { reasoning: false, vision: true } },
  ],
  openrouter: [
    // Capability comes from the registry; the profile applies once reasoning is known.
    {
      test: /(?:)/,
      caps: { vision: true },
      profile: {
        toggleable: true,
        defaultOn: true,
        efforts: ONETHING_OPENROUTER_EFFORTS,
        defaultEffort: 'high',
        wire: 'openrouter-reasoning',
      },
    },
  ],
  deepseek: [
    {
      // DeepSeek 的图片输入只在 vision 实验族上(`image_url` / `file` 块,
      // 且只在 user 消息里)。这一行**只给 vision**,不给 reasoning ——
      // `fromRules` 对每个能力独立取「第一条给出布尔值的行」,所以
      // `deepseek-v4-*-vision-exp` 的 reasoning 仍由下面那条 v4 行决定。
      test: /vision/,
      caps: { vision: true },
    },
    {
      test: /(^|[^a-z])v4/,
      caps: { reasoning: true },
      profile: {
        toggleable: true,
        // The API does not think unless thinking.type=enabled is sent.
        defaultOn: false,
        efforts: ONETHING_DEEPSEEK_EFFORTS,
        defaultEffort: 'high',
        wire: 'thinking-type',
      },
    },
    {
      // deepseek-reasoner always thinks and exposes no knob — the chat UI
      // keeps its legacy model-pair toggle (chat ⇄ reasoner) instead.
      test: /reasoner/,
      caps: { reasoning: true },
      profile: {
        toggleable: false,
        defaultOn: true,
        efforts: [],
        defaultEffort: 'high',
        wire: 'none',
      },
    },
    { test: /(?:)/, caps: { reasoning: false } },
  ],
  kimi: [
    {
      test: /^kimi-k3/,
      caps: { reasoning: true },
      profile: {
        toggleable: true,
        defaultOn: true,
        // K3 only accepts reasoning_effort "max".
        efforts: ['max'],
        defaultEffort: 'max',
        wire: 'thinking-type',
      },
    },
    {
      // k2.7-code (+ -highspeed) and k2-thinking always think; nothing to configure.
      test: /^kimi-k2.*(code|thinking)/,
      caps: { reasoning: true },
      profile: {
        toggleable: false,
        defaultOn: true,
        efforts: [],
        defaultEffort: 'high',
        wire: 'none',
      },
    },
    {
      // k2.5 / k2.6: thinking on by default, toggleable via thinking.type.
      test: /^kimi-k2\.\d/,
      caps: { reasoning: true },
      profile: {
        toggleable: true,
        defaultOn: true,
        efforts: [],
        defaultEffort: 'high',
        wire: 'thinking-type',
      },
    },
    { test: /(?:)/, caps: { reasoning: false } },
  ],
  codex: [
    {
      test: /(?:)/,
      caps: { reasoning: true, vision: true, tools: true },
      profile: {
        toggleable: true,
        defaultOn: true,
        efforts: ONETHING_CODEX_FALLBACK_EFFORTS,
        defaultEffort: 'medium',
        wire: 'codex',
      },
    },
  ],
  // Copilot verdicts are answered entirely by copilotPatternVerdict in the
  // resolver (it needs cross-capability logic: image-gen models lose tools);
  // rule rows here would be unreachable.
  copilot: [],
  acp: [
    { test: /(?:)/, caps: { reasoning: false, tools: false } },
  ],
  unknown: [
    { test: GENERIC_IMAGE_GEN_PATTERN, caps: { imageOutput: true } },
    // Reasoning falls through to GENERIC_REASONING_PATTERN in the resolver.
  ],
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

interface CapabilityVerdict {
  value: boolean
  source: OnethingCapabilitySource
}

function verdict(value: boolean, source: OnethingCapabilitySource): CapabilityVerdict {
  return { value, source }
}

/**
 * 「Codex 的原生 `image_generation` 工具可用 ⇒ 该模型具备 image 输出」是一条
 * 规则,两侧同读:目录条目生成时由 codex.ts 的
 * `codexNativeToolsDeclareImageOutput` 写进 output_modalities,这里则认条目
 * 自己带的 `providerMetadata.codex.nativeTools` —— 用户 settings 里已经缓存
 * 的旧条目(supportsImageOutput:false)在下一次目录刷新前也不能让引擎炸。
 *
 * 字面量与 `codex-native-tools.ts` 的
 * `CODEX_NATIVE_IMAGE_GENERATION_TOOL` 同值;此文件必须保持零 import(渲染
 * 层与 web 构建直接引它),所以不从那里 import。
 */
export function codexMetadataDeclaresImageOutput(providerMetadata: unknown): boolean {
  if (!providerMetadata || typeof providerMetadata !== 'object') return false
  const codex = (providerMetadata as { codex?: unknown }).codex
  if (!codex || typeof codex !== 'object') return false
  const nativeTools = (codex as { nativeTools?: unknown }).nativeTools
  return Array.isArray(nativeTools) && nativeTools.includes('image_generation')
}

function fromRegistry(
  capability: 'reasoning' | 'vision' | 'tools' | 'imageOutput' | 'temperature',
  entry: OnethingCapabilityEntryLike | undefined,
  metadata: OnethingModelMetadataLike | undefined,
): boolean | undefined {
  if (entry) {
    switch (capability) {
      case 'reasoning': if (typeof entry.supportsReasoning === 'boolean') return entry.supportsReasoning; break
      case 'vision': if (typeof entry.supportsVision === 'boolean') return entry.supportsVision; break
      case 'tools': if (typeof entry.supportsTools === 'boolean') return entry.supportsTools; break
      case 'imageOutput':
        // The entry's own boolean is derived from output_modalities, which the
        // Codex /models response never reports — a cached entry can say false
        // while carrying nativeTools: ['image_generation']. The native tool is
        // the stronger evidence, so it is read first.
        if (codexMetadataDeclaresImageOutput(entry.providerMetadata)) return true
        if (typeof entry.supportsImageOutput === 'boolean') return entry.supportsImageOutput
        break
      case 'temperature': if (typeof entry.supportsTemperature === 'boolean') return entry.supportsTemperature; break
    }
  }
  if (!metadata) return undefined
  const params = metadata.supported_parameters
  const hasParams = Array.isArray(params) && params.length > 0
  switch (capability) {
    case 'reasoning':
      // Wire-shaped parameter lists are positive evidence only: absence of
      // 'reasoning' often means "not enumerated", not "unsupported" — fall
      // through to the rules table. (Storage entries above carry explicit
      // booleans and stay authoritative both ways.)
      return hasParams && params.includes('reasoning') ? true : undefined
    case 'tools':
      return hasParams ? params.includes('tools') : undefined
    case 'temperature':
      return hasParams ? params.includes('temperature') : undefined
    case 'vision':
      return metadata.architecture?.input_modalities
        ? metadata.architecture.input_modalities.includes('image')
        : undefined
    case 'imageOutput': {
      if (codexMetadataDeclaresImageOutput(metadata.providerMetadata)) return true
      return metadata.architecture?.output_modalities
        ? metadata.architecture.output_modalities.includes('image')
        : undefined
    }
  }
}

function fromRules(
  capability: OnethingModelRuleCapsKey,
  rules: OnethingModelRule[],
  modelLower: string,
): boolean | undefined {
  for (const rule of rules) {
    if (!rule.test.test(modelLower)) continue
    const caps = typeof rule.caps === 'function' ? rule.caps(modelLower) : rule.caps
    const value = caps?.[capability]
    if (typeof value === 'boolean') return value
  }
  return undefined
}

function copilotPatternVerdict(
  capability: 'reasoning' | 'vision' | 'tools' | 'imageOutput',
  modelLower: string,
): boolean {
  switch (capability) {
    case 'reasoning': return COPILOT_REASONING_PATTERN.test(modelLower)
    case 'vision': return COPILOT_VISION_PATTERN.test(modelLower)
    case 'imageOutput': return COPILOT_IMAGE_GEN_PATTERN.test(modelLower)
    case 'tools':
      return !COPILOT_NO_TOOLS_PATTERN.test(modelLower) && !COPILOT_IMAGE_GEN_PATTERN.test(modelLower)
  }
}

const CAPABILITY_DEFAULTS: Record<'reasoning' | 'vision' | 'tools' | 'imageOutput' | 'temperature', boolean> = {
  reasoning: false,
  vision: false,
  tools: true,
  imageOutput: false,
  temperature: true,
}

function resolveCapability(
  capability: 'reasoning' | 'vision' | 'tools' | 'imageOutput' | 'temperature',
  input: ResolveOnethingModelCapabilitiesInput,
  kind: OnethingProviderKind,
  modelLower: string,
): CapabilityVerdict {
  if (capability !== 'temperature') {
    const override = input.override?.[capability]
    if (typeof override === 'boolean') return verdict(override, 'override')
  }

  // Temperature is special-cased: generation rules encode hard API rejections
  // (Claude 4.7+/Fable 400 on sampling params), which outrank whatever the
  // fetched registry believes.
  if (capability === 'temperature') {
    const ruled = fromRules(capability, PROVIDER_MODEL_RULES[kind], modelLower)
    if (typeof ruled === 'boolean') return verdict(ruled, 'pattern')
    const registry = fromRegistry(capability, input.registryEntry, input.modelMetadata)
    if (typeof registry === 'boolean') return verdict(registry, 'registry')
    return verdict(CAPABILITY_DEFAULTS.temperature, 'default')
  }

  const registry = fromRegistry(capability, input.registryEntry, input.modelMetadata)
  if (typeof registry === 'boolean') return verdict(registry, 'registry')

  if (kind === 'copilot') {
    return verdict(copilotPatternVerdict(capability, modelLower), 'pattern')
  }

  const ruled = fromRules(capability, PROVIDER_MODEL_RULES[kind], modelLower)
  if (typeof ruled === 'boolean') return verdict(ruled, 'pattern')

  if (capability === 'reasoning' && kind === 'unknown' && GENERIC_REASONING_PATTERN.test(modelLower)) {
    return verdict(true, 'pattern')
  }

  return verdict(CAPABILITY_DEFAULTS[capability], 'default')
}

function resolveProfile(
  kind: OnethingProviderKind,
  model: string,
  modelLower: string,
): OnethingReasoningProfile | undefined {
  for (const rule of PROVIDER_MODEL_RULES[kind]) {
    if (!rule.test.test(modelLower)) continue
    if (!rule.profile) continue
    return typeof rule.profile === 'function' ? rule.profile(model) : rule.profile
  }
  return undefined
}

/**
 * The wire format, independent of whether reasoning is available. First
 * matching row that says anything wins — its own `wire`, else its profile's.
 */
function resolveReasoningWire(
  kind: OnethingProviderKind,
  model: string,
  modelLower: string,
): OnethingReasoningWire | undefined {
  for (const rule of PROVIDER_MODEL_RULES[kind]) {
    if (!rule.test.test(modelLower)) continue
    if (rule.wire) return typeof rule.wire === 'function' ? rule.wire(model) : rule.wire
    if (rule.profile) {
      return (typeof rule.profile === 'function' ? rule.profile(model) : rule.profile).wire
    }
  }
  return undefined
}

/** Profile used when reasoning is known-true but no rule row carries a profile. */
const GENERIC_REASONING_PROFILE: OnethingReasoningProfile = {
  toggleable: true,
  defaultOn: true,
  efforts: [],
  defaultEffort: 'high',
  wire: 'none',
}

export function resolveOnethingModelCapabilities(
  input: ResolveOnethingModelCapabilitiesInput,
): OnethingResolvedModelCapabilities {
  const kind = resolveOnethingProviderKind(input.providerId, input.customApiType)
  const modelLower = input.modelId.toLowerCase()

  const reasoning = resolveCapability('reasoning', input, kind, modelLower)
  const vision = resolveCapability('vision', input, kind, modelLower)
  const tools = resolveCapability('tools', input, kind, modelLower)
  const imageOutput = resolveCapability('imageOutput', input, kind, modelLower)
  const temperature = resolveCapability('temperature', input, kind, modelLower)

  const reasoningProfile = reasoning.value
    ? resolveProfile(kind, input.modelId, modelLower) ?? GENERIC_REASONING_PROFILE
    : undefined
  const forcedToolUse = fromRules('forcedToolUse', PROVIDER_MODEL_RULES[kind], modelLower)

  return {
    reasoning: reasoning.value,
    vision: vision.value,
    tools: tools.value,
    imageOutput: imageOutput.value,
    temperature: temperature.value,
    reasoningWire:
      reasoningProfile?.wire ?? resolveReasoningWire(kind, input.modelId, modelLower) ?? 'none',
    ...(typeof forcedToolUse === 'boolean' ? { forcedToolUse } : {}),
    source: {
      reasoning: reasoning.source,
      vision: vision.source,
      tools: tools.source,
      imageOutput: imageOutput.source,
      temperature: temperature.source,
    },
    ...(reasoningProfile ? { reasoningProfile } : {}),
  }
}
