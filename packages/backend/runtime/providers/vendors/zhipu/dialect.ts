/**
 * `zhipu` —— 智谱开放平台的方言。对照同目录 `runtime.ts`:`defaultBaseUrl` /
 * `supportsReasoning:true` / `includeAssistantReasoning:true` /
 * `reasoningStyle:'zhipu-thinking'`;没有 `supportsVision`。
 * `tool_choice` 只收 `auto` 是 P0b 的账本行,P0a 照旧照发。
 */
import { ONETHING_ZHIPU_STANDARD_BASE_URL } from "./endpoint.js";
import { zhipuThinkingWire } from "./thinking.js";
import { defineOpenAIChatDialect, openAIChatTransportCapabilities } from "../../../agent-loop/providers/dialects/recipe.js";

export const ZHIPU_DIALECT = defineOpenAIChatDialect({
	id: "zhipu",
	label: "Zhipu",
	defaultBaseUrl: ONETHING_ZHIPU_STANDARD_BASE_URL,
	reasoning: zhipuThinkingWire,
	includeAssistantReasoning: true,
	transport: openAIChatTransportCapabilities({ reasoning: true }),
});
