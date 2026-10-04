// 服务商(providers)功能入口。
//
// 这个功能回答两件事:「有哪些服务商、每一家怎么说」与「这一轮该怎么把请求拼成那一家的线协议」。它住着各家的自述表
// (manifest)与两份名册(数据名册 `vendors/provider-vendor-manifests.ts`、行为名册 `vendors/provider-vendor-runtimes.ts`)、模型目录的事实与纯逻辑、
// 生效配置的解析规则、线协议与各家方言、不带宿主能力的 AgentProvider 工厂、配额取数与计价。用服务商干活的那一半
// (发一轮对话、按空间取凭证与设置、模型目录服务)不在这里,分别在 engine、credentials、sessions、settings 里,
// 它们只经这个入口拿名字。
//
// 对外交出的东西按类分组,见下面每一段的小标题:服务商自述与名册;服务商定义与注册表;模型目录与能力;生效配置与凭证解析;
// 造 AgentProvider 与线协议;对话门面与请求拼装;界面形状的投影;配额、计价与诊断;旧接口类型。
// 只用具名导出,不用 `export *`(决策 N3;一个 `export *` 全交出去的入口曾与 settings / sessions 连成 60 只模块的环)。
// 目录里的文件互相按相对路径引用,不经这个入口。
//
// 它依赖的功能(都是对方的叶子文件):network(受管 fetch、OAuth 协议小件)、logging、storage、agent-loop 的循环原语、
// engine 的内核件(`error-details`、`engine-primitives`,engine 归位时归 agent-loop)、agents 的外部 agent 执行器谓词、
// tools 的两只纯模块,以及 `@shared`。

// ── 服务商自述与名册:每一家是谁、用哪份方言、怎么登录、模型从哪来;两份名册每家一行,交出名册不点名任何一家。
export {
  getProviderManifest,
  getProviderManifestRegistry,
  isSubscriptionProvider,
  manifestOfCustomProvider,
  resetProviderManifestRegistryForTests,
} from './provider-manifest.js'
export type { CustomProviderManifestSource, ProviderManifest } from './provider-manifest.js'
export { BUILTIN_PROVIDER_MANIFESTS, builtinProviderFamilyLookup, EXTERNAL_AGENT_DIALECT_ID } from './provider-builtin-manifests.js'
export { onethingBaseBuiltinProviders, providerInfoOfManifest } from './provider-builtin-info.js'
export { VENDOR_SEED_ORDER } from './vendors/provider-vendor-manifests.js'
export { VENDOR_RUNTIMES } from './vendors/provider-vendor-runtimes.js'
export type { VendorFallbackModels, VendorModelsFetcherDeps } from './vendors/provider-vendor-runtimes.js'

// ── 服务商定义与注册表:一家服务商在注册表里长什么样(`ipc-types` 的三个形状),怎么登记、查找、丢掉缓存的实例。
export type { ProviderConfig, ProviderDefinition, ProviderInfo } from './provider-ipc-types.js'
export {
  getAvailableProviders,
  getProviderInfo,
  initializeRegistry,
  invalidateProviderCache,
  isProviderSupported,
  requiresOAuth,
  requiresSystemMerge,
} from './provider-table.js'

