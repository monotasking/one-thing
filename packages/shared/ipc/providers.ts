/**
 * Providers Module
 * AI Provider and model-related type definitions for IPC communication
 */

import type { JsonObject } from '../json.js'
import type { ProviderDialDescriptor } from '../provider-dials.js'
import type { ProviderFamilyInfo } from '../provider-families.js'
import { defineRouter } from './router.js'
import type { ProviderQuota } from '../contracts/quota.js'
import type { CustomAdapterSpec, CustomReasoningMapping } from '../contracts/adapter-spec.js'

export type { CustomAdapterSpec, CustomReasoningMapping } from '../contracts/adapter-spec.js'

/**
 * 服务商 id。**是数据,不是写死的名单**(服务商自述试点 P3):内置各家的名册在 runtime 的
 * `packages/backend/runtime/providers/vendors/manifests.ts`(每家一行),自定义服务商的
 * id 来自设置。契约层不列举任何一家。
 */
export type AIProviderId = string

export type ThinkingEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Declarative provider default or per-model reasoning configuration. */
export interface ReasoningProfileOverride {
  toggleable?: boolean
  defaultOn?: boolean
  efforts?: (ThinkingEffort | 'none')[]
  defaultEffort?: ThinkingEffort
  disabledEffort?: ThinkingEffort
  /**
   * 思考参数的线型 id。线型由协议层与各家登记(哪些取值合法由 runtime 的
   * `normalizeOnethingReasoningProfileOverride` 判),契约层不列举。
   */
  wire?: string
  effortLabels?: Partial<Record<ThinkingEffort, string>>
  /** 声明式思考映射(形状住在 `@shared/contracts/adapter-spec`,批 4 的适配表复用同一份)。 */
  custom?: CustomReasoningMapping | null
}

// OAuth flow types
export type OAuthFlowType = 'authorization-code' | 'device'

// OAuth token structure
export interface OAuthToken {
  accessToken: string
  refreshToken?: string
  expiresAt: number        // Timestamp in milliseconds
  tokenType: string        // e.g., 'Bearer'
  scope?: string           // OAuth scopes
  idToken?: string
  accountId?: string
  email?: string
  planType?: string
  isFedrampAccount?: boolean
  providerMetadata?: JsonObject
}

/**
 * OpenRouter Model Definition (直接使用 OpenRouter API 字段)
 */
