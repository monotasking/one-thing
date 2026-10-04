/**
 * 智谱的**行为**那一半(`docs/design/architecture-direction-2026-10.md` §4 P1):
 * 方言、思考参数、运行时工厂。数据那一半在同目录的 `manifest.ts`。
 *
 * 由 `vendors/runtimes.ts` 登记;`providers/factory.ts` 按名册把 `createProvider`
 * 接进运行时工厂表 —— 工厂里不再有「zhipu」这几个字。
 */
import { BearerApiKeyAuth } from "../../base/provider-base.js";
import { createOpenAIChatProvider } from "../../dialects/recipe.js";
import type { VendorRuntime } from "../runtimes.js";
import { ZHIPU_DIALECT } from "./zhipu-dialect.js";
import { normalizeOnethingZhipuApiMode, resolveOnethingZhipuBaseUrl } from "./zhipu-endpoint.js";
import { zhipuThinkingWire } from "./zhipu-thinking.js";

export const ZHIPU_RUNTIME: VendorRuntime = {
	id: "zhipu",
	thinkingWires: [zhipuThinkingWire],
	createProvider: (config, options, kit) =>
		createOpenAIChatProvider(ZHIPU_DIALECT, {
			baseUrl: resolveOnethingZhipuBaseUrl({
				baseUrl: config.baseUrl,
				zhipuApiMode: normalizeOnethingZhipuApiMode(config.providerOptions?.zhipuApiMode),
			}),
			auth: new BearerApiKeyAuth(config.apiKey),
			fetchImpl: options.fetchImpl,
			requestDumper: options.requestDumper,
			profiles: kit.profiles(config),
		}),
};
