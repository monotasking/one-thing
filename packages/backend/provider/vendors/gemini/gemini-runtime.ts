/**
 * Gemini(Google 官方 Generative Language 端点)的**行为**那一半
 * (`docs/design/architecture-direction-2026-10.md` §4 P2):方言与运行时工厂。数据那一半在
 * 同目录的 `manifest.ts`。
 *
 * 由 `vendors/runtimes.ts` 登记;工厂里不再点这家的名。与搬家前 `factory.ts` 那段登记逐字同口径,
 * 包括透传只读媒体端口 `options.media`(多轮改图把历史生成图放回 `contents`,P4-2)。
 */
import {
	createGeminiProvider,
	geminiAuth,
} from "../../dialects/gemini-recipe.js";
import type { VendorRuntime } from "../runtimes.js";
import { GEMINI_DIALECT } from "./gemini-dialect.js";

export const GEMINI_RUNTIME: VendorRuntime = {
	id: "gemini",
	createProvider: (config, options, kit) =>
		createGeminiProvider(GEMINI_DIALECT, {
			baseUrl: config.baseUrl,
			auth: geminiAuth({ apiKey: config.apiKey }),
			fetchImpl: options.fetchImpl,
			requestDumper: options.requestDumper,
			profiles: kit.profiles(config),
			media: options.media,
		}),
};
