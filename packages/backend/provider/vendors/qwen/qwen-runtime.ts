/**
 * 千问的**行为**那一半(`docs/design/architecture-direction-2026-10.md` §4 P2):
 * 方言、思考参数、运行时工厂。数据那一半在同目录的 `manifest.ts`。
 *
 * 由 `vendors/runtimes.ts` 登记;工厂里不再有「qwen」这几个字。
 */
import { BearerApiKeyAuth } from "../../base/provider-base.js";
import { createOpenAIChatProvider } from "../../dialects/recipe.js";
import type { VendorRuntime } from "../runtimes.js";
import { QWEN_DIALECT } from "./qwen-dialect.js";
import { readOnethingQwenOptions, resolveOnethingQwenBaseUrl } from "./qwen-endpoint.js";
import { qwenThinkingWire } from "./qwen-thinking.js";

export const QWEN_RUNTIME: VendorRuntime = {
	id: "qwen",
	thinkingWires: [qwenThinkingWire],
	createProvider: (config, options, kit) =>
		createOpenAIChatProvider(QWEN_DIALECT, {
			baseUrl: resolveOnethingQwenBaseUrl({
				baseUrl: config.baseUrl,
				...readOnethingQwenOptions(config.providerOptions),
			}),
			auth: new BearerApiKeyAuth(config.apiKey),
			fetchImpl: options.fetchImpl,
			requestDumper: options.requestDumper,
			profiles: kit.profiles(config),
		}),
};
