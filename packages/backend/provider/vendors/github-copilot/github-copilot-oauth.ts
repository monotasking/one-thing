/**
 * GitHub Copilot 的 OAuth 登录定义(经 `runtime.ts` 的 `oauth` 一格登记,`auth/auth-registry.ts` 惰性读名册建表)。
 *
 * 服务商自述试点 P2 第 4 批从 `auth/auth-registry.ts` 的手列五份配置里搬回家,逐字。
 */
import { normalizeGenericOAuthToken } from "@onething/backend/network";
import type { OnethingAuthProviderDefinition } from "../../../auth/auth-types.js";

export const GITHUB_COPILOT_CONFIG: OnethingAuthProviderDefinition = {
	providerId: "github-copilot",
	name: "GitHub Copilot",
	flowKind: "device-code",
	oauthFlow: "device",
	clientId: "Iv1.b507a08c87ecfe98",
	authorizationUrl: "https://github.com/login/device",
	tokenUrl: "https://github.com/login/oauth/access_token",
	deviceCodeUrl: "https://github.com/login/device/code",
	scopes: ["copilot"],
	tokenBodyFormat: "form",
	normalizeToken: normalizeGenericOAuthToken,
};