// ── 模型目录与能力:目录条目的形状与查询、某个型号能做什么、模型认亲、手填模型、models.dev 缓存与各家的模型列表接口。
export {
  fetchOnethingModelsDevData,
  getAllOnethingModels,
  getOnethingKnownModelMaxOutputTokens,
  getOnethingModelById,
  getOnethingModelCacheStatus,
  getOnethingModelCapabilityEntry,
  getOnethingModelContextLength,
  getOnethingModelDisplayName,
  getOnethingModelNameAliases,
  getOnethingModelsForProvider,
  getOnethingModelsWithCapabilities,
  modelsDevModelToOnethingCapabilityEntry,
  onethingCapabilityEntryToOpenRouterModel,
  onethingModelServesImageOutputInLoop,
  onethingModelSupportsImageGeneration,
  onethingModelSupportsTemperature,
  onethingModelSupportsTools,
  openRouterModelToOnethingCapabilityEntry,
  refreshAllOnethingProviderModels,
  refreshOnethingProviderModels,
  saveOnethingProviderModels,
  searchOnethingModels,
} from './provider-model-registry.js'
export type {
  GetOnethingModelsWithCapabilitiesAdapters,
  OnethingCatalogModelEntry,
  OnethingConfiguredModelSelection,
  OnethingEndpointModelsFetcher,
  OnethingModelCapabilityEntry,
  OnethingModelRegistryQueryOptions,
  OnethingModelRegistryRefreshAdapters,
  OnethingModelRegistryRefreshLogger,
  OnethingModelsDevResponse,
  OnethingOpenRouterModel,
  OnethingProviderModelConfigs,
} from './provider-model-registry.js'
export {
  projectOnethingThinkingLevels,
  resolveOnethingModelCapabilities,
  validateOnethingProviderReasoningSettings,
} from './provider-model-capability.js'
export { effectiveModelFactsOf, onethingModelOverrideFactsOf } from './provider-effective-model.js'
export { MODEL_SUGGESTION_CAPABILITY_KEYS, modelIdentityIndexOf, modelParameterSuggestionOf } from './provider-model-identity.js'
export type { ModelIdentityIndex } from './provider-model-identity.js'
export {
  applyAddManualModel,
  applyRemoveManualModel,
  catalogFactsOf,
  createOnethingManualModelEntry,
  foldOrphansIntoManual,
  isOnethingManualModelEntry,
} from './provider-manual-models.js'
export type { ManualModelEditResult } from './provider-manual-models.js'
export { createModelsDevCache, MODELS_DEV_CACHE_FILE_NAME } from './provider-models-dev-cache.js'
export { ONETHING_PROVIDER_MAPPING } from './provider-models-dev-catalog.js'
export { fetchProviderDirectModels } from './provider-models-endpoint.js'
export type { ModelsListMapping, ProviderDirectModelsFetch } from './provider-models-endpoint.js'

// ── 生效配置与凭证解析:这次请求实际用哪一家、哪把 key、哪个地址;按环境变量找 key;服务商私有的运行时旋钮;后台杂活用哪个模型。
export { routedProviderIdOf, withResolvedProviderBaseUrl } from './provider-config.js'
export type {
  CoreAppSettingsWithAI,
  CoreProviderAuthLike,
  CoreProviderAuthLogger,
  CoreProviderConfigLike,
  CoreSessionProviderSelection,
  CoreSpaceCredentialMarker,
  CoreSpaceDefaultSelection,
} from './provider-config.js'
export {
  extractOnethingProviderErrorDetails,
  generateOnethingChatTitleForIpc,
  getEffectiveOnethingProviderConfig,
  getOnethingApiKeyForProvider,
  getOnethingCaughtErrorMessage,
  getOnethingCredentialsError,
  getOnethingCustomProviderConfig,
  getOnethingProviderApiType,
  getOnethingProviderConfig,
  resolveOnethingProviderAuth,
  resolveOnethingProviderConfigForChat,
} from './provider-runtime.js'
export type { OnethingChatTitleGenerationAdapters, OnethingProviderErrorDetails } from './provider-runtime.js'
export { getProviderEnvStatus, resolveProviderApiKey } from './provider-ipc-env.js'
export { buildOnethingRequestProviderOptionsBag, pickOnethingProviderOptions } from './provider-options.js'
export type { OnethingProviderOptions } from './provider-options.js'
export { resolveUtilityModel } from './provider-utility-model.js'

