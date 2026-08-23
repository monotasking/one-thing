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
	transport: openAIChatTransportCapabilities({ reasoning: true }),
});