export interface OpenRouterModel {
  id: string
  name: string
  /**
   * 这一行的目录条目从哪来(批 2,`docs/design/provider-settings-rework-2026-09.md` §4)。
   * 缺席读作 `'models.dev'`。`'manual'` = 用户手填的那一条:目录只知道它的 id,
   * 下面的容量 / 价格 / 能力**一格都没有**(形状上仍按旧信封声明成必填,读的人
   * 必须把缺席当「不知道」,而不是 0 / 不支持)。
   */
  source?: ModelEntrySource
  description?: string
  context_length: number
  architecture: {
    modality: string
    input_modalities: string[]  // 'text', 'image', 'file', 'audio', 'video'
    output_modalities: string[] // 'text', 'image', 'embeddings'
    tokenizer: string
  }
  pricing: {
    prompt: string
    completion: string
    request: string
    image: string
  }
  top_provider: {
    context_length: number
    max_completion_tokens: number
    is_moderated: boolean
  }
  supported_parameters: string[]  // 'temperature', 'tools', 'reasoning', 'response_format', etc.
  // ISO-ish date string from models.dev (e.g. "2025-11-18"). Used to sort the
  // model list newest-first in settings. Absent for custom-added or provider-direct
  // entries — those sort to the end.
  last_updated?: string
  providerMetadata?: JsonObject
  /**
   * 接口没报的那几项(批 3 §6.2 直连拉目录)。在表里 = **不知道**,不是「不支持」——
   * 只报了 id 的 `/models` 不是在说「这些模型都不支持工具」。缺席 = 全报了。
   */
  unreported?: ModelUnreportedFact[]
  // ── 思考档位的投影(2026-09-05,输入框的模型选择器)────────────────────────
  // 真相在 `runtime/providers/model-capability.ts` 的 `OnethingReasoningProfile`,
  // 这四格是它的**只读投影**,由 `models.getWithCapabilities` 一次一家地填。
  // **可选**是因为这个信封有别的产地(测试夹具、旧缓存):缺席读作「这一发没投
  // 影过」,屏幕上与「这一型不思考」同一个样子(不写档),而不是编一个档出来。
  //
  // `thinkingLevels`: 这一型能选的档(`efforts` 滤掉 `'none'` —— 那是线协议
  // 标记不是档);`null` = 这一型不思考;`[]` = 能开关但没有档可挑。
  thinkingLevels?: ThinkingEffort[] | null
  // 用户能不能把思考关掉(o 系 / gpt-5 系 / grok / kimi code 永远思考)。
  thinkingToggleable?: boolean
  // 什么参数都不发时服务端到底思不思考(`profile.defaultOn`)。药丸要靠它
  // 回答「没设过档的时候屏幕上该写什么」—— 发送链在这一档一个参数都不发。
  thinkingDefaultOn?: boolean
  // 什么档都没设时的有效档(`profile.defaultEffort`);`null` = 这一型不思考。
  thinkingDefaultLevel?: ThinkingEffort | null
  thinkingDisabledLevel?: ThinkingEffort | null
  thinkingLevelLabels?: Partial<Record<ThinkingEffort, string>>
  /**
   * **这一型此刻按多少算**(§5.5,`docs/design/provider-settings-rework-2026-09.md`)——
   * 「用户覆盖 > 接口报的 / 目录 > 不知道」在后端一处折好(`runtime/providers/
   * effective-model.ts` 的 `effectiveModelFactsOf`,引擎读的也是它),壳只读不折。
   * 上面那几格旧信封字段(`context_length` / `supported_parameters` …)仍是**目录自己
   * 说的**那一份(未经覆盖),行上「目录原值」从那里读。
   *
   * 可选:这个信封有别的产地(测试夹具、旧缓存),缺席 = 这一发没投影过。
   * `models.getWithCapabilities` 每行都填。
   */
  effective?: ModelEffectiveFacts
  /**
   * 参数建议(批 3 §6.3):接口不报参数时,从 models.dev 里**确定性地**认出这一型大概是谁
   * (`runtime/providers/model-identity.ts`,不用 AI),拿那一型的值给「不知道」的那几格
   * 一个建议。只在 `effective.source.* === 'unknown'` 的格上出现;点了才写进覆盖表,
   * 写了之后那一格不再 unknown,建议自然消失。`models.getWithCapabilities` 填它。
   */
  suggestion?: ModelParameterSuggestion
}

/** 能覆盖、会上屏的五项能力(`ModelCapabilityOverride` 里除 `audio` 之外的那五键)。 */
export type ModelCapabilityKey = 'tools' | 'vision' | 'reasoning' | 'imageOutput' | 'fileInput'

/**
 * 一格事实是谁说的:`override` 用户覆盖表 / `endpoint` 那家自己的 `/models` 真报了 /
 * `catalog` models.dev / `unknown` 谁都没说(值为 null,**不编**)。
 */
export type ModelFactSource = 'override' | 'endpoint' | 'catalog' | 'unknown'

export interface ModelEffectiveFacts {
  /** null = 不知道。引擎的 128k 兜底只在引擎里,不在这里。 */
  contextLength: number | null
  /** null = 不知道(请求里不带 max_tokens)。 */
  maxOutput: number | null
  capabilities: Record<ModelCapabilityKey, boolean | null>
  /** 能力账本裁定的思考档位;null = 不思考 / 没裁定。 */
  reasoningProfile: ReasoningProfileOverride | null
  source: {
    contextLength: ModelFactSource
    maxOutput: ModelFactSource
    /** 逐项:行上「人说不支持」(划掉)与「目录说不支持」(不画)要分得开。 */
    capabilities: Record<ModelCapabilityKey, ModelFactSource>
  }
}

