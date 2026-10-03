/**
 * GitHub Copilot(订阅)的**行为**那一半(`docs/design/architecture-direction-2026-10.md` §4 P2 第 4 批):
 * 方言、运行时工厂(含 GitHub OAuth token → Copilot 补全 token 的两步交换与它的缓存)、OAuth 登录定义、
 * 列表口、目录兜底行。
 * 数据那一半在同目录的 `manifest.ts`。
 *
 * 与搬家前 `factory.ts` 那段登记及 `copilotTokenCache` / `getCopilotCompletionToken` 逐字同口径。
 * 注意:列模型那一路(`models.ts` 的 `fetchCopilotModels`)另有一份**自己的**补全 token 缓存,语义略有出入
 * (那一份先落缓存再判 token 有没有),两份都是搬家前的原样,合并是行为变化,留待另拍。
 */
import { ResolveAuth } from "../../base/index.js";
import { createOpenAIChatProvider } from "../../dialects/recipe.js";
import type { VendorRuntime } from "../runtimes.js";
import { GITHUB_COPILOT_DIALECT } from "./dialect.js";
import { copilotFallbackModel, fetchCopilotModels } from "./models.js";
import {
	createOnethingCopilotModelsFetcher,
	fetchOnethingGitHubCopilotModelsWithAuth,
} from "./models-fetcher.js";
import { GITHUB_COPILOT_CONFIG } from "./oauth.js";

interface CopilotCompletionToken {
	token: string;
	expiresAt: number;
}

interface CopilotTokenResponse {
	token?: string;
	expires_in?: number;
}

const copilotTokenCache = new Map<string, CopilotCompletionToken>();

async function getCopilotCompletionToken(
	githubAccessToken: string,
	fetchImpl: typeof globalThis.fetch,
): Promise<string> {
	const cached = copilotTokenCache.get(githubAccessToken);
	if (cached && cached.expiresAt > Date.now() + 60000) {
		return cached.token;
	}

	const response = await fetchImpl(
		"https://api.github.com/copilot_internal/v2/token",
		{
			method: "GET",
			headers: {
				Authorization: `Bearer ${githubAccessToken}`,
				Accept: "application/json",
				"User-Agent": "onething/1.0",
				"Editor-Version": "vscode/1.85.1",
				"Editor-Plugin-Version": "copilot-chat/0.29.1",
			},
		},
	);

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Failed to get Copilot token: ${response.status} ${text}`);
	}

	const data = (await response.json()) as CopilotTokenResponse;
	if (!data.token) {
		throw new Error(
			"Failed to get Copilot token: response did not include a token",
		);
	}

	copilotTokenCache.set(githubAccessToken, {
		token: data.token,
		expiresAt: Date.now() + (data.expires_in ?? 1800) * 1000,
	});
	return data.token;
}

export const GITHUB_COPILOT_RUNTIME: VendorRuntime = {
	id: "github-copilot",
	oauth: GITHUB_COPILOT_CONFIG,
	// 列表口:与搬家前 `backend/runtime/providers/providers-client-api-models.ts` 的 `fetchGitHubCopilotModelsRaw` 逐字同口径
	// (token 走 `getToken`,不刷新)。
	createModelsFetcher: (deps) =>
		createOnethingCopilotModelsFetcher({
			fetchCopilotModels: () =>
				fetchOnethingGitHubCopilotModelsWithAuth({
					getToken: (providerId) => deps.getToken(providerId),
					fetchCopilotModels: (accessToken) => fetchCopilotModels(accessToken, deps.fetch),
				}),
			getModelsForProvider: deps.getModelsForProvider,
			logger: deps.logger,
		}),
	fallbackModels: {
		model: copilotFallbackModel,
		all: () => [],
	},
	createProvider: (config, options, kit) => {
		const githubAccessToken = kit.accessToken(config);
		if (!githubAccessToken) {
			throw new Error("Not logged in to GitHub Copilot. Please login first.");
		}
		const fetchImpl = options.fetchImpl ?? globalThis.fetch;
		return createOpenAIChatProvider(GITHUB_COPILOT_DIALECT, {
			baseUrl: config.baseUrl,
			fetchImpl,
			requestDumper: options.requestDumper,
			profiles: kit.profiles(config),
			auth: new ResolveAuth(
				async () => ({
					apiKey: await getCopilotCompletionToken(githubAccessToken, fetchImpl),
				}),
				{
					headers: {
						"Editor-Version": "vscode/1.85.1",
						"Editor-Plugin-Version": "copilot-chat/0.29.1",
						"Copilot-Integration-Id": "vscode-chat",
						"User-Agent": "onething/1.0",
						"OpenAI-Intent": "conversation-panel",
					},
				},
			),
		});
	},
};
