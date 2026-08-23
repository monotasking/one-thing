/**
 * `grok-oauth` —— 与 `grok` 同一套线材,只有凭证不同(OAuth access_token,
 * `config.apiKey` 对它恒为空串)。配方本身一字不差,分开一份是因为
 * providerId 不同:错误消息、dump、账本都按 id 归档。
 */
import { grokEffortWire } from "../thinking/index.js";
import { defineOpenAIChatDialect, openAIChatTransportCapabilities } from "./recipe.js";

export const GROK_OAUTH_DIALECT = defineOpenAIChatDialect({
	id: "grok-oauth",
	defaultBaseUrl: "https://api.x.ai/v1",
	reasoning: grokEffortWire,
	includeAssistantReasoning: true,
	transport: openAIChatTransportCapabilities({ vision: true, reasoning: true }),
});
