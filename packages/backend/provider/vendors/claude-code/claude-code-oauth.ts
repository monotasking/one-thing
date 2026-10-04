/**
 * Claude Code 的 OAuth 登录定义(经 `runtime.ts` 的 `oauth` 一格登记,`auth/auth-registry.ts` 惰性读名册建表)。
 *
 * 服务商自述试点 P2 第 4 批从 `auth/auth-registry.ts` 的手列五份配置里搬回家,逐字。
 */
import { normalizeGenericOAuthToken } from "@onething/backend/network";
import type { OnethingAuthProviderDefinition } from "../../../auth/auth-types.js";

export const CLAUDE_CODE_CONFIG: OnethingAuthProviderDefinition = {
	providerId: "claude-code",
	name: "Claude Code",
	flowKind: "manual-pkce",
	oauthFlow: "authorization-code",
	clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
	authorizationUrl: "https://claude.ai/oauth/authorize",
	tokenUrl: "https://console.anthropic.com/v1/oauth/token",
	redirectUri: "https://console.anthropic.com/oauth/code/callback",
	scopes: ["org:create_api_key", "user:profile", "user:inference"],
	stateStrategy: "code-verifier",
	tokenBodyFormat: "json",
	refreshBodyFormat: "json",
	tokenHeaders: {
		Accept: "application/json, text/plain, */*",
		"Accept-Language": "en-US,en;q=0.9",
		"User-Agent":
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
		Origin: "https://claude.ai",
		Referer: "https://claude.ai/",
	},
	authorizationParams: (ctx) => ({
		code: "true",
		client_id: CLAUDE_CODE_CONFIG.clientId,
		response_type: "code",
		redirect_uri: CLAUDE_CODE_CONFIG.redirectUri || "",
		code_challenge: ctx.codeChallenge || "",
		code_challenge_method: "S256",
		scope: CLAUDE_CODE_CONFIG.scopes.join(" "),
		state: ctx.state || "",
	}),
	tokenParams: (ctx) => ({
		grant_type: "authorization_code",
		client_id: CLAUDE_CODE_CONFIG.clientId,
		code: ctx.code,
		redirect_uri: CLAUDE_CODE_CONFIG.redirectUri || "",
		code_verifier: ctx.codeVerifier || "",
		state: ctx.state || "",
	}),
	codeEntryInstructions:
		"After authorizing, copy the entire code shown on the page, including any # and text after it, and paste it here.",
	normalizeToken: normalizeGenericOAuthToken,
};
