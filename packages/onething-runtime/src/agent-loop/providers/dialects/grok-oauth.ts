/**
 * `grok-oauth` —— 与 `grok` 同一套线材,只有凭证不同(OAuth access_token,
 * `config.apiKey` 对它恒为空串)。配方本身一字不差,分开一份是因为
 * providerId 不同:错误消息、dump、账本都按 id 归档。
 */
import { grokEffortWire } from "../thinking/index.js";
import { openAIChatUsage } from "../wires/index.js";
import { GROK_PROVIDER_OPTIONS, GROK_USAGE_TABLE, decodeGrokCitations } from "./grok.js";
import {
	defineOpenAIChatDialect,
	openAIChatTransportCapabilities,
	promptCacheKeyExtraBody,
} from "./recipe.js";

export const GROK_OAUTH_DIALECT = defineOpenAIChatDialect({
	id: "grok-oauth",
	defaultBaseUrl: "https://api.x.ai/v1",
	reasoning: grokEffortWire,
	includeAssistantReasoning: true,
	usage: openAIChatUsage(GROK_USAGE_TABLE),
	extraBody: promptCacheKeyExtraBody,
	// 线材与 `grok` 一字不差:Live Search 的请求侧白名单与响应侧 `citations[]`
	// 都从那份配方借过来(P3-5a),两条通路对同一个端点永远同解。
	decodeExtras: decodeGrokCitations,
	providerOptions: GROK_PROVIDER_OPTIONS,
	transport: openAIChatTransportCapabilities({ vision: true, reasoning: true }),
});
