/**
 * `custom-anthropic` —— 用户自建的 Anthropic 兼容端点(`custom-*`,
 * `apiType: 'anthropic'`)。对照 `factory.ts` 的
 * `createCustomAgentProviderFromRuntime`:**没有 promptCaching**(第三方端点
 * 可能拒收 `cache_control`),能力三旋钮随 `runtimeCapabilityFlags(config)` 走
 * —— 所以传输声明在构造处覆盖,配方只给默认档。
 *
 * 一份配方服务任意多个 provider id:`providerId` 必须在构造时给。
 */
import {
	ANTHROPIC_DEFAULT_BASE_URL,
	defineAnthropicDialect,
} from "./anthropic-recipe.js";

export const CUSTOM_ANTHROPIC_DIALECT = defineAnthropicDialect({
	id: "custom-anthropic",
	defaultBaseUrl: ANTHROPIC_DEFAULT_BASE_URL,
});
