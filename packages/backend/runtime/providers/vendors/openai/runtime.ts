/**
 * `openai`(OpenAI 官方端点,按量 API key)的**行为**那一半(`docs/design/architecture-direction-2026-10.md`
 * §4 P2 第 4 批):方言与运行时工厂。数据那一半在同目录的 `manifest.ts`。
 *
 * OpenAI 官方通路 P4-5 起走 **openai-responses**(`POST /v1/responses`);官方把 Responses 定成新的
 * 基元,而加密思维链回放 / `input_file`(PDF)/ 原生 `image_generation` 只在这条线上有出口。凭据形状
 * 一个字没变(Bearer API key)。`custom-*`(apiType `openai`)与 `github-copilot` **仍走
 * chat-completions**:自建端点与 Copilot 后台大多只实现了那条接口。
 *
 * 与搬家前 `factory.ts` 那段登记逐字同口径。
 */
import { BearerApiKeyAuth } from "../../base/index.js";
import { createResponsesProvider } from "../../dialects/responses-recipe.js";
import type { VendorRuntime } from "../runtimes.js";
import { OPENAI_DIALECT } from "./dialect.js";

export const OPENAI_RUNTIME: VendorRuntime = {
	id: "openai",
	createProvider: (config, options, kit) =>
		createResponsesProvider(OPENAI_DIALECT, {
			baseUrl: config.baseUrl,
			auth: new BearerApiKeyAuth(config.apiKey),
			fetchImpl: options.fetchImpl,
			requestDumper: options.requestDumper,
			profiles: kit.profiles(config),
		}),
};
