/**
 * OAuth 的两件通用件:PKCE 一对、以及把 token 端点的应答归一成 `OnethingOAuthToken`。
 *
 * 叶子模块(只 import 类型与 node 的 crypto):各家的 OAuth 定义(`providers/vendors/<id>/oauth.ts`)
 * 要用它们,而 `registry.ts` 会经服务商名册把那些定义拉进来 —— 放在 `registry.ts` 里就成了环。
 * `registry.ts` 原样再导出这两个名字,老的 import 路径不变(服务商自述试点 P2 第 4 批)。
 */
import crypto from "crypto";
import type { OnethingOAuthToken } from "./types.js";

const DEFAULT_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

export function generatePKCE(): {
	codeVerifier: string;
	codeChallenge: string;
} {
	const codeVerifier = crypto.randomBytes(32).toString("base64url");
	const codeChallenge = crypto
		.createHash("sha256")
		.update(codeVerifier)
		.digest("base64url");
	return { codeVerifier, codeChallenge };
}

export function normalizeGenericOAuthToken(
	data: any,
	currentToken?: OnethingOAuthToken | null,
): OnethingOAuthToken {
	const accessToken = data.access_token || currentToken?.accessToken;
	if (!accessToken) {
		throw new Error("OAuth response did not include an access token");
	}

	return {
		accessToken,
		refreshToken: data.refresh_token || currentToken?.refreshToken,
		expiresAt:
			typeof data.expires_in === "number"
				? Date.now() + data.expires_in * 1000
				: currentToken?.expiresAt || Date.now() + DEFAULT_TOKEN_TTL_MS,
		tokenType: data.token_type || currentToken?.tokenType || "Bearer",
		scope: data.scope || currentToken?.scope,
	};
}
