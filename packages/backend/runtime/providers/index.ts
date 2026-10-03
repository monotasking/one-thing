export * from './builtin-providers.js'
export * from './manifest.js'
export * from './builtin-manifests.js'
export type { DialField, DialOption, DialSpec } from './dials.js'
export * from './agent-turn.js'
export * from './agent-runtime-route.js'
export * from './env.js'
export * from './message-conversion.js'
export * from './model-capability.js'
export * from './model-registry.js'
export * from './manual-models.js'
export * from './models-dev-cache.js'
export * from './effective-model.js'
export * from './models-endpoint.js'
export * from './model-identity.js'
export * from './model-query-presentation.js'
export * from './oauth-config.js'
export * from './provider-routing.js'
export * from './provider-runtime.js'
// per-space 凭证解析(批 B3)要的两个类型:注入函数的签名住在宿主侧,
// 但契约(「provider config 长什么样」「运行期标记长什么样」)在这里。
export type {
  CoreProviderConfigLike,
  CoreSpaceCredentialMarker,
} from './provider-config.js'
export * from './provider-facade.js'
export * from './provider-definition.js'
export * from './provider-options.js'
export * from './provider-presentation.js'
export * from './quota/index.js'
// 包根归位 3 第 1 笔(2026-10-03)从包根 `provider-binding/` 并进来的:把请求转储落进日志目录的那层薄壳。
// 受管 fetch 与代理规则搬去了 `runtime/network/`;「生效 AI 设置」的合成搬去了 `runtime/settings/`,都不再经这个入口交出。
export { dumpProviderRequest } from './request-dump-writer.js'
export * from './stream-provider-adapter.js'
export * from './registry.js'
export * from './endpoint.js'
// `./anthropic.js`(一只老式 Anthropic 实现,缺省模型写死 claude-3-5-haiku、
// `max_tokens` 缺省 1024)于 2026-09-09 删除:全仓零调用方,真正在用的 Anthropic
// 实现是 `providers/dialects/anthropic-recipe.ts`;留着它等于留着一个
// 藏起来的输出上限默认值(用户裁定:宁可没有默认,也不要在用的时候被截断)。
// `./deepseek.js`(老式 `Provider` 接口的 DeepSeek 实现)与 `./tool-result-content.js` 于
// 2026-10-01 删除(服务商自述试点 P2):全仓零调用方,只剩这个桶的再导出。
// `./codex.js` / `./codex-native-tools.js` / `./github-copilot.js` 于 P2 第 4 批搬回
// `vendors/{codex,github-copilot}/`;它们的符号不再经这个桶导出,用的人从那一家的模块直接 import。

// ── providers 归位(D24,2026-10-04)之后,搬去别的功能的那些文件(engine 的对话门面与进程工厂、settings 的
// 模型目录服务、credentials 的凭证一族、custom-probe 分析器)还要用的 providers 名字,逐个列出;从前它们与这些
// 文件同住 providers、直接互引。`provider-pricing.ts`(从 usage 搬来:一个模型一个 token 多少钱)也在这里交出。
// providers 收口(下一笔)时这一段会与上面的 `export *` 一起整理成具名导出。
export {
  CUSTOM_ADAPTER_BASE_DIALECT,
  adapterReasoningPath,
  parseAdapterSpecAnswer,
  probeCustomEndpoint,
  renderCustomAdapterProbePrompt,
  verifyAdapterSpec,
} from './custom-probe.js'
export {
  getAvailableProviders,
  getProviderInfo,
  initializeRegistry,
  isProviderSupported,
  requiresOAuth,
  requiresSystemMerge,
} from './provider-table.js'
export {
  withResolvedProviderBaseUrl,
} from './provider-config.js'
export {
  getProviderEnvStatus,
} from './ipc-env.js'
export type {
  ProviderRequestDumpMode,
} from './request-dump-writer.js'
export type {
  ProviderConfig,
  ProviderDefinition,
  ProviderInfo,
} from './ipc-types.js'
export {
  createAgentProviderFromRuntime,
  createOpenAICompatibleAgentProvider,
  getSupportedAgentProviderRuntimeIds,
  isAgentProviderRuntimeSupported,
  registerAgentProviderRuntime,
} from './agent-providers.js'
export type {
  AgentProviderRuntimeConfig,
  CreateAgentProviderFromRuntimeOptions,
  OpenAICompatibleAgentProviderOptions,
  ProviderMediaImage,
  ProviderMediaReader,
  RegisterAgentProviderRuntimeOptions,
} from './agent-providers.js'
export {
  resolveUtilityModel,
} from './utility-model.js'
export {
  dialectFromSpec,
  unsupportedAdapterSpecFields,
} from './dialects/custom-from-spec.js'
export {
  registerDialect,
} from './base/dialect.js'
export {
  VENDOR_RUNTIMES,
} from './vendors/runtimes.js'
export type {
  VendorFallbackModels,
} from './vendors/runtimes.js'
export {
  buildOnethingUsageLedgerRecord,
} from './provider-pricing.js'
