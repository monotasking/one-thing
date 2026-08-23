/**
 * `kimi-code` —— Kimi Code(订阅)。与 `kimi` 同一套线材,差别只有两处:
 * 地址钉死在套餐 host(不吃地区/档位),凭证是 OAuth access_token
 * (klip-14:「OAuth 模型和 API 兼容性与当前 Bearer key 完全一致」)。
 */
import { ONETHING_KIMI_CODING_PLAN_BASE_URL } from "../../../providers/kimi.js";
import { thinkingTypeWire } from "../thinking/index.js";
import { openAIChatUsage } from "../wires/index.js";
import { KIMI_USAGE_TABLE } from "./kimi.js";
import { defineOpenAIChatDialect, openAIChatTransportCapabilities } from "./recipe.js";

export const KIMI_CODE_DIALECT = defineOpenAIChatDialect({
	id: "kimi-code",
	defaultBaseUrl: ONETHING_KIMI_CODING_PLAN_BASE_URL,
	reasoning: thinkingTypeWire,
	includeAssistantReasoning: true,
	// 同一套线材 = 同一张 usage 表(顶层 `cached_tokens`)。
	usage: openAIChatUsage(KIMI_USAGE_TABLE),
	// **没有** `thinkingIntent`:kimi 家规尚未挂到套餐通路 —— k2.7-code 关思考
	// 会发出它拒收的 `thinking:{type:'disabled'}`,待拍板后挂上
	// (`kimiThinkingIntent` 就在 `./kimi.js`,挂一行即可)。P2-a 保持今天的
	// 行为:这条通路走 `thinking-options.ts` 的通用规则。
	transport: openAIChatTransportCapabilities({ reasoning: true }),
});
