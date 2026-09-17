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
 * Inside step 2 there are two sub-rules. The first: `fileInput` (ruling #12,
 * P4-1) reads the entry's own `inputModalities` list — `'pdf'` / `'file'`
 * present means yes, a non-empty list without them means **no** (an entry
 * enumerates what the model takes, so absence there is an answer, not
 * silence). It is deliberately not a rider on `vision`:
 * `deepseek-*-vision-exp` reads images and takes no PDF. Note that the
 * capability a caller finally sees is **catalog AND wire** — this module
 * answers the catalog half; whether the dialect's codec can put a file block
 * on the wire is the provider's transport declaration, and the two are joined
 * in `ModelProfile.toAgentModelCapabilities`.
 *
 * The second: a Codex entry/metadata carrying
 * `providerMetadata.codex.nativeTools: ['image_generation']` declares image
 * output regardless of its own `supportsImageOutput` / `output_modalities`
 * (Codex /models never reports output modalities). That same evidence also
 * answers *how* the image is served — see `imageOutputServedBy` below; the
 * detector itself (`codexMetadataDeclaresImageOutput`) is internal to this
 * module, because the ledger is now the only thing that reads native tools.
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

/**
 * An effort tier plus `'none'` — the "think nothing" rung gpt-5.1 and later
 * accept as `reasoning_effort: 'none'` (P3-3).
 *
 * It is deliberately NOT a member of `OnethingReasoningEffortLevel`: that union
 * is the *scale* (every rung has a thinking budget behind it — see
 * `ONETHING_CLAUDE_THINKING_BUDGETS`), while `'none'` is the absence of one.
 * It appears only inside `OnethingReasoningProfile.efforts`, where it answers a
 * wire question: "does this model take an explicit off switch on the effort
 * field?" — the single judge `OpenAIEffortWire` asks before turning a
 * `thinking: 'disabled'` intent into bytes.
 */
export type OnethingReasoningEffortOption = OnethingReasoningEffortLevel | 'none'

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
  | 'custom'
  | 'none'

export interface OnethingReasoningProfile {
  /** Whether the user can turn thinking off (o-series/grok always reason). */
  toggleable: boolean
  /** Server-side behavior when no parameter is sent. */
  defaultOn: boolean
  /**
   * Levels the UI offers — identical to what the wire accepts after clamping.
   * May additionally carry `'none'` (gpt-5.1+); that entry is a wire capability
   * marker, not a picker rung — see `OnethingReasoningEffortOption`.
   */
  efforts: readonly OnethingReasoningEffortOption[]
  defaultEffort: OnethingReasoningEffortLevel
  wire: OnethingReasoningWire
  /** Explicit compatibility behavior for an old disabled selection on an always-on model. */
  disabledEffort?: OnethingReasoningEffortLevel
  effortLabels?: Partial<Record<OnethingReasoningEffortLevel, string>>
  custom?: OnethingCustomReasoningConfig
  /** Runtime marker: apply the user's declared defaults before native encoding. */
  configured?: boolean
  configuredWire?: boolean
}

export interface OnethingCustomReasoningConfig {
  /** Dot-separated request field, e.g. reasoning.effort or thinking.budget_tokens. */
  effortPath: string
  effortValues?: Partial<Record<OnethingReasoningEffortLevel, string | number>>
  disabledValue?: string | number | boolean | null
  enabledBody?: Record<string, unknown>
  disabledBody?: Record<string, unknown>
}

/** Stored under providerOptions.reasoningProfile or a per-model capability override. */
export interface OnethingReasoningProfileOverride {
  toggleable?: boolean
  defaultOn?: boolean
  efforts?: readonly OnethingReasoningEffortOption[]
  defaultEffort?: OnethingReasoningEffortLevel
  disabledEffort?: OnethingReasoningEffortLevel
  wire?: OnethingReasoningWire
  effortLabels?: Partial<Record<OnethingReasoningEffortLevel, string>>
  /** null restores the native encoder when a provider default uses custom mapping. */
  custom?: OnethingCustomReasoningConfig | null
}

