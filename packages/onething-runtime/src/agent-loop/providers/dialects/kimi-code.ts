/**
 * `kimi-code` —— Kimi Code(订阅)。与 `kimi` 同一套线材,差别只有两处:
 * 地址钉死在套餐 host(不吃地区/档位),凭证是 OAuth access_token
 * (klip-14:「OAuth 模型和 API 兼容性与当前 Bearer key 完全一致」)。
 */
import { ONETHING_KIMI_CODING_PLAN_BASE_URL } from "../../../providers/kimi.js";
import { thinkingTypeWire } from "../thinking/index.js";
import { openAIChatUsage } from "../wires/index.js";
import { kimiFileExtractChannel } from "./kimi-attachments.js";
import { KIMI_USAGE_TABLE, kimiSamplingPolicy, kimiThinkingIntent } from "./kimi.js";
import {
	defineOpenAIChatDialect,
	openAIChatTransportCapabilities,
	promptCacheKeyExtraBody,
} from "./recipe.js";

export const KIMI_CODE_DIALECT = defineOpenAIChatDialect({
	id: "kimi-code",
	defaultBaseUrl: ONETHING_KIMI_CODING_PLAN_BASE_URL,
	reasoning: thinkingTypeWire,
	includeAssistantReasoning: true,
	// 同一套线材 = 同一张 usage 表(顶层 `cached_tokens`)。
	usage: openAIChatUsage(KIMI_USAGE_TABLE),
	// 同一批模型 = 同一套家规。套餐通路跑的就是开放平台那几族模型,所以采样
	// (Kimi 一律不发 temperature)与思考意图(k2.7-code 关思考时**什么都不发**,
	// 而不是发它拒收的 `thinking:{type:'disabled'}`)都直接复用 `./kimi.js`。
	sampling: kimiSamplingPolicy,
	thinkingIntent: kimiThinkingIntent,
	// Code Plan 把 `prompt_cache_key` 列为必填。
	extraBody: promptCacheKeyExtraBody,
	// 同一套线材 = 同一条附件旁路(P4-6)。地址跟着 `baseUrl` 走,所以套餐通路
	// 打的是 `https://api.kimi.com/coding/v1/files` —— 与开放平台是不是同一个
	// 后端**待真机核**;打不通就是一条 warning + 可见留痕,不是这一回合失败。
	attachments: kimiFileExtractChannel,
	fileViaExtraction: true,
	transport: openAIChatTransportCapabilities({ reasoning: true, file: true }),
});
