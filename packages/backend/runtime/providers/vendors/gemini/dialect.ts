/**
 * `gemini` —— 官方 Generative Language 端点。对照同目录 `runtime.ts`:
 * `defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta'`、
 * 钥匙只走 `x-goog-api-key` 头(P2-b 前还同时挂 URL 的 `?key=`),传输声明是
 * `GEMINI_CAPABILITIES` 原样。
 *
 * 服务商自述试点 P2 第 2 批从 `agent-loop/providers/dialects/gemini.ts` 搬回家;定义即登记。
 * 线协议的公共构件(`gemini-recipe.ts`、`wires/gemini-*`、`thinking/gemini-thinking.ts`)留在
 * agent-loop。自定义服务商的 gemini 适配表以这份配方为底(下面的 `referenceFor`)。
 */
import { registerDialect } from "../../base/dialect.js";
import {
	GEMINI_DEFAULT_BASE_URL,
	geminiDialect,
} from "../../dialects/gemini-recipe.js";

// 自定义服务商选 gemini-generateContent 线时以这份配方为底(`referenceFor`,`custom-from-spec.ts` 按线查名册)。
// 建表 + 登记与 `defineGeminiDialect` 是同两步,只是多声明这一格。
export const GEMINI_DIALECT = {
	...geminiDialect({
		id: "gemini",
		label: "Gemini",
		defaultBaseUrl: GEMINI_DEFAULT_BASE_URL,
		// P4-2:图像模型回普通流之后,多轮改图要求把上一条 model 回复里的生成图
		// 原样放回 `contents`。全仓只有这一份配方开着。
		replayGeneratedImages: true,
	}),
	referenceFor: "gemini-generateContent" as const,
};
registerDialect(GEMINI_DIALECT);