const REASONING_LEVELS: readonly OnethingReasoningEffortLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const REASONING_WIRES: readonly OnethingReasoningWire[] = ['anthropic-adaptive', 'anthropic-budget', 'anthropic-always', 'openai-effort', 'gemini-level', 'gemini-budget', 'thinking-type', 'zhipu-thinking', 'qwen-thinking', 'grok-effort', 'openrouter-reasoning', 'codex', 'custom', 'none']
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

function profileRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function safeProfileJson(value: unknown, depth = 0): boolean {
  if (depth > 20) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(item => safeProfileJson(item, depth + 1))
  return profileRecord(value) && Object.entries(value).every(([key, item]) => !key.split('.').some(segment => UNSAFE_KEYS.has(segment)) && safeProfileJson(item, depth + 1))
}

/** Reject malformed definitions as a whole; never send half a custom API contract. */
export function normalizeOnethingReasoningProfileOverride(value: unknown): OnethingReasoningProfileOverride | undefined {
  if (!profileRecord(value)) return undefined
  const result: OnethingReasoningProfileOverride = {}
  for (const key of ['toggleable', 'defaultOn'] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== 'boolean') return undefined
      result[key] = value[key]
    }
  }
  for (const key of ['defaultEffort', 'disabledEffort'] as const) {
    if (value[key] !== undefined) {
      if (!REASONING_LEVELS.includes(value[key] as OnethingReasoningEffortLevel)) return undefined
      result[key] = value[key] as OnethingReasoningEffortLevel
    }
  }
  if (value.efforts !== undefined) {
    if (!Array.isArray(value.efforts) || !value.efforts.every(level => level === 'none' || REASONING_LEVELS.includes(level))) return undefined
    result.efforts = [...new Set(value.efforts)]
  }
  if (value.wire !== undefined) {
    if (!REASONING_WIRES.includes(value.wire as OnethingReasoningWire)) return undefined
    result.wire = value.wire as OnethingReasoningWire
  }
  if (value.effortLabels !== undefined) {
    if (!profileRecord(value.effortLabels)) return undefined
    result.effortLabels = {}
    for (const [level, label] of Object.entries(value.effortLabels)) {
      if (!REASONING_LEVELS.includes(level as OnethingReasoningEffortLevel) || typeof label !== 'string' || !label.trim() || label.length > 80) return undefined
      result.effortLabels[level as OnethingReasoningEffortLevel] = label.trim()
    }
  }
  if (value.custom === null) result.custom = null
  else if (value.custom !== undefined) {
    const custom = value.custom
    if (!profileRecord(custom) || typeof custom.effortPath !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/.test(custom.effortPath) || custom.effortPath.split('.').some(key => UNSAFE_KEYS.has(key))) return undefined
    const config: OnethingCustomReasoningConfig = { effortPath: custom.effortPath }
    if (custom.effortValues !== undefined) {
      if (!profileRecord(custom.effortValues)) return undefined
      config.effortValues = {}
      for (const [level, mapped] of Object.entries(custom.effortValues)) {
        if (!REASONING_LEVELS.includes(level as OnethingReasoningEffortLevel) || (typeof mapped !== 'string' && !(typeof mapped === 'number' && Number.isFinite(mapped)))) return undefined
        config.effortValues[level as OnethingReasoningEffortLevel] = mapped
      }
    }
    if (custom.disabledValue !== undefined) {
      if (custom.disabledValue !== null && !['string', 'boolean', 'number'].includes(typeof custom.disabledValue)) return undefined
      if (!safeProfileJson(custom.disabledValue)) return undefined
      config.disabledValue = custom.disabledValue as string | number | boolean | null
    }
    for (const key of ['enabledBody', 'disabledBody'] as const) {
      if (custom[key] !== undefined) {
        if (!profileRecord(custom[key]) || !safeProfileJson(custom[key])) return undefined
        config[key] = custom[key]
      }
    }
    result.custom = config
  }
  if (result.wire === 'custom' && !result.custom) return undefined
  return Object.keys(result).length ? result : undefined
}