// ── 造 AgentProvider 与线协议:不带宿主能力的工厂(宿主能力由 engine 的进程工厂补上)、OpenAI 兼容线、方言登记与自定义方言、
// 自定义服务商「自动识别」的纯函数、思考档位、各家私有的内容块(provider data)、按名册问各家的原生工具。
export {
  createAgentProviderFromRuntime,
  getSupportedAgentProviderRuntimeIds,
  isAgentProviderRuntimeSupported,
  registerAgentProviderRuntime,
} from './provider-factory.js'
export type {
  AgentProviderRuntimeConfig,
  CreateAgentProviderFromRuntimeOptions,
  RegisterAgentProviderRuntimeOptions,
} from './provider-factory.js'
export { createOpenAICompatibleAgentProvider } from './provider-openai-compatible.js'
export type { OpenAICompatibleAgentProviderOptions } from './provider-openai-compatible.js'
export type { ProviderMediaImage, ProviderMediaReader } from './base/provider-context.js'
export { registerDialect } from './base/provider-base-dialect.js'
export { customAdapterBaseDialectId, dialectFromSpec, unsupportedAdapterSpecFields } from './dialects/provider-dialects-custom-from-spec.js'
export {
  adapterReasoningPath,
  parseAdapterSpecAnswer,
  probeCustomEndpoint,
  renderCustomAdapterProbePrompt,
  verifyAdapterSpec,
} from './provider-custom-probe.js'
export {
  createOnethingUtilityAgentProvider,
  isOnethingACPProviderRuntime,
  ONETHING_ACP_RUNTIME_PROVIDER_ID,
  resolveOnethingProviderRuntimeRoute,
} from './provider-agent-runtime-route.js'
export type {
  OnethingProviderExecutableToolDefinition,
  OnethingProviderRuntimeRoute,
  OnethingProviderRuntimeRouteAdapters,
} from './provider-agent-runtime-route.js'
export type { OnethingProviderRequestDumpMode, OnethingProviderRequestDumpValue } from './provider-agent-turn.js'
export { getOnethingAgentLoopThinkingOptions } from './provider-thinking-options.js'
export {
  applyOnethingAgentLoopProviderData,
  planOnethingProviderDataPart,
  providerDataFromOnethingContentPart,
} from './provider-data.js'
export type { ApplyOnethingAgentLoopProviderDataOptions } from './provider-data.js'
export { ONETHING_QUOTA_PROVIDER_DATA_TYPE } from './provider-data-policy.js'
export { PROVIDER_NATIVE_IMAGE_GENERATION_TOOL, resolveProviderNativeTools } from './provider-native-tools.js'

// ── 对话门面与请求拼装:发一轮对话 / 起标题的编排(宿主把 fetch、日志、凭证经适配器交进来)、流式适配、工具定义与消息的线形状。
export { createOnethingProviderFacade } from './provider-facade.js'
export type {
  OnethingChatGenerationOptions,
  OnethingProviderFacadeAdapters,
  OnethingProviderFacadeChatResponseResult,
  OnethingProviderFacadeRawRecord,
  OnethingProviderFacadeReasoningStreamChunk,
  OnethingProviderFacadeStreamCallbacks,
  OnethingProviderFacadeStreamChunkWithTools,
  OnethingProviderFacadeToolCall,
} from './provider-facade.js'
export { createOnethingStreamProviderAdapter } from './provider-stream-adapter.js'
export type { OnethingStreamProviderAdapterOptions } from './provider-stream-adapter.js'
export { buildOnethingChatTitleGenerationRequest } from './provider-routing.js'
export type {
  OnethingAIMessageContent,
  OnethingProviderToolDefinitionInput,
  OnethingProviderToolDefinitionMap,
  OnethingProviderToolParameter,
  OnethingProviderToolSourceDefinition,
  OnethingToolChatMessage,
} from './provider-message-conversion.js'

// ── 界面形状的投影:服务商列表、环境变量状态、模型查询、方言选项,按界面要的形状交出。
export { inspectOnethingProviderEnvStatusForIpc, listOnethingProvidersForIpc } from './provider-presentation.js'
export type { ListOnethingProvidersOptions, OnethingProviderPresentationIpcLogger } from './provider-presentation.js'
export {
  getAllOnethingModelRegistryModelsForIpc,
  getOnethingModelCapabilitiesForIpc,
  getOnethingModelRegistryDisplayNameForIpc,
  getOnethingModelRegistryNameAliasesForIpc,
  refreshOnethingModelRegistryForIpc,
  searchOnethingModelRegistryForIpc,
} from './provider-model-query-presentation.js'
export type {
  GetAllOnethingModelRegistryModelsOptions,
  GetOnethingModelRegistryNameAliasesOptions,
  OnethingModelQueryIpcLogger,
  RefreshOnethingModelRegistryOptions,
} from './provider-model-query-presentation.js'
export { listLabeledDialectsForIpc } from './provider-dialect-options.js'

// ── 配额、计价与诊断:订阅额度 / 余额取数、一个模型一个 token 多少钱、把请求转储落进日志目录。
export { fetchProviderQuota, providerQuotaSourceOf } from './quota/provider-quota.js'
export type { QuotaFetchContext } from './quota/provider-quota-source.js'
export { buildOnethingUsageLedgerRecord } from './provider-pricing.js'
export { dumpProviderRequest } from './provider-request-dump-writer.js'
export type { ProviderRequestDumpMode } from './provider-request-dump-writer.js'

// ── 旧接口类型:老式 `Provider` 接口(agents 的老引擎还在用)。
export type { Provider, ProviderRequest, ProviderStreamEvent, ProviderUsage } from './provider-types.js'