/**
 * 接口没报的那一项(批 3 §6.2)。与 `ModelCapabilityKey` 同名的五项 + 温度。
 */
export type ModelUnreportedFact = ModelCapabilityKey | 'temperature'

/**
 * 从目录里认出的「这一型大概是谁」给的参数建议(批 3 §6.3)。能力只建议「支持」的那几项;
 * 参考价不进建议(转发站的价不等于官方价)。
 */
export interface ModelParameterSuggestion {
  /**
   * 认的是哪一家的哪一型(models.dev 的 provider 键 + 模型 id)。`providerName` 是
   * models.dev 自己写的那家的名字(数据,不是句子),壳拼「按 {provider} {model} 填」用。
   */
  from: { provider: string; id: string; providerName?: string }
  contextLength?: number
  maxOutput?: number
  capabilities?: Partial<Record<ModelCapabilityKey, boolean>>
  reasoningProfile?: ReasoningProfileOverride
}

// Provider metadata for UI display
export interface ProviderInfo {
  id: string
  name: string
  description: string
  defaultBaseUrl: string
  defaultModel: string
  icon: string
  supportsCustomBaseUrl: boolean
  requiresApiKey: boolean
  // OAuth-specific fields
  requiresOAuth?: boolean            // Whether this provider uses OAuth instead of API key
  oauthFlow?: OAuthFlowType          // Type of OAuth flow (PKCE or Device)
  // Model definitions (from OpenRouter API)
  models?: OpenRouterModel[]
  /**
   * 服务商自述的三格纯数据(服务商自述试点 P4):后端由各家 manifest 投影后下发,壳只读这里,
   * 不再 import runtime 的服务商代码。都只在「有」时出现。
   *  - `dials`:计费档位(选项 / 缺省 / 端点表),读法在 `@shared/provider-dials`;
   *  - `hasQuota`:这家有配额 / 余额源;
   *  - `family`:家族信息(哪个家族、哪一半、另一半是谁),读法在 `@shared/provider-families`。
   */
  dials?: ProviderDialDescriptor
  hasQuota?: boolean
  family?: ProviderFamilyInfo
}