/** Validate all saved definitions before any persistence or runtime side effects. */
export function validateOnethingProviderReasoningSettings(value: unknown): void {
  if (!profileRecord(value)) return
  const providers = profileRecord(value.providers) ? Object.entries(value.providers) : []
  const customProviders = Array.isArray(value.customProviders)
    ? value.customProviders.filter(profileRecord).map(config => [String(config.id ?? 'custom'), config] as const)
    : []
  const check = (profile: unknown, location: string) => {
    if (profile !== undefined && !normalizeOnethingReasoningProfileOverride(profile)) {
      throw new Error(`Invalid reasoning profile at ${location}`)
    }
  }
  for (const [providerId, config] of [...providers, ...customProviders]) {
    if (!profileRecord(config)) continue
    if (profileRecord(config.providerOptions)) check(config.providerOptions.reasoningProfile, `${providerId}.providerOptions.reasoningProfile`)
    if (!profileRecord(config.modelCapabilitiesByModel)) continue
    for (const [modelId, override] of Object.entries(config.modelCapabilitiesByModel)) {
      if (profileRecord(override)) check(override.reasoningProfile, `${providerId}.${modelId}.reasoningProfile`)
    }
  }
}

export function resolveOnethingReasoningEffort(effort: string | undefined, allowed: readonly string[], fallback: OnethingReasoningEffortLevel): OnethingReasoningEffortLevel {
  const levels = allowed.filter((level): level is OnethingReasoningEffortLevel => REASONING_LEVELS.includes(level as OnethingReasoningEffortLevel))
  const requested = REASONING_LEVELS.includes(effort as OnethingReasoningEffortLevel) ? effort as OnethingReasoningEffortLevel : fallback
  if (levels.includes(requested)) return requested
  const index = REASONING_LEVELS.indexOf(requested)
  return [...REASONING_LEVELS.slice(0, index).reverse(), ...REASONING_LEVELS.slice(index + 1)].find(level => levels.includes(level)) ?? fallback
}

export function clampOnethingReasoningEffort(effort: string | undefined, profile: OnethingReasoningProfile): OnethingReasoningEffortLevel {
  return resolveOnethingReasoningEffort(effort, profile.efforts, profile.defaultEffort)
}

function withReasoningProfileOverrides(base: OnethingReasoningProfile, provider?: OnethingReasoningProfileOverride, model?: OnethingReasoningProfileOverride): OnethingReasoningProfile {
  const { custom, ...merged } = { ...base, ...provider, ...model }
  const labels = { ...base.effortLabels, ...provider?.effortLabels, ...model?.effortLabels }
  const profile: OnethingReasoningProfile = { ...merged, ...(custom ? { custom, wire: 'custom' } : {}), ...(Object.keys(labels).length ? { effortLabels: labels } : {}), ...(provider || model ? { configured: true } : {}), ...(provider?.wire || model?.wire ? { configuredWire: true } : {}) }
  if (custom === null && profile.wire === 'custom') profile.wire = base.wire
  // A configured always-on policy must agree with the picker and the request
  // normalization, including families whose unconfigured default is off.
  if (!profile.toggleable && (profile.configured || base.defaultOn)) profile.defaultOn = true
  profile.defaultEffort = clampOnethingReasoningEffort(profile.defaultEffort, profile)
  if (profile.disabledEffort) profile.disabledEffort = clampOnethingReasoningEffort(profile.disabledEffort, profile)
  return profile
}

/**
 * 「屏幕上这一型的思考能提供几档」—— profile 的**只读投影**,唯一产地。
 *
 * 立在这里(profile 隔壁)而不是装配层,理由只有一条:**滤掉 `'none'` 是一句
 * 关于 profile 语义的话**,不是关于某条 RPC 路由的话。`'none'` 是 gpt-5.1+ 在
 * `reasoning_effort` 上接受的那个「什么都别想」的线协议标记,它答的是
 * `OpenAIEffortWire` 的问题(见 `OnethingReasoningEffortOption` 抬头),
 * 不是一根用户能点的档。抄一份到别处,那句判据就有了第二个产地。
 *
 * `profile === undefined`(`resolveOnethingModelCapabilities` 在 `reasoning`
 * 为假时给的就是它)= **这一型不思考**:四格全按「不思考」答,不编档。
 */
export interface OnethingThinkingLevelProjection {
  /** 能选的档;`null` = 这一型不思考;`[]` = 能开关但没有档可挑。 */
  thinkingLevels: OnethingReasoningEffortLevel[] | null
  /** 用户能不能把它关掉。 */
  thinkingToggleable: boolean
  /** 什么参数都不发时服务端思不思考。 */
  thinkingDefaultOn: boolean
  /** 什么档都没设时的有效档;`null` = 这一型不思考。 */
  thinkingDefaultLevel: OnethingReasoningEffortLevel | null
  thinkingDisabledLevel?: OnethingReasoningEffortLevel | null
  thinkingLevelLabels?: Partial<Record<OnethingReasoningEffortLevel, string>>
}

