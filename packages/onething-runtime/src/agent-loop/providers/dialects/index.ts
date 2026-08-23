/**
 * openai-chat 线协议上的 11 份方言配方。import 这个桶 = 把它们全部登记进
 * `registerDialect` 的注册表(设计稿 §9 P0a 门 ④:每份配方都得有 fixture 目录)。
 */
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

export { CUSTOM_OPENAI_DIALECT } from "./custom-openai.js";
export {
	DEEPSEEK_DIALECT,
	DEEPSEEK_TRANSPORT_CAPABILITIES,
	DEEPSEEK_USAGE_TABLE,
	DeepSeekSamplingPolicy,
} from "./deepseek.js";
export { GITHUB_COPILOT_DIALECT } from "./github-copilot.js";
export { GROK_DIALECT, GROK_USAGE_TABLE } from "./grok.js";
export { GROK_OAUTH_DIALECT } from "./grok-oauth.js";
export { KIMI_DIALECT, KIMI_USAGE_TABLE } from "./kimi.js";
export { KIMI_CODE_DIALECT } from "./kimi-code.js";
export { OPENAI_DIALECT } from "./openai.js";
export { OPENROUTER_DIALECT, OPENROUTER_USAGE_TABLE } from "./openrouter.js";
export { QWEN_DIALECT, QWEN_USAGE_TABLE } from "./qwen.js";
export { ZHIPU_DIALECT } from "./zhipu.js";