// Per-provider configuration
export interface ProviderConfig {
  providerOptions?: { reasoningProfile?: ReasoningProfileOverride; [key: string]: unknown }
  apiKey?: string           // Optional for OAuth providers
  baseUrl?: string
  // 各家的档位格(接口模式 / 地区)也存在这一层,键名由 runtime 里那一家 manifest 的
  // `dials.apiModeKey` / `regionKey` 声明;契约层不点名,读写一律按键(壳:`providers/dials.ts`)。
  model: string             // Currently active model
  selectedModels: string[]  // List of models user has selected/enabled for quick switching
  enabled?: boolean         // Whether this provider is shown in the chat model selector
  /**
   * 订阅那一家的「订阅额度用完时切到 API 密钥」(批 6 §9.2,拍点 7)。缺席 = 开;只有
   * `false` 是关。只在订阅那一家的格上有意义 —— 它说的是「这一家用完了接给同家 API」。
   */
  subscriptionFallback?: boolean
  // OAuth-specific fields (used when provider.requiresOAuth = true)
  authType?: 'apiKey' | 'oauth'  // Authentication method
  oauthToken?: OAuthToken        // Stored OAuth token (encrypted in storage)
  // Per-provider sampling temperature. Undefined = inherit AISettings.temperature (global default).
  // Used only as a fallback when a per-model override isn't set (see temperatureByModel).
  temperature?: number
  // Per-model temperature overrides. Keys are model IDs (e.g. "gpt-4o").
  temperatureByModel?: Record<string, number>
  // Per-model max output token overrides. Keys are model IDs (e.g. "deepseek-chat").
  maxOutputByModel?: Record<string, number>
  // Per-model context-window overrides. Keys are model IDs. Needed for models
  // the registry has never heard of (hand-added, self-hosted), where the
  // 128k fallback would mis-budget context compaction.
  contextLengthByModel?: Record<string, number>
  // Per-model native-thinking toggle. Keys are model IDs (e.g. "deepseek-v4-pro").
  thinkingByModel?: Record<string, boolean>
  // Per-model thinking effort. Codex supports minimal/low/medium/high/xhigh;
  // DeepSeek keeps high/max. Codex maps max to high at the provider boundary.
  thinkingEffortByModel?: Record<string, ThinkingEffort>
  // Per-model service tier. Codex uses this for speed controls; missing = Auto/default.
  serviceTierByModel?: Record<string, string>
  // Per-model capability overrides. Keys are model IDs.
  modelCapabilitiesByModel?: Record<string, ModelCapabilityOverride>
  // 这一家的目录,按 modelId 键。models.dev / 服务商接口刷新时整体替换**非手填**
  // 的那一半;手填条目(`source: 'manual'`)只由 `models.addManual/removeManual` 写。
  models?: Record<string, CatalogModelEntry>
  // Timestamp of last model fetch for this provider
  modelsLastFetched?: number
  /**
   * 批 M §5.3 三格(批 3 起壳上有写面:自定义服务商对话框的「高级」)。
   *  - `headers`:每个请求都带;值里 `{{apiKey}}` 发送时换成当前凭证;有 `Authorization`
   *    头时不再加默认 Bearer。存明文(与 `baseUrl` 一样),密钥仍只在密钥池。
   *  - `modelsUrl`:模型列表地址;空 = `baseUrl + '/models'`,相对路径接在 `baseUrl` 后。
   *  - `dialect`:覆盖 manifest 的方言(已登记方言 id)。
   */
  headers?: Record<string, string>
  modelsUrl?: string
  dialect?: string
}

export interface ModelCapabilityOverride {
  reasoningProfile?: ReasoningProfileOverride
  tools?: boolean        // function / tool calling
  vision?: boolean       // accepts image input
  reasoning?: boolean    // supports thinking / reasoning mode
  imageOutput?: boolean  // generates images
  audio?: boolean        // accepts / emits audio
  fileInput?: boolean    // accepts file attachments (PDF) — ruling #12, not a vision rider
}

// User-defined custom provider
export interface CustomProviderConfig extends ProviderConfig {
  id: string  // Unique ID for the custom provider
  name: string  // User-defined display name
  description?: string  // Optional description
  /**
   * 旧的兼容形(批 3 之前的唯一一格)。**读时兼容**:`dialect` 缺席时
   * `anthropic` → `custom-anthropic`,其余 → `custom-openai`。新写的条目写 `dialect`。
   */
  apiType?: 'openai' | 'anthropic'
  /**
   * 「自动识别」产出、用户点了「应用」才写进来的适配表(批 4 §7)。有它 = 这一家的方言是
   * 由它编译出来的 `custom:<id>`;没有 = 与批 4 之前逐字一致。
   */
  adapter?: CustomAdapterSpec
}

/** `providers.probeCustom` 的入参(批 4 §7.3)。`spaceId` 决定分析模型从哪个空间找。 */
export interface ProbeCustomProviderRequest {
  baseUrl: string
  apiKey?: string
  headers?: Record<string, string>
  modelsUrl?: string
  hintModel?: string
  spaceId?: string
}

/**
 * 失败 / 旁注的原因码(R12:后端答码不答句子,壳查自己的字典)。
 *  - `unreachable`:两发探测都没拿到能认的响应;
 *  - `unrecognized`:响应来了,但四条线一条都对不上;
 *  - `verify-failed`:生成的适配表重放样本不过;
 *  - `analysis-failed`:分析模型没答出一张能用的表;
 *  - `no-analyst`:需要分析但没有能用的模型,只走了规则(可以与 `ok: true` 同在)。
 */
