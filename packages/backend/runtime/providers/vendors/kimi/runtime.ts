/**
 * Kimi(开放平台,按量)的**行为**那一半(`docs/design/architecture-direction-2026-10.md` §4 P2):
 * 运行时工厂与余额源。方言在同目录 `dialect.ts`(附件旁路 `attachments.ts`),数据在 `manifest.ts`。
 *
 * 由 `vendors/runtimes.ts` 登记;工厂里不再有「kimi」这几个字。
 */
import { BearerApiKeyAuth } from "../../base/index.js";
import { createOpenAIChatProvider } from "../../dialects/recipe.js";
import type { VendorRuntime } from "../runtimes.js";
import { KIMI_DIALECT } from "./dialect.js";
import { readOnethingKimiOptions, resolveOnethingKimiBaseUrl } from "./endpoint.js";
import { kimiQuotaSource } from "./quota.js";

export const KIMI_RUNTIME: VendorRuntime = {
	id: "kimi",
	quotaSources: [kimiQuotaSource],
	createProvider: (config, options, kit) =>
		createOpenAIChatProvider(KIMI_DIALECT, {
			// 开放平台(按量,国内/海外)与 Kimi Code(编程套餐)是三个地址、两种
			// 计费。选错不是报错而是**多扣钱**:订阅用户留着通用地址会照按量再计一次。
			baseUrl: resolveOnethingKimiBaseUrl({
				baseUrl: config.baseUrl,
				...readOnethingKimiOptions(config.providerOptions),
			}),
			auth: new BearerApiKeyAuth(config.apiKey),
			fetchImpl: options.fetchImpl,
			requestDumper: options.requestDumper,
			profiles: kit.profiles(config),
		}),
};
