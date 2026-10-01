/**
 * Kimi Code(订阅)的**行为**那一半(`docs/design/architecture-direction-2026-10.md` §4 P2)。
 *
 * 与 `kimi` 同一套 OpenAI 兼容线材,差别只有两处:地址钉死在套餐 host(不吃地区/档位),
 * 凭证是 OAuth access_token(klip-14:「OAuth 模型和 API 兼容性与当前 Bearer key 完全一致」)。
 * OAuth 凭证在 authContext 里,config.apiKey 对 OAuth provider 恒为空串 —— 必须走
 * `kit.accessToken`,与别的订阅型家同一条路。
 */
import { BearerApiKeyAuth } from "../../../agent-loop/providers/base/index.js";
import { createOpenAIChatProvider } from "../../../agent-loop/providers/dialects/recipe.js";
import { ONETHING_KIMI_CODING_PLAN_BASE_URL } from "../kimi/endpoint.js";
import type { VendorRuntime } from "../runtimes.js";
import { KIMI_CODE_DIALECT } from "./dialect.js";

export const KIMI_CODE_RUNTIME: VendorRuntime = {
	id: "kimi-code",
	createProvider: (config, options, kit) => {
		const accessToken = kit.accessToken(config);
		if (!accessToken) {
			throw new Error("Not logged in to Kimi Code. Please login first.");
		}
		return createOpenAIChatProvider(KIMI_CODE_DIALECT, {
			baseUrl: ONETHING_KIMI_CODING_PLAN_BASE_URL,
			auth: new BearerApiKeyAuth(accessToken),
			fetchImpl: options.fetchImpl,
			requestDumper: options.requestDumper,
			profiles: kit.profiles(config),
		});
	},
};
