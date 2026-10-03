/**
 * Codex(ChatGPT 订阅)的 OAuth 登录定义(经 `runtime.ts` 的 `oauth` 一格登记,`auth/registry.ts` 惰性读名册建表)。
 *
 * 服务商自述试点 P2 第 4 批从 `auth/registry.ts` 的手列五份配置里搬回家,逐字。
 * token 归一多读 id_token / access_token 里 `https://api.openai.com/auth` 那组声明(账号、套餐、FedRAMP)。
 */
import { parseJwtExpiration, parseJwtPayload, normalizeGenericOAuthToken } from "@onething/backend/network";
import type {
	OnethingAuthProviderDefinition,
	OnethingOAuthToken,
} from "../../../auth/types.js";

function normalizeCodexToken(
	data: any,
	currentToken?: OnethingOAuthToken | null,
): OnethingOAuthToken {
	const base = normalizeGenericOAuthToken(data, currentToken);
	const idToken = data.id_token || currentToken?.idToken;
	const accessToken = data.access_token || currentToken?.accessToken;
	const idClaims = parseJwtPayload(idToken);
	const accessClaims = parseJwtPayload(accessToken);
	const authClaims =
		idClaims?.["https://api.openai.com/auth"] ||
		accessClaims?.["https://api.openai.com/auth"] ||
		{};
	const expiresAt =
		parseJwtExpiration(accessToken) ||
		parseJwtExpiration(idToken) ||
		base.expiresAt;

	return {
		...base,
		idToken,
		expiresAt,
		accountId: authClaims.chatgpt_account_id || currentToken?.accountId,
		email: idClaims?.email || accessClaims?.email || currentToken?.email,
		planType: authClaims.chatgpt_plan_type || currentToken?.planType,
		isFedrampAccount:
			typeof authClaims.chatgpt_account_is_fedramp === "boolean"
				? authClaims.chatgpt_account_is_fedramp
				: currentToken?.isFedrampAccount,
		providerMetadata: {
			...(currentToken?.providerMetadata ?? {}),
			chatgptUserId: authClaims.chatgpt_user_id,
		},
	};
}

export const CODEX_CONFIG: OnethingAuthProviderDefinition = {
	providerId: "codex",
	name: "Codex",
	flowKind: "pkce-callback",
	oauthFlow: "authorization-code",
	clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
	authorizationUrl: "https://auth.openai.com/oauth/authorize",
	tokenUrl: "https://auth.openai.com/oauth/token",
	refreshUrl: "https://auth.openai.com/oauth/token",
	scopes: [
		"openid",
		"profile",
		"email",
		"offline_access",
		"api.connectors.read",
		"api.connectors.invoke",
	],
	callbackPath: "/auth/callback",
	callbackPorts: [1455, 1457],
	stateStrategy: "random",
	tokenBodyFormat: "form",
	refreshBodyFormat: "json",
	authorizationParams: (ctx) => ({
		response_type: "code",
		client_id: CODEX_CONFIG.clientId,
		redirect_uri: ctx.redirectUri || "",
		scope: CODEX_CONFIG.scopes.join(" "),
		code_challenge: ctx.codeChallenge || "",
		code_challenge_method: "S256",
		id_token_add_organizations: "true",
		codex_cli_simplified_flow: "true",
		state: ctx.state || "",
		originator: "codex_cli_rs",
	}),
	tokenParams: (ctx) => ({
		grant_type: "authorization_code",
		code: ctx.code,
		redirect_uri: ctx.redirectUri || "",
		client_id: CODEX_CONFIG.clientId,
		code_verifier: ctx.codeVerifier || "",
	}),
	refreshParams: (refreshToken) => ({
		client_id: CODEX_CONFIG.clientId,
		grant_type: "refresh_token",
		refresh_token: refreshToken,
	}),
	normalizeToken: normalizeCodexToken,
	statusMessage: "Connected with ChatGPT subscription",
};
