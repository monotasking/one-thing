/**
 * `grok` —— xAI API key 通路。对照 `factory.ts`:`defaultBaseUrl` /
 * `supportsVision:true` / `supportsReasoning:true` /
 * `includeAssistantReasoning:true` / `reasoningStyle:'grok-effort'`。
 */
import { grokEffortWire } from "../thinking/index.js";
import { defineOpenAIChatDialect, openAIChatTransportCapabilities } from "./recipe.js";

export const GROK_DIALECT = defineOpenAIChatDialect({
	id: "grok",
	defaultBaseUrl: "https://api.x.ai/v1",
	reasoning: grokEffortWire,
	includeAssistantReasoning: true,
	transport: openAIChatTransportCapabilities({ vision: true, reasoning: true }),
});
