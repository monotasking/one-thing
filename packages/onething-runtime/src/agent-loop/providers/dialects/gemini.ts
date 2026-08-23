/**
 * `gemini` —— 官方 Generative Language 端点。与 `factory.ts` 今天那条注册逐项
 * 对照:`defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta'`、
 * 钥匙只走 `x-goog-api-key` 头(P2-b 前还同时挂 URL 的 `?key=`),传输声明是
 * `GEMINI_CAPABILITIES` 原样。
 */
import { GEMINI_DEFAULT_BASE_URL, defineGeminiDialect } from "./gemini-recipe.js";

export const GEMINI_DIALECT = defineGeminiDialect({
	id: "gemini",
	defaultBaseUrl: GEMINI_DEFAULT_BASE_URL,
});
