/**
 * `grok-oauth` —— 与 `grok` 同一套线材(`POST https://api.x.ai/v1/responses`),
 * 只有凭证不同(OAuth access_token,`config.apiKey` 对它恒为空串)。配方本身
 * 一字不差 —— 分开一份是因为 providerId 不同:错误消息、dump、账本都按 id 归档。
 *
 * **provider-data 标签仍然是 `'grok'`**(不是 `'grok-oauth'`):消息上的加密
 * 思维链与引文按家族归档,于是同一段历史在两条通路之间切换时回放不断。
 * 这一条与 P3-5a 的 `decodeGrokCitations` 逐字同规,只是从 chat 换到了
 * Responses(P4-4)。
 */
import { GROK_DIALECT_SPEC } from "./grok.js";
import { defineResponsesDialect } from "./responses-recipe.js";

export const GROK_OAUTH_DIALECT = defineResponsesDialect({
	id: "grok-oauth",
	...GROK_DIALECT_SPEC,
});
