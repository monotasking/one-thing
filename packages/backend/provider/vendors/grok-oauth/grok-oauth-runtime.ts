/**
 * `grok-oauth`(SuperGrok / X Premium+ 订阅)的**行为**那一半(`docs/design/architecture-direction-2026-10.md`
 * §4 P2 第 4 批):方言与运行时工厂。数据那一半在同目录的 `manifest.ts`。
 *
 * 与 `grok` 同一套线材,只有凭证不同:OAuth access_token 在 authContext 里,`config.apiKey`
 * 对 OAuth provider 恒为空串 —— 必须走 `kit.accessToken`,与别的订阅型家同一条路。
 * 与搬家前 `factory.ts` 那段登记逐字同口径。
 */
import { BearerApiKeyAuth } from "../../base/provider-base.js";
import { createResponsesProvider } from "../../dialects/responses-recipe.js";
import type { VendorRuntime } from "../runtimes.js";
import { GROK_OAUTH_DIALECT } from "./grok-oauth-dialect.js";
import { GROK_FALLBACK_CATALOG } from "../grok/fallback-models.js";
import { GROK_OAUTH_CONFIG } from "./grok-oauth-flow.js";

export const GROK_OAUTH_RUNTIME: VendorRuntime = {
	id: "grok-oauth",
	oauth: GROK_OAUTH_CONFIG,
	fallbackModels: GROK_FALLBACK_CATALOG,
	createProvider: (config, options, kit) => {
		const accessToken = kit.accessToken(config);
		if (!accessToken) {
			throw new Error("Not logged in to Grok. Please login first.");
		}
		return createResponsesProvider(GROK_OAUTH_DIALECT, {
			baseUrl: config.baseUrl,
			auth: new BearerApiKeyAuth(accessToken),
			fetchImpl: options.fetchImpl,
			requestDumper: options.requestDumper,
			profiles: kit.profiles(config),
		});
	},
};
