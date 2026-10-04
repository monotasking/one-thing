/**
 * Grok(SuperGrok / X Premium+ 订阅)的 OAuth 登录定义(经 `runtime.ts` 的 `oauth` 一格登记,`auth/auth-registry.ts` 惰性读名册建表)。
 *
 * 服务商自述试点 P2 第 4 批从 `auth/auth-registry.ts` 的手列五份配置里搬回家,逐字。
 */
import { normalizeGenericOAuthToken } from "@onething/backend/network";
import type { OnethingAuthProviderDefinition } from "../../../auth/auth-types.js";

export const GROK_OAUTH_CONFIG: OnethingAuthProviderDefinition = {
	providerId: "grok-oauth",
	name: "Grok (SuperGrok / X Premium+)",
	flowKind: "device-code",
	oauthFlow: "device",
	clientId: "b1a00492-073a-47ea-816f-4c329264a828",
	tokenUrl: "https://auth.x.ai/oauth2/token",
	deviceCodeUrl: "https://auth.x.ai/oauth2/device/code",
	scopes: [
		"openid",
		"profile",
		"email",
		"offline_access",
		"grok-cli:access",
		"api:access",
	],
	tokenBodyFormat: "form",
	normalizeToken: normalizeGenericOAuthToken,
};
