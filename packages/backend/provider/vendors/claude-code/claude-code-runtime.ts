/**
 * Claude Code(Pro / Max 订阅)的**行为**那一半(`docs/design/architecture-direction-2026-10.md` §4 P2):
 * 方言、运行时工厂、配额源。数据那一半在同目录的 `manifest.ts`。
 *
 * 与 `claude` 同一条 anthropic-messages 线,差别是凭据:OAuth access_token 放进 `authorization`
 * 头(所以 `x-api-key` 不发),外加订阅通路要的 beta 头。OAuth 凭证在 authContext 里,
 * `config.apiKey` 对 OAuth provider 恒为空串 —— 必须走 `kit.accessToken`,与别的订阅型家同一条路。
 */
import {
	anthropicAuth,
	createAnthropicProvider,
} from "../../dialects/anthropic-recipe.js";
import type { VendorRuntime } from "../runtimes.js";
import { CLAUDE_CODE_DIALECT, CLAUDE_CODE_OAUTH_BETA_HEADERS } from "./claude-code-dialect.js";
import { CLAUDE_CODE_CONFIG } from "./claude-code-oauth.js";
import { claudeCodeQuotaSource } from "./claude-code-quota.js";

export const CLAUDE_CODE_RUNTIME: VendorRuntime = {
	id: "claude-code",
	quotaSources: [claudeCodeQuotaSource],
	oauth: CLAUDE_CODE_CONFIG,
	createProvider: (config, options, kit) => {
		const accessToken = kit.accessToken(config);
		if (!accessToken) {
			throw new Error("Not logged in to Claude Code. Please login first.");
		}
		return createAnthropicProvider(CLAUDE_CODE_DIALECT, {
			baseUrl: config.baseUrl,
			auth: anthropicAuth({
				omitApiKeyHeader: true,
				headers: {
					authorization: `Bearer ${accessToken}`,
					"anthropic-beta": CLAUDE_CODE_OAUTH_BETA_HEADERS,
				},
			}),
			fetchImpl: options.fetchImpl,
			requestDumper: options.requestDumper,
			profiles: kit.profiles(config),
		});
	},
};
