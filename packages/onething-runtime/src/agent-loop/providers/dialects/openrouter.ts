/**
 * `openrouter` —— 统一网关。对照 `factory.ts`:`defaultBaseUrl` /
 * `supportsVision:true` / `supportsReasoning:true` /
 * `reasoningStyle:'openrouter-reasoning'`;`maxTokensField` 用默认的
 * `max_tokens`,`includeAssistantReasoning` 没给。
 *
 * 上游的 `reasoning_details[]` 原样回传是 P3 的事。`cost` / `cache_write_tokens`
 * 从 P0b-A 起入三桶(见下)。
 */
import type { UsagePathTable } from "../base/index.js";
import { openRouterReasoningWire } from "../thinking/index.js";
import { openAIChatUsage, openAIChatUsageTable } from "../wires/index.js";
import {
	defineOpenAIChatDialect,
	openAIChatTransportCapabilities,
	promptCacheKeyExtraBody,
} from "./recipe.js";

/**
 * OpenRouter 的 usage 恒返回,`cache_write_tokens` 与 `cached_tokens` 都在
 * `prompt_tokens_details` 里且都 ⊂ prompt(默认表已经这样减),额外多一个
 * 顶层 `cost`(美元)。
 *
 * `cost` 只进 `UsageBuckets.providerCostUSD`,**不投影进 `AgentUsage`** ——
 * 「厂商报价与本地价目并存」是设计稿 §10 决策 3,待拍板;在那之前它是三桶上
 * 的一个字段,账本一个字不动。
 */
export const OPENROUTER_USAGE_TABLE: UsagePathTable = openAIChatUsageTable({
	providerCostUSD: "cost",
});

export const OPENROUTER_DIALECT = defineOpenAIChatDialect({
	id: "openrouter",
	defaultBaseUrl: "https://openrouter.ai/api/v1",
	reasoning: openRouterReasoningWire,
	usage: openAIChatUsage(OPENROUTER_USAGE_TABLE),
	extraBody: promptCacheKeyExtraBody,
	transport: openAIChatTransportCapabilities({ vision: true, reasoning: true }),
});
