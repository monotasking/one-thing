/**
 * Codex(ChatGPT 订阅)的**行为**那一半(`docs/design/architecture-direction-2026-10.md` §4 P2 第 4 批):
 * 方言、运行时工厂、配额源、OAuth 登录定义、列表口、目录兜底行。数据那一半在同目录的 `manifest.ts`。
 *
 * 工厂与搬家前 `factory.ts` 那段 `registerAgentProviderRuntime("codex", …)` 逐字同口径:凭据走
 * `codexAuth`(三级解析 + 401 强制刷新一次),刷新口按这家的 id 回问宿主。
 */
import {
	codexAuth,
	createResponsesProvider,
} from "../../dialects/responses-recipe.js";
import type { VendorRuntime } from "../runtimes.js";
import { CODEX_DIALECT } from "./dialect.js";
import {
	fetchOnethingCodexModels,
	getOnethingCodexFallbackModel,
	getOnethingCodexFallbackModels,
} from "./models.js";
import { createOnethingCodexModelsFetcher } from "./models-fetcher.js";
import { CODEX_CONFIG } from "./oauth.js";
import { codexQuotaSource } from "./quota.js";

export const CODEX_RUNTIME: VendorRuntime = {
	id: "codex",
	quotaSources: [codexQuotaSource],
	oauth: CODEX_CONFIG,
	// 列表口:与搬家前 `backend/rpc/domains/models.ts` 的 `fetchCodexModelsRaw` + 兜底表逐字同口径
	// (token 走 `refreshTokenIfNeeded`,取数走宿主的 `default` policy fetch)。
	createModelsFetcher: (deps) =>
		createOnethingCodexModelsFetcher({
			fetchCodexModels: async () =>
				fetchOnethingCodexModels(await deps.refreshTokenIfNeeded("codex"), deps.fetch("default")),
			getModelsForProvider: deps.getModelsForProvider,
			saveProviderModels: deps.saveProviderModels,
			getCodexFallbackModels: (modelIds) => getOnethingCodexFallbackModels(modelIds),
			getConfiguredCodexModelSelection: () => deps.configuredSelection("codex"),
			logger: deps.logger,
		}),
	fallbackModels: {
		model: (modelId) => getOnethingCodexFallbackModel(modelId),
		all: () => getOnethingCodexFallbackModels(),
	},
	createProvider: (config, options, kit) =>
		createResponsesProvider(CODEX_DIALECT, {
			baseUrl: config.baseUrl,
			auth: codexAuth({
				apiKey: config.apiKey,
				oauthToken: config.oauthToken,
				authContext: config.authContext,
				refreshOAuthToken: options.refreshOAuthToken
					? forceRefresh => options.refreshOAuthToken!("codex", forceRefresh)
					: undefined,
			}),
			fetchImpl: options.fetchImpl,
			requestDumper: options.requestDumper,
			profiles: kit.profiles(config),
		}),
};