export function projectOnethingThinkingLevels(
  profile: OnethingReasoningProfile | undefined,
): OnethingThinkingLevelProjection {
  if (!profile) {
    return {
      thinkingLevels: null,
      thinkingToggleable: false,
      thinkingDefaultOn: false,
      thinkingDefaultLevel: null,
    }
  }
  return {
    thinkingLevels: profile.efforts.filter(
      (effort): effort is OnethingReasoningEffortLevel => effort !== 'none',
    ),
    thinkingToggleable: profile.toggleable,
    thinkingDefaultOn: profile.defaultOn,
    thinkingDefaultLevel: profile.defaultEffort,
    ...(profile.disabledEffort ? { thinkingDisabledLevel: profile.disabledEffort } : {}),
    ...(profile.effortLabels && Object.keys(profile.effortLabels).length ? { thinkingLevelLabels: { ...profile.effortLabels } } : {}),
  }
}

export type OnethingCapabilitySource = 'override' | 'registry' | 'pattern' | 'default'

/**
 * How a model's image output reaches the user.
 *
 *  - `'in-loop'`     —— the provider produces the image *inside* the agent loop
 *                       (Codex's native `image_generation` tool). The normal
 *                       chat pipeline already handles it; switching to the
 *                       dedicated image stream would break plain conversation.
 *  - `'dedicated-api'` —— the image comes from a separate image endpoint
 *                       (OpenAI images / Gemini image API): the turn has to
 *                       leave the agent loop to get one.
 *
 * `undefined` = the ledger has nothing to say (no image output, or it does not
 * know). This is the judge behind `onethingModelSupportsImageGeneration`
 * ("换不换通路"), which is a different question from `imageOutput`
 * ("能不能出图").
 */
export type OnethingImageOutputServedBy = 'in-loop' | 'dedicated-api'

export interface OnethingResolvedModelCapabilities {
  reasoning: boolean
  vision: boolean
  /**
   * Whether the model itself accepts file attachments (PDF). Deliberately
   * separate from `vision` (P4-1, ruling #12): "reads images" and "accepts a
   * PDF" are two different catalog facts — `deepseek-*-vision-exp` has the
   * first and not the second.
   *
   * This is only half the question a caller cares about. The declared
   * capability is **catalog AND wire**: the model must accept files *and* the
   * dialect's codec must be able to put a file block on the wire. The wire
   * half lives in the provider's transport declaration; the join happens in
   * `ModelProfile.toAgentModelCapabilities`.
   */
  fileInput: boolean
  tools: boolean
  imageOutput: boolean
  temperature: boolean
  /**
   * Present only when the ledger can tell how the image output is served.
   * Read `OnethingImageOutputServedBy` for the two values and why the routing
   * question is not the same as the capability question.
   */
  imageOutputServedBy?: OnethingImageOutputServedBy
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
    fileInput: OnethingCapabilitySource
  }
  /** Present when reasoning is true. */
  reasoningProfile?: OnethingReasoningProfile
}

/** Per-model override stored in settings (modelCapabilitiesByModel). */
export interface OnethingCapabilityOverrideLike {
  reasoningProfile?: OnethingReasoningProfileOverride
  tools?: boolean
  vision?: boolean
  reasoning?: boolean
  imageOutput?: boolean
  /** Ruling #12: file attachments are their own switch, not a vision rider. */
  fileInput?: boolean
}

