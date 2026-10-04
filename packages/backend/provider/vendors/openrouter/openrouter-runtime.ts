/**
 * OpenRouter 的**行为**那一半(`docs/design/architecture-direction-2026-10.md` §4 P2):
 * 运行时工厂与余额源。方言在同目录 `dialect.ts`,数据在 `manifest.ts`。
 * 思考线型 `openrouter-reasoning` 留在 agent-loop(理由见 `dialect.ts` 的 import 处)。
 *
 * 由 `vendors/runtimes.ts` 登记;工厂里不再有「openrouter」这几个字。
 */
import { BearerApiKeyAuth } from "../../base/provider-base.js";
import { createOpenAIChatProvider } from "../../dialects/recipe.js";
import type { VendorRuntime } from "../runtimes.js";
import { OPENROUTER_DIALECT } from "./openrouter-dialect.js";
import { openrouterQuotaSource } from "./openrouter-quota.js";

export const OPENROUTER_RUNTIME: VendorRuntime = {
	id: "openrouter",
	quotaSources: [openrouterQuotaSource],
	createProvider: (config, options, kit) =>
		createOpenAIChatProvider(OPENROUTER_DIALECT, {
			baseUrl: config.baseUrl,
			auth: new BearerApiKeyAuth(config.apiKey),
			fetchImpl: options.fetchImpl,
			requestDumper: options.requestDumper,
			profiles: kit.profiles(config),
		}),
};
