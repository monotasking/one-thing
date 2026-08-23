/**
 * `codex` —— ChatGPT 后端的 Responses 端点。与 `factory.ts` 今天那条注册逐项
 * 对照:`defaultBaseUrl: 'https://chatgpt.com/backend-api/codex'`、凭据走
 * OAuth(三级解析 + 401 强制刷新一次)、传输声明是 `CODEX_AGENT_CAPABILITIES`
 * 原样、一条 system 都没有时的 `instructions` 兜底是
 * `CODEX_FALLBACK_INSTRUCTIONS`。
 *
 * 它是 openai-responses 这条线上**唯一**的方言(设计稿 §9 P1:第二个
 * responses 方言落地之前,这个类叫 `OpenAIResponsesWire` 还是
 * `CodexResponsesWire` 由那时候决定)。
 */
import { CODEX_BASE_URL, defineResponsesDialect } from "./responses-recipe.js";

export const CODEX_DIALECT = defineResponsesDialect({
	id: "codex",
	defaultBaseUrl: CODEX_BASE_URL,
});
