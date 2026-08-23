/**
 * `openrouter` —— 统一网关。对照 `factory.ts`:`defaultBaseUrl` /
 * `supportsVision:true` / `supportsReasoning:true` /
 * `reasoningStyle:'openrouter-reasoning'`;`maxTokensField` 用默认的
 * `max_tokens`,`includeAssistantReasoning` 没给。
 *
 * 上游的 `reasoning_details[]` 原样回传、`cost` / `cache_write_tokens` 入账
 * 都是 P0b/P3 的事 —— 今天无人读取,这里不顺手加。
 */
import { openRouterReasoningWire } from "../thinking/index.js";
import { defineOpenAIChatDialect, openAIChatTransportCapabilities } from "./recipe.js";

export const OPENROUTER_DIALECT = defineOpenAIChatDialect({
	id: "openrouter",
	defaultBaseUrl: "https://openrouter.ai/api/v1",
	reasoning: openRouterReasoningWire,
	transport: openAIChatTransportCapabilities({ vision: true, reasoning: true }),
});
