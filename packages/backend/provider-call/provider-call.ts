/**
 * provider-call —— 去调用服务商(决策 D122,越层清零 1B,2026-10-04 建)。
 *
 * 做什么:把设置与凭证变成一只可用的服务商实例,跑一次对话 / 生成标题,以及辅助模型
 * (目录、技能复盘、宠物、插件这类「用小模型跑一句话」的地方)要的鉴权解析。它与 `provider/`
 * 正好一对:`provider/` 说「服务商是谁、怎么说话」,这里说「拿它去干一次活」。
 *
 * 交出三类东西:
 *   1. 对话门面:`generateChatResponse` / `generateChatTitle`,服务商名册的读法
 *      (`getAvailableProviders` / `isProviderSupported` / `requiresOAuth`)与装配时的 `configureAppProviderRegistry`;
 *   2. 造实例:`createAgentProviderFromRuntime`(按运行时配置造 AgentProvider)与
 *      `createUtilityProvider`(辅助模型:按设置挑一只可用的小模型);
 *   3. 鉴权与生效配置:`resolveProviderAuth` / `getEffectiveProviderConfig` / `getProviderApiType`。
 *
 * 依赖:provider、settings、credentials、auth、acp、external-agent、media、agent-loop、session、logging
 * —— 全是 L2 及以下,所以它站 L2。从前这九只住在 engine(L3)里,于是目录 / 技能 / 宠物 / 插件这四个
 * L2 功能要用小模型跑一句话都得越层引引擎;辅助模型的意图 / 结果账(`beginAuxiliaryModelRequest`)
 * 同时下沉到了 session。
 *
 * 功能内部只引兄弟文件,不引这个入口(D126)。只用具名导出。
 */
export {
  configureAppProviderRegistry,
  generateChatResponse,
  generateChatTitle,
  getAvailableProviders,
  isProviderSupported,
  requiresOAuth,
} from './provider-call-chat.js'
export type { AIMessageContent } from './provider-call-chat.js'
// `createAgentProviderFromRuntime` 经 agent-runtime 转交(它就是 factory 那一只的再导出):引擎里两个读者
// 从前就是从 agent-runtime 拿的,测试对 agent-runtime 打的桩照旧拦得住。
export { createAgentProviderFromRuntime } from './provider-call-agent-runtime.js'
export { registerAgentProviderRuntime } from './provider-call-factory.js'
export type { AgentRuntimeProviderConfig } from './provider-call-agent-runtime.js'
export { createUtilityProvider } from './provider-call-utility.js'
export type { UtilityProviderRef } from './provider-call-utility.js'
export {
  getEffectiveProviderConfig,
  getProviderApiType,
  resolveProviderAuth,
} from './provider-call-auth.js'
