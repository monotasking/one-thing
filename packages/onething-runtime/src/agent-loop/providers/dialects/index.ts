/**
 * 方言配方桶:openai-chat 线协议上的 11 份 + anthropic-messages 上的 3 份 + gemini 上的 1 份。
 * import 这个桶 = 把它们全部登记进 `registerDialect` 的注册表
 * (设计稿 §9 P0a 门 ④:每份配方都得有 fixture 目录)。
 *
 * 搬回 `providers/vendors/<id>/` 的那几家,方言跟着家走;它们由 `vendors/runtimes.ts`
 * 的名册登记 —— 这里副作用 import 那份名册,「import 这个桶 = 全部登记」照旧成立。
 */
import "../../../providers/vendors/runtimes.js";
export {
	ANTHROPIC_DEFAULT_BASE_URL,
	ANTHROPIC_TRANSPORT_CAPABILITIES,
	ANTHROPIC_VERSION,
	anthropicAuth,
	anthropicDialect,
	createAnthropicProvider,
	defineAnthropicDialect,
	type AnthropicAuthOptions,
	type AnthropicDialectSpec,
	type AnthropicProviderInit,
} from "./anthropic-recipe.js";

export { CUSTOM_ANTHROPIC_DIALECT } from "./custom-anthropic.js";

export {
	GEMINI_DEFAULT_BASE_URL,
	GEMINI_TRANSPORT_CAPABILITIES,
	createGeminiProvider,
	defineGeminiDialect,
	geminiAuth,
	geminiDialect,
	geminiEndpoint,
	type GeminiAuthOptions,
	type GeminiDialectSpec,
	type GeminiProviderInit,
} from "./gemini-recipe.js";

export {
	capabilitiesFromFlags,
	capabilityLimitsFromRuntimeConfig,
	runtimeCapabilityFlags,
	type RuntimeCapabilityFlags,
	type RuntimeTransportConfig,
} from "./runtime-transport.js";

export {
	createOpenAIChatProvider,
	defineOpenAIChatDialect,
	openAIChatDialect,
	openAIChatTransportCapabilities,
	type FetchFn,
	type OpenAIChatDialectSpec,
	type OpenAIChatProviderInit,
	type OpenAIChatTransportFlags,
} from "./recipe.js";

export {
	CODEX_CLIENT_VERSION,
	CODEX_FALLBACK_INSTRUCTIONS,
	CODEX_NOT_LOGGED_IN,
	CODEX_PROVIDER_ID,
	CODEX_TRANSPORT_CAPABILITIES,
	CodexOAuthAuth,
	buildCodexAgentHeaders,
	codexAuth,
	createResponsesProvider,
	defineResponsesDialect,
	plainResponsesEndpoint,
	resolveCodexToken,
	resolveCodexTokenForRequest,
	responsesDialect,
	type CodexAuthOptions,
	type OAuthToken as CodexOAuthTokenShape,
	type ProviderAuthContext as CodexProviderAuthContextShape,
	type ResponsesDialectSpec,
	type ResponsesProviderInit,
} from "./responses-recipe.js";

export { CUSTOM_OPENAI_DIALECT } from "./custom-openai.js";
