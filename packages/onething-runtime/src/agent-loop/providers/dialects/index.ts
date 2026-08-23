/**
 * 方言配方桶:openai-chat 线协议上的 11 份 + anthropic-messages 上的 3 份 + gemini 上的 1 份。
 * import 这个桶 = 把它们全部登记进 `registerDialect` 的注册表
 * (设计稿 §9 P0a 门 ④:每份配方都得有 fixture 目录)。
 */
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

export { CLAUDE_DIALECT } from "./claude.js";
export {
	CLAUDE_CODE_DIALECT,
	CLAUDE_CODE_HEADER,
	CLAUDE_CODE_OAUTH_BETA_HEADERS,
} from "./claude-code.js";
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
export { GEMINI_DIALECT } from "./gemini.js";

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
	CODEX_BASE_URL,
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
	resolveCodexResponsesUrl,
	resolveCodexToken,
	resolveCodexTokenForRequest,
	responsesDialect,
	responsesEndpoint,
	type CodexAuthOptions,
	type OAuthToken as CodexOAuthTokenShape,
	type ProviderAuthContext as CodexProviderAuthContextShape,
	type ResponsesDialectSpec,
	type ResponsesProviderInit,
} from "./responses-recipe.js";
export { CODEX_DIALECT } from "./codex.js";

export { CUSTOM_OPENAI_DIALECT } from "./custom-openai.js";
export {
	DEEPSEEK_DIALECT,
	DEEPSEEK_TRANSPORT_CAPABILITIES,
	DEEPSEEK_USAGE_TABLE,
	DeepSeekSamplingPolicy,
} from "./deepseek.js";
export { GITHUB_COPILOT_DIALECT } from "./github-copilot.js";
export {
	GROK_BASE_URL,
	GROK_DIALECT,
	GROK_DIALECT_SPEC,
	GROK_PROVIDER_DATA_TAG,
	GROK_PROVIDER_OPTIONS,
	GROK_RESPONSES_USAGE,
	GROK_TRANSPORT_CAPABILITIES,
	decodeGrokResponsesCitations,
} from "./grok.js";
export { GROK_OAUTH_DIALECT } from "./grok-oauth.js";
export {
	KimiFileExtractChannel,
	kimiFileExtractChannel,
} from "./kimi-attachments.js";
export { KIMI_DIALECT, KIMI_USAGE_TABLE, kimiThinkingIntent } from "./kimi.js";
export { KIMI_CODE_DIALECT } from "./kimi-code.js";
export {
	OPENAI_BASE_URL,
	OPENAI_DIALECT,
	OPENAI_DIALECT_SPEC,
	OPENAI_PROVIDER_DATA_TAG,
	OPENAI_PROVIDER_OPTIONS,
	OPENAI_TRANSPORT_CAPABILITIES,
} from "./openai.js";
export { OPENROUTER_DIALECT, OPENROUTER_USAGE_TABLE } from "./openrouter.js";
export { QWEN_DIALECT, QWEN_USAGE_TABLE } from "./qwen.js";
export { ZHIPU_DIALECT } from "./zhipu.js";
