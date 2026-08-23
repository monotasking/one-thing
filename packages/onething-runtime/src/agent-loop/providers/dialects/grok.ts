/**
 * `grok` —— xAI API key 通路。对照 `factory.ts`:`defaultBaseUrl` /
 * `supportsVision:true` / `supportsReasoning:true` /
 * `includeAssistantReasoning:true` / `reasoningStyle:'grok-effort'`。
 */
import type { UsagePathTable } from "../base/index.js";
import { grokEffortWire } from "../thinking/index.js";
import { OPENAI_CHAT_IMAGE_DETAIL_VALUES, openAIChatUsage, openAIChatUsageTable } from "../wires/index.js";
import {
	defineOpenAIChatDialect,
	openAIChatTransportCapabilities,
	promptCacheKeyExtraBody,
} from "./recipe.js";

/** xAI 报价的单位是 1e-10 美元(`cost_in_usd_ticks`)。 */
const USD_TICKS_PER_DOLLAR = 1e10;

/**
 * 三桶与默认表同形状,只多一个厂商报价。与 OpenRouter 同理:`providerCostUSD`
 * 不投影进 `AgentUsage`(设计稿 §10 决策 3 待拍板)。
 */
export const GROK_USAGE_TABLE: UsagePathTable = openAIChatUsageTable({
	providerCostUSD: (_raw, read) => {
		const ticks = read("cost_in_usd_ticks");
		return ticks === undefined ? undefined : ticks / USD_TICKS_PER_DOLLAR;
	},
});

export const GROK_DIALECT = defineOpenAIChatDialect({
	id: "grok",
	defaultBaseUrl: "https://api.x.ai/v1",
	reasoning: grokEffortWire,
	includeAssistantReasoning: true,
	usage: openAIChatUsage(GROK_USAGE_TABLE),
	extraBody: promptCacheKeyExtraBody,
	// xAI 的 vision 端点收 `image_url.detail`(标准三值);`verbosity` 是
	// OpenAI 自己的字段,这家不认(P3-3)。
	providerOptions: { imageDetail: OPENAI_CHAT_IMAGE_DETAIL_VALUES },
	transport: openAIChatTransportCapabilities({ vision: true, reasoning: true }),
});
