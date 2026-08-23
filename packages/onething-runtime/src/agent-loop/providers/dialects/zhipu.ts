/**
 * `zhipu` —— 智谱开放平台。对照 `factory.ts`:`defaultBaseUrl` /
 * `supportsReasoning:true` / `includeAssistantReasoning:true` /
 * `reasoningStyle:'zhipu-thinking'`;没有 `supportsVision`。
 * `tool_choice` 只收 `auto` 是 P0b 的账本行,P0a 照旧照发。
 */
import { zhipuThinkingWire } from "../thinking/index.js";
import { defineOpenAIChatDialect, openAIChatTransportCapabilities } from "./recipe.js";

export const ZHIPU_DIALECT = defineOpenAIChatDialect({
	id: "zhipu",
	defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
	reasoning: zhipuThinkingWire,
	includeAssistantReasoning: true,
	transport: openAIChatTransportCapabilities({ reasoning: true }),
});
