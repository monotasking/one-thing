/**
 * Providers Module
 * AI Provider and model-related type definitions for IPC communication
 */

import type { JsonObject } from '../json.js'
import { defineRouter } from './router.js'

// Provider IDs - can be extended by adding new providers
export type AIProviderId = 'openai' | 'claude' | 'deepseek' | 'kimi' | 'kimi-code' | 'zhipu' | 'qwen' | 'gemini' | 'codex' | 'acp' | 'custom' | string

export type ThinkingEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

// Legacy enum for backwards compatibility
export enum AIProvider {
  OpenAI = 'openai',
  Claude = 'claude',
  DeepSeek = 'deepseek',
  Kimi = 'kimi',
  /** Kimi 编程套餐(订阅),凭证走 OAuth device flow —— 与按量的 Kimi 分开。 */
  KimiCode = 'kimi-code',
  Zhipu = 'zhipu',
  Qwen = 'qwen',
  OpenRouter = 'openrouter',
  Gemini = 'gemini',
  ClaudeCode = 'claude-code',
  GitHubCopilot = 'github-copilot',
  Codex = 'codex',
  ACP = 'acp',
  /** Locally installed Claude Code CLI driven as an in-app agent. */
  ClaudeCodeAgent = 'claude-code-agent',
  Custom = 'custom',
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
}

export type ZhipuApiMode = 'standard' | 'coding-plan'

/**
 * 千问: pay-as-you-go API key vs the Token Plan / Coding Plan subscriptions.
 * Each subscription has its own key AND its own host — leaving the general one
 * in place bills pay-as-you-go on top of the subscription.
 */
export type QwenApiMode = 'standard' | 'token-plan' | 'coding-plan'
/** 千问: 国内版 (Beijing) vs 海外版 (Singapore) — separate accounts and hosts. */
export type QwenRegion = 'cn' | 'intl'

/**
 * Kimi: 开放平台按量付费 vs Kimi Code (编程套餐) — the subscription issues its
 * own key and lives on its own host (api.kimi.com), so leaving the general one
 * in place bills pay-as-you-go on top of the subscription.
 */
export type KimiApiMode = 'standard' | 'coding-plan'
/** Kimi: 国内 (api.moonshot.cn) vs 海外 (api.moonshot.ai). Only the
 *  pay-as-you-go platform is split — Kimi Code has a single global host. */
export type KimiRegion = 'cn' | 'intl'

// Per-provider configuration
export interface ProviderConfig {
  apiKey?: string           // Optional for OAuth providers
  baseUrl?: string
  zhipuApiMode?: ZhipuApiMode
  // 千问 endpoint matrix: region picks the host family, mode picks pay-as-you-go
  // vs Token Plan (which has its OWN host and its own sk-sp- key).
  qwenApiMode?: QwenApiMode
  qwenRegion?: QwenRegion
  // Kimi endpoint matrix: region picks the 开放平台 host (国内/海外), mode picks
  // pay-as-you-go vs Kimi Code (编程套餐), which has its OWN host and key.
  kimiApiMode?: KimiApiMode
  kimiRegion?: KimiRegion
  model: string             // Currently active model
  selectedModels: string[]  // List of models user has selected/enabled for quick switching
  enabled?: boolean         // Whether this provider is shown in the chat model selector
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
  // Model metadata from models.dev. Keyed by modelId.
  // Populated when user refreshes models for this provider.
  models?: Record<string, ModelCapabilityEntry>
  // Timestamp of last model fetch for this provider
  modelsLastFetched?: number
}

export interface ModelCapabilityOverride {
  tools?: boolean        // function / tool calling
  vision?: boolean       // accepts image input
  reasoning?: boolean    // supports thinking / reasoning mode
  imageOutput?: boolean  // generates images
  audio?: boolean        // accepts / emits audio
}

// User-defined custom provider
export interface CustomProviderConfig extends ProviderConfig {
  id: string  // Unique ID for the custom provider
  name: string  // User-defined display name
  description?: string  // Optional description
  apiType: 'openai' | 'anthropic'  // API compatibility type
}

/**
 * Per-model capability & pricing info stored in settings.json.
 * Populated from models.dev API when user refreshes model registry.
 */
export interface ModelCapabilityEntry {
  id: string
  name: string
  provider: string
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
}

/**
 * models.dev 目录缓存的一格。**缓存不是设置** —— 它是「这个 provider 有哪些模型」
 * 的机器级快照(~500KB),刷新一次就该所有空间同时看见,复制 N 份纯属浪费。
 * C2 把它从 `ProviderConfig` 里抬出来,单独挂在全局 `AISettings.modelCatalog`。
 */
export interface ProviderModelCatalog {
  /** Model metadata from models.dev. Keyed by modelId. */
  models?: Record<string, ModelCapabilityEntry>
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

export interface CodexUsageWindow {
  usedPercent: number
  windowSeconds?: number
  resetAfterSeconds?: number
  resetAt?: number
}

export interface CodexUsageCredits {
  hasCredits: boolean
  unlimited: boolean
  balance?: string
}

export interface CodexUsageLimit {
  id: string
  name?: string
  primary?: CodexUsageWindow
  secondary?: CodexUsageWindow
  rateLimitReachedType?: string
}

export interface CodexProviderUsage {
  planType?: string
  credits?: CodexUsageCredits
  limits: CodexUsageLimit[]
}

export interface ProviderUsageRequest {
  providerId: string
  /**
   * 用量按**哪个空间的凭证**查(C1 接批 B10 移交)。
   *
   * 凭证迁进空间池之后,后端已经没有「settings 里那一把 codex token」可用;而
   * 「当前空间」是 window 级状态,后端不持有 —— 所以由渲染层把它带上。缺席 =
   * 默认空间(旧调用方与 web 端降级路径)。
   */
  spaceId?: string
}

export interface ProviderUsageResponse {
  success: boolean
  providerId: string
  capturedAt?: number
  account?: {
    id?: string
    email?: string
    planType?: string
    isFedramp?: boolean
  }
  usage?: CodexProviderUsage
  unsupported?: boolean
  error?: string
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

export interface ModelsWithCapabilitiesRequest {
  providerId: string
  forceRefresh?: boolean
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

export type ProvidersRoutes = {
  list: { input: Record<string, never>; output: GetProvidersResponse }
  usage: { input: ProviderUsageRequest; output: ProviderUsageResponse }
  envStatus: { input: GetProviderEnvStatusRequest; output: GetProviderEnvStatusResponse }
}

export const providersRouter = defineRouter<ProvidersRoutes>('providers', [
  'list',
  'usage',
  'envStatus',
])

export type ModelsRoutes = {
  getWithCapabilities: { input: ModelsWithCapabilitiesRequest; output: ModelsListResponse }
  getAll: { input: Record<string, never>; output: ModelsListResponse }
  search: { input: ModelsSearchRequest; output: ModelsListResponse }
  refreshRegistry: { input: ModelRefreshRegistryRequest; output: ModelRefreshRegistryResponse }
  getNameAliases: { input: Record<string, never>; output: ModelNameAliasesResponse }
  getDisplayName: { input: ModelDisplayNameRequest; output: ModelDisplayNameResponse }
}

export const modelsRouter = defineRouter<ModelsRoutes>('models', [
  'getWithCapabilities',
  'getAll',
  'search',
  'refreshRegistry',
  'getNameAliases',
  'getDisplayName',
])
