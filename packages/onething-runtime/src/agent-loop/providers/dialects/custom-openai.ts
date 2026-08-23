/**
 * `custom-openai` —— 用户自建的 OpenAI 兼容端点(`custom-*`,apiType `openai`)。
 * 对照 `factory.ts` 的 `createCustomAgentProviderFromRuntime`:
 * `defaultBaseUrl: 'https://api.openai.com/v1'` / `reasoningStyle:'openai-effort'`,
 * 能力三旋钮与 `includeAssistantReasoning` 都随 `runtimeCapabilityFlags(config)`
 * 走(默认全开)—— 所以那两项在构造处覆盖,配方只给默认档。
 *
 * 一份配方服务任意多个 provider id:`providerId` 必须在构造时给。
 */
import { openAIEffortWire } from "../thinking/index.js";
import { defineOpenAIChatDialect, openAIChatTransportCapabilities } from "./recipe.js";

export const CUSTOM_OPENAI_DIALECT = defineOpenAIChatDialect({
	id: "custom-openai",
	defaultBaseUrl: "https://api.openai.com/v1",
	reasoning: openAIEffortWire,
	includeAssistantReasoning: true,
	transport: openAIChatTransportCapabilities({
		tools: true,
		vision: true,
		reasoning: true,
	}),
});
