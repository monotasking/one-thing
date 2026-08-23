/**
 * `grok` —— xAI API key 通路。对照 `factory.ts`:`defaultBaseUrl` /
 * `supportsVision:true` / `supportsReasoning:true` /
 * `includeAssistantReasoning:true` / `reasoningStyle:'grok-effort'`。
 */
import type { AgentTurnStreamEvent } from "@onething/core/agent-loop";
import type { TurnContext, UsagePathTable } from "../base/index.js";
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

// ---------------------------------------------------------------------------
// Live Search(P3-5a)—— 请求侧 `search_parameters`,响应侧顶层 `citations[]`
// ---------------------------------------------------------------------------

/**
 * xAI 两条通路共用的请求级袋支持面。
 *
 * `imageDetail`:vision 端点收 `image_url.detail`(标准三值)。
 * `searchParameters`:Live Search 的检索开关(`mode` / `sources` / 日期窗 /
 * `max_search_results` / `return_citations`),白名单与逐键校验在
 * `wires/openai-chat-provider-options.ts` 的那一张表里 —— 这里只声明「这家认」。
 * `verbosity` 是 OpenAI 自己的字段,这家不认(P3-3)。
 */
export const GROK_PROVIDER_OPTIONS = {
	imageDetail: OPENAI_CHAT_IMAGE_DETAIL_VALUES,
	searchParameters: true,
} as const;

/**
 * Live Search 的引文 → 一条 `provider-data`。
 *
 * `citations` 是**块的顶层字段**(不在 `choices[].delta` 里),xAI 通常在最后
 * 一块随 `finish_reason` 一起发一次全量。所以这里不累积、不去重:来一块认一块,
 * 认得的就产一条事件。项是字符串 URL,非字符串 / 空串一律不要(不猜)。
 *
 * 消息上落哪一格由 `provider-data.ts` 的那张表判:非 codex 的 provider-data 落
 * `'provider-data'` 一格。**本期不做 UI** —— 这一格先存下来,怎么呈现是渲染层
 * 将来的事。
 */
export function decodeGrokCitations(
	chunk: unknown,
	turn: TurnContext,
): AgentTurnStreamEvent[] {
	if (!chunk || typeof chunk !== "object") return [];
	const raw = (chunk as { citations?: unknown }).citations;
	if (!Array.isArray(raw)) return [];
	const citations = raw.filter(
		(entry): entry is string => typeof entry === "string" && entry.length > 0,
	);
	if (citations.length === 0) return [];
	return [
		{
			type: "provider-data",
			turn: turn.turn,
			providerData: { provider: "grok", type: "citations", citations },
		},
	];
}

export const GROK_DIALECT = defineOpenAIChatDialect({
	id: "grok",
	defaultBaseUrl: "https://api.x.ai/v1",
	reasoning: grokEffortWire,
	includeAssistantReasoning: true,
	usage: openAIChatUsage(GROK_USAGE_TABLE),
	extraBody: promptCacheKeyExtraBody,
	decodeExtras: decodeGrokCitations,
	providerOptions: GROK_PROVIDER_OPTIONS,
	transport: openAIChatTransportCapabilities({ vision: true, reasoning: true }),
});