/** Storage-shaped registry entry (models.dev fetch persisted in settings). */
export interface OnethingCapabilityEntryLike {
  supportsTools?: boolean
  supportsVision?: boolean
  supportsReasoning?: boolean
  supportsImageOutput?: boolean
  supportsTemperature?: boolean
  /**
   * `OnethingModelCapabilityEntry.inputModalities` — the catalog's own list
   * (models.dev `modalities.input`, OpenRouter `architecture.input_modalities`).
   * It is the evidence behind `fileInput`: a list that carries `'pdf'`/`'file'`
   * says yes, a list that does not says **no** (an entry enumerates what the
   * model takes, so absence is a real answer, not silence).
   */
  inputModalities?: string[]
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
  providerReasoningProfile?: unknown
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

// ---------------------------------------------------------------------------
// Shared effort tables and budgets (single copy — UI options, provider clamps,
// and thinking budgets all read from here)
// ---------------------------------------------------------------------------

export const ONETHING_CLAUDE_EFFORTS = ['low', 'medium', 'high', 'max'] as const
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

type OnethingRuleCapability =
  | 'reasoning'
  | 'vision'
  | 'tools'
  | 'imageOutput'
  | 'temperature'
  | 'fileInput'

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
 * openai 方言在取袋时问一次(见 `wires/openai-responses-provider-options.ts`)。
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

function openAIProfile(model: string): OnethingReasoningProfile {
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
    { test: /(?:^|\/)(o[134]|gpt-5)/, caps: { reasoning: true }, profile: openAIProfile },
    // Kind-level vision default mirrors the engine's historical provider-level flag.
    { test: /(?:)/, caps: { reasoning: false, vision: true } },
  ],
  gemini: [
    // Google 官方端点的图像模型(`gemini-*-image*`)**同时是聊天模型**:图在回合内
    // 以 `inlineData` part 回来(P4-2)。目录缺席时账本也必须答出 imageOutput=true,
    // 否则 `imageOutputServedBy` 无从判成 'in-loop',生图路由
    // (`onethingModelSupportsImageGeneration`)就会把它换到专用生图流。
    // 这一行只答 imageOutput,reasoning/wire 继续落到下面两行。
    { test: /image/, caps: { imageOutput: true } },
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
    // 智谱全系不支持强制调用:官方文档写明 `tool_choice` 目前仅支持 `auto`
    // (#5b)。挂在 catch-all 上就够 —— 上面那条 reasoning 行对
    // `forcedToolUse` 不表态,而 `fromRules` 是**按能力**各取「第一条给出布尔
    // 值的行」,所以 reasoning 的顺序语义一点没动。
    { test: /(?:)/, caps: { reasoning: false, forcedToolUse: false } },
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
    { test: /non-reasoning|grok-imagine/, caps: { reasoning: false, vision: true } },
    {
      test: /grok-4\.(?:6(?:$|-)|20.*multi-agent)/,
      caps: { reasoning: true },
      profile: {
        toggleable: false,
        defaultOn: true,
        efforts: ['low', 'medium', 'high', 'xhigh'],
        defaultEffort: 'high',
        disabledEffort: 'low',
        wire: 'grok-effort',
      },
    },
    {
      // xAI capability guide (2026-09-16): 4.5 cannot disable reasoning;
      // xhigh is not a distinct supported level on this model.
      test: /grok-4\.5(?:$|-)/,
      caps: { reasoning: true },
      profile: {
        toggleable: false, defaultOn: true, efforts: ONETHING_GROK_EFFORTS,
        defaultEffort: 'high', disabledEffort: 'low', wire: 'grok-effort',
      },
    },
    {
      // Model-specific 4.3 docs list none / low / medium / high, default low.
      test: /grok-4\.3(?:$|-)/,
      caps: { reasoning: true },
      profile: {
        toggleable: true, defaultOn: true, efforts: ['none', 'low', 'medium', 'high'],
        defaultEffort: 'low', wire: 'grok-effort',
      },
    },
    {
      test: /grok-3-mini(?:$|-)/,
      caps: { reasoning: true },
      profile: {
        toggleable: false, defaultOn: true, efforts: ['low', 'high'],
        defaultEffort: 'low', disabledEffort: 'low', wire: 'grok-effort',
      },
    },
    {
      // Older reasoning families do not expose a configurable effort knob.
      test: /grok-4(?:$|-)|grok-4\.(?:1|20)(?:$|-)|grok-code-fast/,
      caps: { reasoning: true },
      profile: {
        toggleable: false, defaultOn: true, efforts: [], defaultEffort: 'high',
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
      // V4.1 起官方目录改名为 `deepseek-flash` / `deepseek-pro`(models.dev 名字仍写
      // 「DeepSeek V4.1 Flash」),id 里不再带 v4 —— 只认 v4 的话它会落进下面那条
      // 兜底行,抽屉里档位整条消失。
      test: /(^|[^a-z])v4|^deepseek-(flash|pro)(\b|$)/,
      caps: { reasoning: true },
      profile: {
        toggleable: true,
        // 官方原文:「思考模式默认打开,且 effort 默认为 high」—— 不传
        // `thinking` 时服务端自己在想,所以这里是 true(#6;旧注释「不传
        // 就不想」把这条写反了)。
        defaultOn: true,
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
      // K3 是这家唯一收 `tool_choice: required` / 指名函数的一代(#5b)。
      test: /^kimi-k3/,
      caps: { reasoning: true, forcedToolUse: true },
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
      // Kimi Code 套餐给同一代 K3 起的名字是**裸** `k3` / `k3-256k`
      // (`ONETHING_KIMI_CODE_DEFAULT_MODEL`),`^kimi-k3` 够不着它。这一行
      // **只说 forcedToolUse**:reasoning 仍由下面的行裁定,顺序语义不动。
      test: /^k3(?:-|$)/,
      caps: { forcedToolUse: true },
    },
    {
      // k2.7-code (+ -highspeed) and k2-thinking always think; nothing to configure.
      test: /^kimi-k2.*(code|thinking)/,
      caps: { reasoning: true, forcedToolUse: false },
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
      caps: { reasoning: true, forcedToolUse: false },
      profile: {
        toggleable: true,
        defaultOn: true,
        efforts: [],
        defaultEffort: 'high',
        wire: 'thinking-type',
      },
    },
    // K2.x 及更早只认 `tool_choice: auto`(#5b);未知型号按保守面倒。
    { test: /(?:)/, caps: { reasoning: false, forcedToolUse: false } },
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
 *
 * **模块内部函数**:P2-b 之后账本自己把这条证据折成
 * `imageOutputServedBy: 'in-loop'`,外面(`model-registry.ts` 的生图路由判据)
 * 读那个字段,不再各自认原生工具。
 */
function codexMetadataDeclaresImageOutput(providerMetadata: unknown): boolean {
  if (!providerMetadata || typeof providerMetadata !== 'object') return false
  const codex = (providerMetadata as { codex?: unknown }).codex
  if (!codex || typeof codex !== 'object') return false
  const nativeTools = (codex as { nativeTools?: unknown }).nativeTools
  return Array.isArray(nativeTools) && nativeTools.includes('image_generation')
}

/**
 * 「OpenAI 直连的这个模型有没有**原生出图工具**」(拍板 #13)。
 *
 * 官方 `/docs/guides/tools-image-generation` 的「Supported models」逐字列着:
 * `gpt-5.5` / `gpt-5.4-mini` / `gpt-5.4-nano` / `gpt-5.2` / `gpt-5` /
 * `gpt-5-nano` / `o3` / `gpt-4.1` / `gpt-4.1-mini` / `gpt-4.1-nano`
 * (2026-08-23 核)。**表里没有的就是没有** —— `gpt-5.4`(非 mini/nano)、
 * `gpt-5-mini`、`o3-mini`、`gpt-5.6` 都不在,账本如实答 false。
 *
 * 这是一条**独立的事实**,与目录说的输出模态无关,所以它在
 * `resolveCapability('imageOutput')` 里**站在 registry 之前**(与 codex 的
 * `nativeTools` 捷径同一地位):官方模型页的「Output modalities: text」说的是
 * *模型*的输出模态 —— 图是**工具**产出的,不是模型吐的模态,于是目录条目
 * (models.dev / OpenAI /models)会一致地说 `output_modalities: ['text']`,
 * 而它并没有说错。
 *
 * `gpt-image-*` **不在这张表里**:那是 `/v1/images/*` 的专用生图端点,通路不在
 * 回合内,仍旧 `imageOutputServedBy: 'dedicated-api'`。
 */
const OPENAI_IMAGE_TOOL_MODELS = [
  'gpt-5.5',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
  'gpt-5.2',
  'gpt-5',
  'gpt-5-nano',
  'o3',
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4.1-nano',
]

/**
 * 逐名比对(不是模糊包含):`gpt-5-mini` 不能因为含 `gpt-5` 就点亮。容忍两样
 * 装饰 —— `vendor/` 路径前缀(与本表其它行同规)和官方的 `-YYYY-MM-DD` 快照
 * 后缀(`gpt-4.1-2025-04-14`)。
 */
function openAIModelHasNativeImageTool(modelLower: string): boolean {
  const bare = modelLower.replace(/^.*\//, '').replace(/-\d{4}-\d{2}-\d{2}$/, '')
  return OPENAI_IMAGE_TOOL_MODELS.includes(bare)
}

/**
 * Catalog modality names that mean "this model takes a file attachment".
 * models.dev says `pdf`; a few OpenRouter entries say `file`.
 */
const FILE_INPUT_MODALITIES = ['pdf', 'file']

function declaresFileInput(modalities: string[] | undefined): boolean | undefined {
  if (!Array.isArray(modalities) || modalities.length === 0) return undefined
  return modalities.some((modality) => FILE_INPUT_MODALITIES.includes(modality.toLowerCase()))
}

function fromRegistry(
  capability: OnethingRuleCapability,
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
      case 'fileInput': {
        const declared = declaresFileInput(entry.inputModalities)
        if (typeof declared === 'boolean') return declared
        break
      }
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
    case 'fileInput':
      return declaresFileInput(metadata.architecture?.input_modalities)
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

const CAPABILITY_DEFAULTS: Record<OnethingRuleCapability, boolean> = {
  reasoning: false,
  vision: false,
  tools: true,
  imageOutput: false,
  temperature: true,
  // Ruling #12: nobody gets file input for free. Silence from every source
  // means "the catalog has nothing to say", and the transport declaration is
  // what stands — see `ModelProfile.toAgentModelCapabilities`.
  fileInput: false,
}

function resolveCapability(
  capability: OnethingRuleCapability,
  input: ResolveOnethingModelCapabilitiesInput,
  kind: OnethingProviderKind,
  modelLower: string,
): CapabilityVerdict {
  if (capability !== 'temperature') {
    const override = input.override?.[capability]
    if (typeof override === 'boolean') return verdict(override, 'override')
  }

  // 拍板 #13:OpenAI 直连的原生 `image_generation` 工具是一条**独立事实**,
  // 站在 registry 之前 —— 目录说的 `output_modalities: ['text']` 讲的是模型的
  // 输出模态,而图是工具产出的(理由写在 `OPENAI_IMAGE_TOOL_MODELS` 抬头)。
  // 与 codex 那条捷径同一地位:两者都在「谁说了算」的链条上排在目录之上,
  // 都排在用户 override 之下。
  if (
    capability === 'imageOutput' &&
    kind === 'openai' &&
    openAIModelHasNativeImageTool(modelLower)
  ) {
    return verdict(true, 'pattern')
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

  // Copilot's pattern table answers the four capabilities it knows; it has
  // nothing to say about file input, which falls through to the rules table.
  if (kind === 'copilot' && capability !== 'fileInput') {
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

/**
 * 「谁来出图」—— 在能力裁定**之外**再问一次,因为这条判据不吃 override:
 * 用户 override 表达的是「能出图」,不是「换通路」,而 Codex 的原生
 * `image_generation` 工具是在回合内出图的,换通路只会让它连普通对话都答不了。
 *
 * 四条 `'in-loop'` 证据:
 *  1. Codex 的原生 `image_generation` 工具(工具调用产出图,回合内);
 *  1'. **OpenAI 直连**(kind = `openai`)且模型在官方的原生出图工具支持表里
 *     (拍板 #13,`OPENAI_IMAGE_TOOL_MODELS`)—— 与 codex 同一条线协议
 *     (`/v1/responses`)、同一个工具,只是后台不同。它排在 `imageOutput` 的
 *     裁定**之后**:用户显式 override `imageOutput: false` 表达的是「别给我
 *     出图」,那时连「谁来出」都不必回答。
 *  2. **provider kind = `openrouter`**(P3-2)—— OpenRouter 走的是
 *     chat-completions:请求带 `modalities: ['text','image']`,回复直接在
 *     `choices[].message.images[]` 里带图,能聊天的图像模型因此走普通流;
 *  3. **provider kind = `gemini`**(P4-2)—— Google 官方端点上的图像模型
 *     (`gemini-3.1-flash-image` / `gemini-3-pro-image` / `gemini-2.5-flash-image`)
 *     **同时是聊天模型**:请求带 `generationConfig.responseModalities:
 *     ['TEXT','IMAGE']`,图以 `inlineData` part 混在
 *     `candidates[0].content.parts[]` 里回来,GeminiWire 解析它。专用生图流对
 *     这一家从此退役 —— 换通路只会让它连普通对话都答不了,而多轮改图(把上一条
 *     model 回复含图的 parts 原样放回 `contents`)在专用通路上根本不存在。
 *
 * 2 与 3 都按**家**判而不是按模型名判:同一个上游模型经 OpenRouter 与经
 * Google 官方端点是两条线协议,判据必须落在家上。
 *
 * 其余能出图的模型一律 `'dedicated-api'`(openai 的 `gpt-image-*`、grok-imagine):
 * 那条通路不在回合里。
 */
function resolveImageOutputServedBy(
  input: ResolveOnethingModelCapabilitiesInput,
  kind: OnethingProviderKind,
  modelLower: string,
  imageOutput: CapabilityVerdict,
): OnethingImageOutputServedBy | undefined {
  if (codexMetadataDeclaresImageOutput(input.registryEntry?.providerMetadata)) return 'in-loop'
  if (codexMetadataDeclaresImageOutput(input.modelMetadata?.providerMetadata)) return 'in-loop'
  if (!imageOutput.value) return undefined
  if (kind === 'openai' && openAIModelHasNativeImageTool(modelLower)) return 'in-loop'
  return kind === 'openrouter' || kind === 'gemini' ? 'in-loop' : 'dedicated-api'
}

export function resolveOnethingModelCapabilities(
  input: ResolveOnethingModelCapabilitiesInput,
): OnethingResolvedModelCapabilities {
  const kind = resolveOnethingProviderKind(input.providerId, input.customApiType)
  const modelLower = input.modelId.toLowerCase()

  const providerProfile = normalizeOnethingReasoningProfileOverride(input.providerReasoningProfile)
  const modelProfile = normalizeOnethingReasoningProfileOverride(input.override?.reasoningProfile)
  if (input.providerReasoningProfile !== undefined && !providerProfile) throw new Error(`Invalid reasoning profile for provider '${input.providerId}'`)
  if (input.override?.reasoningProfile !== undefined && !modelProfile) throw new Error(`Invalid reasoning profile for model '${input.modelId}'`)
  const reasoning = (providerProfile || modelProfile) && input.override?.reasoning !== false
    ? verdict(true, 'override')
    : resolveCapability('reasoning', input, kind, modelLower)
  const vision = resolveCapability('vision', input, kind, modelLower)
  const fileInput = resolveCapability('fileInput', input, kind, modelLower)
  const tools = resolveCapability('tools', input, kind, modelLower)
  const imageOutput = resolveCapability('imageOutput', input, kind, modelLower)
  const temperature = resolveCapability('temperature', input, kind, modelLower)

  const reasoningProfile = reasoning.value
    ? withReasoningProfileOverrides(resolveProfile(kind, input.modelId, modelLower) ?? GENERIC_REASONING_PROFILE, providerProfile, modelProfile)
    : undefined
  const forcedToolUse = fromRules('forcedToolUse', PROVIDER_MODEL_RULES[kind], modelLower)
  const servedBy = resolveImageOutputServedBy(input, kind, modelLower, imageOutput)

  return {
    reasoning: reasoning.value,
    vision: vision.value,
    fileInput: fileInput.value,
    tools: tools.value,
    imageOutput: imageOutput.value,
    temperature: temperature.value,
    ...(servedBy ? { imageOutputServedBy: servedBy } : {}),
    reasoningWire:
      reasoningProfile?.wire ?? resolveReasoningWire(kind, input.modelId, modelLower) ?? 'none',
    ...(typeof forcedToolUse === 'boolean' ? { forcedToolUse } : {}),
    source: {
      reasoning: reasoning.source,
      vision: vision.source,
      tools: tools.source,
      imageOutput: imageOutput.source,
      temperature: temperature.source,
      fileInput: fileInput.source,
    },
    ...(reasoningProfile ? { reasoningProfile } : {}),
  }
}
