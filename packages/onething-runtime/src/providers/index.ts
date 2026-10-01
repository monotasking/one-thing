export * from './builtin-providers.js'
export * from './manifest.js'
export * from './builtin-manifests.js'
export type { DialField, DialOption, DialSpec } from './dials.js'
export * from './agent-turn.js'
export * from './agent-runtime-route.js'
export * from './bound-fetch.js'
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
export * from './network.js'
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
export * from './request-dump.js'
export * from './stream-provider-adapter.js'
export * from './registry.js'
export * from './endpoint.js'
// `./anthropic.js`(一只老式 Anthropic 实现,缺省模型写死 claude-3-5-haiku、
// `max_tokens` 缺省 1024)于 2026-09-09 删除:全仓零调用方,真正在用的 Anthropic
// 实现是 `agent-loop/providers/dialects/anthropic-recipe.ts`;留着它等于留着一个
// 藏起来的输出上限默认值(用户裁定:宁可没有默认,也不要在用的时候被截断)。
// `./deepseek.js`(老式 `Provider` 接口的 DeepSeek 实现)与 `./tool-result-content.js` 于
// 2026-10-01 删除(服务商自述试点 P2):全仓零调用方,只剩这个桶的再导出。
// `./codex.js` / `./codex-native-tools.js` / `./github-copilot.js` 于 P2 第 4 批搬回
// `vendors/{codex,github-copilot}/`;它们的符号不再经这个桶导出,用的人从那一家的模块直接 import。
