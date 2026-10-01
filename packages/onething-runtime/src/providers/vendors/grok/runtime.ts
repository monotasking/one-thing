/**
 * `grok`(xAI,按量 API key)的**行为**那一半(`docs/design/architecture-direction-2026-10.md` §4 P2 第 4 批):
 * 方言、思考参数线型、运行时工厂。数据那一半在同目录的 `manifest.ts`。订阅那半边 `grok-oauth`
 * 借这里的方言主体与线型。
 *
 * xAI 的两条通路 P4-4 起走 **openai-responses**(`POST /v1/responses`);chat-completions 被官方标成
 * legacy,而加密思维链回放 / `input_file` / 结构化引文只在 Responses 上有出口。凭据形状一个字没变。
 * 与搬家前 `factory.ts` 那段登记逐字同口径。
 *
 * `thinkingWires` 登记的是 chat 那条 `grok-effort`(`openai-compatible.ts` 的构造门面按
 * `reasoningStyle` 取);Responses 那条只挂在方言配方上,与搬家前一样不进全局表。
 */
import { BearerApiKeyAuth } from "../../../agent-loop/providers/base/index.js";
import { createResponsesProvider } from "../../../agent-loop/providers/dialects/responses-recipe.js";
import type { VendorRuntime } from "../runtimes.js";
import { GROK_DIALECT } from "./dialect.js";
import { GROK_FALLBACK_CATALOG } from "./fallback-models.js";
import { grokEffortWire } from "./thinking.js";

export const GROK_RUNTIME: VendorRuntime = {
	id: "grok",
	thinkingWires: [grokEffortWire],
	fallbackModels: GROK_FALLBACK_CATALOG,
	createProvider: (config, options, kit) =>
		createResponsesProvider(GROK_DIALECT, {
			baseUrl: config.baseUrl,
			auth: new BearerApiKeyAuth(config.apiKey),
			fetchImpl: options.fetchImpl,
			requestDumper: options.requestDumper,
			profiles: kit.profiles(config),
		}),
};
