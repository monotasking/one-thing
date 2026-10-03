/**
 * DeepSeek 的**行为**那一半(`docs/design/architecture-direction-2026-10.md` §4 P2):
 * 方言、思考参数、运行时工厂、余额源。数据那一半在同目录的 `manifest.ts`。
 *
 * 由 `vendors/runtimes.ts` 登记;工厂里不再有「deepseek」这几个字。
 */
import { BearerApiKeyAuth } from "../../base/index.js";
import { createOpenAIChatProvider } from "../../dialects/recipe.js";
import {
	capabilitiesFromFlags,
	capabilityLimitsFromRuntimeConfig,
	runtimeCapabilityFlags,
} from "../../dialects/runtime-transport.js";
import type { VendorRuntime } from "../runtimes.js";
import { DEEPSEEK_DIALECT } from "./dialect.js";
import { deepseekQuotaSource } from "./quota.js";
import { deepSeekInferredThinkingWire } from "./thinking.js";

export const DEEPSEEK_RUNTIME: VendorRuntime = {
	id: "deepseek",
	thinkingWires: [deepSeekInferredThinkingWire],
	quotaSources: [deepseekQuotaSource],
	createProvider: (config, options, kit) =>
		createOpenAIChatProvider(DEEPSEEK_DIALECT, {
			baseUrl: config.baseUrl,
			auth: new BearerApiKeyAuth(config.apiKey ?? ""),
			fetchImpl: options.fetchImpl,
			requestDumper: options.requestDumper,
			profiles: kit.profiles(config),
			// 传输声明按配置里默认模型的元数据算(三旋钮 + 上下文上限);
			// `provider-factory.test` 钉着静态 `capabilities.maxInputTokens`。
			transport: {
				...capabilitiesFromFlags(
					runtimeCapabilityFlags(config, {
						tools: true,
						vision: false,
						reasoning: true,
					}),
				),
				...capabilityLimitsFromRuntimeConfig(config),
			},
		}),
};
