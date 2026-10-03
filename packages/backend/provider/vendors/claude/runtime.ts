/**
 * Claude(Anthropic 官方端点,按量 API key)的**行为**那一半(`docs/design/architecture-direction-2026-10.md`
 * §4 P2):方言与运行时工厂。数据那一半在同目录的 `manifest.ts`。
 *
 * 由 `vendors/runtimes.ts` 登记;工厂里不再点这家的名。凭据走 `x-api-key`(`anthropicAuth`),
 * 与搬家前 `factory.ts` 那段登记逐字同口径。
 */
import {
	anthropicAuth,
	createAnthropicProvider,
} from "../../dialects/anthropic-recipe.js";
import type { VendorRuntime } from "../runtimes.js";
import { CLAUDE_DIALECT } from "./dialect.js";

export const CLAUDE_RUNTIME: VendorRuntime = {
	id: "claude",
	createProvider: (config, options, kit) =>
		createAnthropicProvider(CLAUDE_DIALECT, {
			baseUrl: config.baseUrl,
			auth: anthropicAuth({ apiKey: config.apiKey }),
			fetchImpl: options.fetchImpl,
			requestDumper: options.requestDumper,
			profiles: kit.profiles(config),
		}),
};