export type ProbeCustomReasonKind =
  | 'unreachable'
  | 'unrecognized'
  | 'verify-failed'
  | 'analysis-failed'
  | 'no-analyst'

/** 一句人话的**键 + 变量**,壳拼句子。`wireLabelKey` 是壳字典里的键(`providers.dialect.<id>`)。 */
export interface ProbeCustomSummary {
  wireLabelKey: string
  /** 这条线对应的方言(应用时写进表单的「接口类型」)。 */
  dialect: string
  reasoningPath?: string
  modelCount: number
}

export interface ProbeCustomProviderResponse {
  ok: boolean
  spec?: CustomAdapterSpec
  summary?: ProbeCustomSummary
  /** 接口 / 回验的原话(壳放 Tooltip)。 */
  error?: string
  reasonKind?: ProbeCustomReasonKind
  /** 这一次有没有请分析模型(门 ③ 读它:规则判满时必须是 false)。 */
  analyzed?: boolean
}

/** 自定义服务商对话框「接口类型」下拉的一项(`providers.listDialects`)。 */
export interface DialectOption {
  /** 已登记方言 id。壳按 `providers.dialect.<id>` 查自己的字典。 */
  id: string
  /** 方言自述的英文人话名(字典里没有这一格时的后备)。 */
  label: string
}

export interface ListDialectsResponse {
  success: boolean
  dialects?: DialectOption[]
  error?: string
}

/**
 * 一条目录条目的出处(批 2)。缺席读作 `'models.dev'`,老数据不迁移。
 *  - `'models.dev'` —— models.dev 目录刷新写的;
 *  - `'endpoint'`   —— 服务商自己的模型列表接口写的(Codex / Copilot 那一口);
 *  - `'manual'`     —— 用户手填。只有 id,**没有任何参数**(见 `ManualModelEntry`)。
 */
export type ModelEntrySource = 'models.dev' | 'endpoint' | 'manual'

/**
 * Per-model capability & pricing info stored in settings.json.
 * Populated from models.dev API when user refreshes model registry.
 */
export interface ModelCapabilityEntry {
  id: string
  name: string
  provider: string
  /** 缺席 = `'models.dev'`。手填条目不是这个形状,见 `ManualModelEntry`。 */
  source?: 'models.dev' | 'endpoint'
  /** Max context window (input tokens) */
  contextLength: number
  /** Max output tokens per request */
  maxOutputTokens: number
  supportsTools: boolean
  supportsVision: boolean
  supportsReasoning: boolean
  supportsImageOutput: boolean
  supportsTemperature: boolean
  inputModalities: string[]
  outputModalities: string[]
  /** Pricing in USD per 1M tokens */
  pricing: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
  }
  /** Release date from models.dev (ISO format) */
  lastUpdated?: string
  /** Provider-specific metadata such as Codex reasoning levels and service tiers. */
  providerMetadata?: JsonObject
  /** 接口没报的那几项(批 3):读者按「不知道」处理。缺席 = 全报了。 */
  unreported?: ModelUnreportedFact[]
}

/**
 * 手填模型的目录条目(批 2)。**参数全空**:没有上下文、没有价格、能力一格都没有 ——
 * 不是「都不支持」,是「没人说过」。用户要补参数走逐模型覆盖表
 * (`contextLengthByModel` / `modelCapabilitiesByModel` …),不写进这一条。
 */
export interface ManualModelEntry {
  id: string
  /** = id。 */
  name: string
  provider: string
  source: 'manual'
}

/** 目录里的一条:有参数的(models.dev / 接口)或手填的。 */
export type CatalogModelEntry = ModelCapabilityEntry | ManualModelEntry

/**
 * models.dev 目录缓存的一格。**缓存不是设置** —— 它是「这个 provider 有哪些模型」
 * 的机器级快照(~500KB),刷新一次就该所有空间同时看见,复制 N 份纯属浪费。
 * C2 把它从 `ProviderConfig` 里抬出来,单独挂在全局 `AISettings.modelCatalog`。
 */
