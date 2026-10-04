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
 *   3. built-in rules table (each builtin vendor's manifest `modelRuleTable`;
 *                            `NON_VENDOR_MODEL_RULES` below for acp / unknown)
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
import { getProviderManifest, getProviderManifestRegistry } from './provider-manifest.js'
import { PROTOCOL_DECLARABLE_REASONING_WIRE_IDS } from './thinking/provider-thinking-protocol-wire-ids.js'
import {
  REASONING_EFFORT_LEVELS,
  resolveReasoningEffort as resolveOnethingReasoningEffort,
  type ReasoningEffortLevel,
} from '@shared/reasoning-effort.js'

// 六档梯子与「就近取一档」的读法 P4 搬进了 `@shared/reasoning-effort`(壳也读它);这里保留原名。
export type OnethingReasoningEffortLevel = ReasoningEffortLevel

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

/**
 * How the thinking intent is expressed on the wire by the owning provider —
 * a thinking-wire id. 线型由协议层与各家登记(`providers/thinking/` 与各家
 * `vendors/<id>/thinking.ts`),这里不列举;用户覆盖里哪些取值合法见
 * `isDeclarableReasoningWire`。
 */
export type OnethingReasoningWire = string

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

const REASONING_LEVELS: readonly OnethingReasoningEffortLevel[] = REASONING_EFFORT_LEVELS
/** 不是线型、但用户覆盖里合法的取值:`custom` = 按 `custom` 那一格的声明式映射编码。 */
const NON_WIRE_REASONING_VALUES: readonly string[] = ['custom']

/**
 * 用户覆盖(`reasoningProfile.wire`)里这个取值合不合法。名单不在这里手写(服务商自述试点 P3):
 * 协议层的那几条读 `PROTOCOL_DECLARABLE_REASONING_WIRE_IDS`,点了某一家名字的那几条读内置各家
 * manifest 的 `reasoningWires`,再加上非线型的 `custom`。不分是哪一家的覆盖 —— 从前那张手写
 * 名单就是全局的。
 */
function isDeclarableReasoningWire(value: unknown): value is OnethingReasoningWire {
  if (typeof value !== 'string') return false
  if (PROTOCOL_DECLARABLE_REASONING_WIRE_IDS.includes(value) || NON_WIRE_REASONING_VALUES.includes(value)) return true
  return getProviderManifestRegistry()
    .list()
    .some((manifest) => manifest.origin === 'builtin' && manifest.reasoningWires?.includes(value) === true)
}
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
    if (!isDeclarableReasoningWire(value.wire)) return undefined
    result.wire = value.wire
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

export { resolveOnethingReasoningEffort }

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
  /**
   * 接口没报的那几项(批 3 直连拉目录,`OnethingModelCapabilityEntry.unreported`)。
   * 在表里 = 条目对这一项**没说话**,落到下面的元数据 / 型号规则表,而不是读那个 `false`。
   */
  unreported?: readonly string[]
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

/**
 * 型号规则表 id(manifest 的 `modelRules`)。表由带它的那一家的 `modelRuleTable` 给出,不是服务商
 * 也不属于任何一家的两张(`acp` / `unknown`)在下面的 `NON_VENDOR_MODEL_RULES`。这里不列举。
 */
export type OnethingProviderKind = string

/**
 * 这家的模型按哪张型号规则表判 —— 读 manifest 的 `modelRules`(批 M),不点名。
 * 未登记的 id = `unknown`。
 *
 * 第二个参数是旧签名留下的:自定义服务商的 `apiType` 已经在它的 manifest 里
 * (`manifestOfCustomProvider` 按它算 `modelRules`),这里不再读 —— 从前它只在
 * id 带 `custom-` 前缀时才生效,拿它给任意未登记 id 兜底会把别家的型号按 openai 表判。
 */
export function resolveOnethingProviderKind(
  providerId: string,
  _customApiType?: 'openai' | 'anthropic',
): OnethingProviderKind {
  return getProviderManifest(providerId)?.modelRules ?? 'unknown'
}

// ---------------------------------------------------------------------------
// Shared effort tables and budgets (single copy — UI options, provider clamps,
// and thinking budgets all read from here)
// ---------------------------------------------------------------------------

// OpenRouter / DeepSeek / 千问 3.8-Max / xAI / Codex 的档位值域随各家的型号规则表搬回了各自的
// `vendors/<id>/manifest.ts`(服务商自述试点 P2)。Claude / Gemini / OpenAI 型号的档位与思考预算
// 说的是型号家族,不是哪一家服务商,住 `providers/model-families/<family>.ts`(P2 第 2 / 4 批)。

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

export interface OnethingModelRule {
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

/** Generic fallbacks used when the provider kind is unknown (matches the old renderer heuristics). */
const GENERIC_REASONING_PATTERN = /o1|o3|o4|deepseek-r1|reasoner|grok-3-mini|grok-mini|thinking/
const GENERIC_IMAGE_GEN_PATTERN = /dall-e|dalle|gpt-image|imagen|stable-diffusion|midjourney/

/**
 * 不属于任何一家内置服务商的两张规则表:外部 agent(`acp`,它不是服务商,是外部执行体那条路的
 * 占位)与认不出的家(`unknown`)。内置服务商的表全部由各家 manifest 自己带(`modelRuleTable`,
 * 服务商自述试点 P2 第 4 批起一家不剩)。
 */
const NON_VENDOR_MODEL_RULES: Partial<Record<OnethingProviderKind, OnethingModelRule[]>> = {
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
 * 字面量与 `vendors/codex/codex-native-tools.ts` 的
 * `CODEX_NATIVE_IMAGE_GENERATION_TOOL` 同值;此文件必须保持零 import(渲染
 * 层与 web 构建直接引它),所以不从那里 import。
 *
 * **模块内部函数**:P2-b 之后账本自己把这条证据折成
 * `imageOutputServedBy: 'in-loop'`,外面(`provider-model-registry.ts` 的生图路由判据)
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
  if (entry && !entry.unreported?.includes(capability)) {
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

/**
 * 这张型号规则表从哪来:内置服务商由自己的 manifest 带(`modelRuleTable`);
 * 外部 agent 与认不出的家读上面的 `NON_VENDOR_MODEL_RULES`。
 */
function rulesOf(kind: OnethingProviderKind): readonly OnethingModelRule[] {
  for (const manifest of getProviderManifestRegistry().list()) {
    if (manifest.origin === 'builtin' && manifest.modelRules === kind && manifest.modelRuleTable) {
      return manifest.modelRuleTable
    }
  }
  return NON_VENDOR_MODEL_RULES[kind] ?? []
}

function fromRules(
  capability: OnethingModelRuleCapsKey,
  rules: readonly OnethingModelRule[],
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
    const ruled = fromRules(capability, rulesOf(kind), modelLower)
    if (typeof ruled === 'boolean') return verdict(ruled, 'pattern')
    const registry = fromRegistry(capability, input.registryEntry, input.modelMetadata)
    if (typeof registry === 'boolean') return verdict(registry, 'registry')
    return verdict(CAPABILITY_DEFAULTS.temperature, 'default')
  }

  const registry = fromRegistry(capability, input.registryEntry, input.modelMetadata)
  if (typeof registry === 'boolean') return verdict(registry, 'registry')

  const ruled = fromRules(capability, rulesOf(kind), modelLower)
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
  for (const rule of rulesOf(kind)) {
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
  for (const rule of rulesOf(kind)) {
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
  const forcedToolUse = fromRules('forcedToolUse', rulesOf(kind), modelLower)
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
