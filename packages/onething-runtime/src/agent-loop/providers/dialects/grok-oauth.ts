/**
 * `grok-oauth` —— 与 `grok` 同一套线材,只有凭证不同(OAuth access_token,
 * `config.apiKey` 对它恒为空串)。配方本身一字不差,分开一份是因为
 * providerId 不同:错误消息、dump、账本都按 id 归档。
 */
import { grokEffortWire } from "../thinking/index.js";
import { OPENAI_CHAT_IMAGE_DETAIL_VALUES, openAIChatUsage } from "../wires/index.js";
import { GROK_USAGE_TABLE } from "./grok.js";
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
	// xAI 的 vision 端点收 `image_url.detail`(标准三值);`verbosity` 是
	// OpenAI 自己的字段,这家不认(P3-3)。
	providerOptions: { imageDetail: OPENAI_CHAT_IMAGE_DETAIL_VALUES },
	transport: openAIChatTransportCapabilities({ vision: true, reasoning: true }),
});