export interface ProviderModelCatalog {
  /** Model metadata from models.dev (+ 手填条目). Keyed by modelId. */
  models?: Record<string, CatalogModelEntry>
  /** Timestamp of last model fetch for this provider. */
  modelsLastFetched?: number
}

/**
 * **一个空间的整套 provider 设置**(C2)—— 落盘在 `workspaces/<id>/providers.json`。
 *
 * 用户 08-18 原话:「不同的空间,provider 设置应该是完整的、独立的两套。对齐。」
 * 于是形状 = 旧的 `AISettings` 减去两样:
 *
 * - **凭证**(apiKey / oauthToken):留在同空间的 `credentials.json` 凭证池 ——
 *   多把 key 轮换需要池,一格装不下。
 * - **models.dev 目录缓存**(`models` / `modelsLastFetched`):见
 *   `ProviderModelCatalog`,缓存全局一份。
 *
 * 其余全部 per-space 且**无回落**:空间即空间。默认 provider/model、每个 provider
 * 的 enabled / selectedModels / provider 级 baseUrl 与档位、逐模型的
 * 上下文·最大输出·思考档位覆盖、自定义 provider 定义,都在这里。
 */
export interface SpaceProviderSettings {
  /** 这个空间的默认 provider。空串 = 这个空间还没选过(空白空间的初值)。 */
  provider: string
  /** 这个空间的采样温度。缺席 = 用全局缺省。 */
  temperature?: number
  /** 每个 provider 在这个空间的配置。键缺席 = 这个空间没配过它。 */
  providers: Record<string, ProviderConfig>
  /** 自定义 provider 的**定义**(不含凭证)。C2 起也是 per-space。 */
  customProviders: CustomProviderConfig[]
}

/**
 * **全局 AI 设置**(`settings.json` 的 `ai` 段)—— C2 之后只剩目录缓存。
 *
 * `provider` / `providers` / `customProviders` 已经**搬进** per-space 的
 * `SpaceProviderSettings`(见上)。这里留下的两格都不是「设置」:`temperature`
 * 是空间没表达时的机器级缺省,`modelCatalog` 是 models.dev 的目录快照。
 */
export interface AISettings {
  temperature: number
  /** provider id → models.dev 目录缓存。全空间共享。 */
  modelCatalog: Record<string, ProviderModelCatalog>
}

/**
 * **生效形状** = 某个空间的 `SpaceProviderSettings` + 全局目录缓存。
 *
 * 这是运行期与渲染层实际拿在手里的那份(`AppSettings.ai` 就是它):解析链、
 * 设置页、模型选择器读的都是「当前空间的设置,叠上全局目录」。落盘时由
 * `app/stores/settings.ts` 拆回两边 —— 拆分点只此一处。
 */
export interface EffectiveAISettings extends AISettings {
  provider: string
  providers: {
    [key: string]: ProviderConfig
  }
  customProviders?: CustomProviderConfig[]
}

// Models related types
export type ModelType = 'chat' | 'image' | 'embedding' | 'audio' | 'tts' | 'other'

export interface ModelInfo {
  id: string
  name: string
  description?: string
  createdAt?: string
  type?: ModelType
}

// Providers related types
export interface GetProvidersResponse {
  success: boolean
  providers?: ProviderInfo[]
  error?: string
}

export interface ProviderQuotaRequest {
  providerId: string
  /**
   * 按**哪个空间的凭证池**查。「当前空间」是 window 级状态,后端不持有 —— 所以由
   * 渲染层带上。缺席 = 默认空间。
   */
  spaceId?: string
  /**
   * 查池里**哪一条**凭证(设置页的每行余额 / 多账号每号一组条)。缺席 = 「这一发会用
   * 哪条」—— 密钥策略的只读 `decide`,composer 读数卡问的就是它。
   */
  credentialId?: string
  /** 设置页「刷新」:绕过 60 秒缓存。429 之后的 10 分钟静默期**不**被它绕过。 */
  force?: boolean
}

export interface ProviderQuotaResponse {
  quota: ProviderQuota
  /** 这份配额属于哪一条凭证(env 兜底 / 未配置时缺席)。 */
  credentialId?: string
}

export interface ProviderEnvVarCandidate {
  name: string
  isSet: boolean
}

export interface ProviderEnvStatus {
  providerId: string
  detectedEnvVar?: string
  resolvedEnvVar?: string
  keyPreview?: string
  candidates: ProviderEnvVarCandidate[]
}

export interface GetProviderEnvStatusRequest {
  providerId: string
}

export interface GetProviderEnvStatusResponse {
  success: boolean
  status?: ProviderEnvStatus
  error?: string
}

// ── 通用 RPC 通道上的两个域(主线 T1 第二批)────────────────────────────
//
// providers 与 models 都是纯查询/注册表读写:零窗口、零流式、零事件推送。
// 迁移前 desktop 走 `models:*` / `providers:*` 手写通道,web 走 `/api/models*`
// 与 `/api/providers*`;两侧各一份实现。现在两侧共用 `@onething/backend` 的
// provider 注册表与 model registry。

export interface ModelsListResponse {
  success: boolean
  models?: OpenRouterModel[]
  error?: string
}

/**
 * 手填模型的两个写动词(批 2 · 手填模型 = 目录条目)。
 *
 * 手填是**目录里的一条** `source: 'manual'` 条目(参数全空)+ 这个空间里勾上;目录全空间
 * 共享(`ai.modelCatalog`),勾选是这个空间的(`workspaces/<id>/providers.json`)。
 * 两半一发写完,所以写面在后端 —— 壳不直接写 `config.models`。
 */
export interface ModelManualEditRequest {
  providerId: string
  modelId: string
  /** 勾选写进哪个空间。缺席 = 默认空间。 */
  spaceId?: string
}

/**
 * 失败原因码(壳查自己的字典,后端不写句子):
 *  - `empty`         —— id 是空的;
 *  - `duplicate`     —— 这个空间里已经勾着;
 *  - `not-manual`    —— 要删的不是手填条目(目录条目只能取消勾选);
 *  - `last-selected` —— 它是勾着的最后一个,删了就一个都不剩;
 *  - `unknown-space` —— 空间不存在。
 */
export type ModelManualEditFailure =
  | 'empty'
  | 'duplicate'
  | 'not-manual'
  | 'last-selected'
  | 'unknown-space'

export interface ModelManualEditResponse {
  success: boolean
  reason?: ModelManualEditFailure
  error?: string
  /** 写完之后这个空间那一份 provider 设置(与 `spaces.setProviderSettings` 回的同形)。 */
  ai?: SpaceProviderSettings
}

export interface ModelsWithCapabilitiesRequest {
  providerId: string
  forceRefresh?: boolean
  /**
   * 每行 `effective` 里的**用户覆盖**读哪个空间的(覆盖表住在 per-space 的
   * `workspaces/<id>/providers.json`)。缺席 = 默认空间。目录本身全空间共享,与它无关。
   */
  spaceId?: string
}

export interface ModelsSearchRequest {
  query: string
  providerId?: string
}

/**
 * Empty = refresh every configured provider from models.dev (the manual
 * button). `providerId` = only that provider — the store uses it when a
 * provider's catalog key moved (千问/Kimi 计费方式·地区), so the list under
 * the new endpoint is re-pulled without touching everyone else's.
 */
export interface ModelRefreshRegistryRequest {
  providerId?: string
}

export interface ModelRefreshRegistryResponse {
  success: boolean
  error?: string
}

export interface ModelNameAliasesResponse {
  success: boolean
  aliases?: Record<string, string>
  error?: string
}

export interface ModelDisplayNameRequest {
  modelId: string
}

export interface ModelDisplayNameResponse {
  success: boolean
  displayName?: string
  error?: string
}

/**
 * 「这条线上的这个模型,渲染层该开哪几个口」(P4-7)。
 *
 * 与 `getWithCapabilities` 是两件事:那一条回的是**目录**(models.dev / 各家
 * /models 的条目),这一条回的是**这条线真正接得住什么** —— 账本(能不能)
 * ∧ provider 的传输声明(这条线的 codec 放不放得上去)。渲染层拿不到后者,
 * 所以必须问后端:`deepseek-*-vision-exp` 读图不吃 PDF,`supportsFiles` 从此
 * 不再是 `supportsVision` 的别名。
 */
export interface ModelCapabilitiesRequest {
  providerId: string
  model: string
}

/** 只投影渲染层真正用得上的那几位,不把整份 `AgentModelCapabilities` 端出去。 */
export interface RendererModelCapabilities {
  supportsVision: boolean
  supportsFiles: boolean
  supportsImageOutput: boolean
  /**
   * 思考档位那四格 —— 与 `OpenRouterModel` 上同名四格**逐字同义**
   * (同一个 `OnethingReasoningProfile` 的同一份投影,产地是
   * `projectOnethingThinkingLevels`)。一致性:同一件事实在两条口上不该有两种形状。
   * 可选,理由与那边同一条:这一发没投影过 ≠ 这一型不思考。
   */
  thinkingLevels?: ThinkingEffort[] | null
  thinkingToggleable?: boolean
  thinkingDefaultOn?: boolean
  thinkingDefaultLevel?: ThinkingEffort | null
  thinkingDisabledLevel?: ThinkingEffort | null
  thinkingLevelLabels?: Partial<Record<ThinkingEffort, string>>
}

export interface ModelCapabilitiesResponse {
  success: boolean
  capabilities?: RendererModelCapabilities
  error?: string
}

export type ProvidersRoutes = {
  list: { input: Record<string, never>; output: GetProvidersResponse }
  /** 有人话名的已登记方言(批 3 §6.1:自定义服务商的「接口类型」下拉)。只读。 */
  listDialects: { input: Record<string, never>; output: ListDialectsResponse }
  /** 配额与余额(批 5,§8.3)。从前叫 `usage`,只答得出 Codex。 */
  quota: { input: ProviderQuotaRequest; output: ProviderQuotaResponse }
  probeCustom: { input: ProbeCustomProviderRequest; output: ProbeCustomProviderResponse }
  envStatus: { input: GetProviderEnvStatusRequest; output: GetProviderEnvStatusResponse }
}

export const providersRouter = defineRouter<ProvidersRoutes>('providers', [
  'list',
  'listDialects',
  'quota',
  'probeCustom',
  'envStatus',
])

export type ModelsRoutes = {
  getWithCapabilities: { input: ModelsWithCapabilitiesRequest; output: ModelsListResponse }
  getAll: { input: Record<string, never>; output: ModelsListResponse }
  search: { input: ModelsSearchRequest; output: ModelsListResponse }
  refreshRegistry: { input: ModelRefreshRegistryRequest; output: ModelRefreshRegistryResponse }
  getNameAliases: { input: Record<string, never>; output: ModelNameAliasesResponse }
  getDisplayName: { input: ModelDisplayNameRequest; output: ModelDisplayNameResponse }
  getModelCapabilities: { input: ModelCapabilitiesRequest; output: ModelCapabilitiesResponse }
  /** 手填一个模型:写一条手填目录条目 + 在这个空间勾上。 */
  addManual: { input: ModelManualEditRequest; output: ModelManualEditResponse }
  /** 删一条手填目录条目(行尾 ✕)并从这个空间的勾选里去掉;是当前模型时换到第一个勾选的。 */
  removeManual: { input: ModelManualEditRequest; output: ModelManualEditResponse }
}

export const modelsRouter = defineRouter<ModelsRoutes>('models', [
  'getWithCapabilities',
  'getAll',
  'search',
  'refreshRegistry',
  'getNameAliases',
  'getDisplayName',
  'getModelCapabilities',
  'addManual',
  'removeManual',
])
