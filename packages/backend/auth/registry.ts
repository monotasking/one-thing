/**
 * OAuth 登录定义注册表 —— **能力自述,别人读表**(服务商自述试点 P2 第 4 批)。
 *
 * 每家的定义住 `providers/vendors/<id>/oauth.ts`,经 `VendorRuntime.oauth` 登记;这里不点任何一家的名。
 * 表是**惰性**建的(第一次被问到时读名册):`vendors/runtimes.ts` 会拉起整个 agent-loop,模块加载期
 * 就读会在环上读到还没初始化完的名册 —— 与配额源注册表(`providers/quota/registry.ts`)同一个理由。
 *
 * 通用件(PKCE、token 归一)在叶子模块 `oauth-token.ts`,这里原样再导出,老的 import 路径不变。
 */
import { VENDOR_RUNTIMES } from "../provider/index.js";
import type { OnethingAuthProviderDefinition } from "./types.js";

export { generatePKCE, normalizeGenericOAuthToken } from "@onething/backend/network";

let authProviders: Map<string, OnethingAuthProviderDefinition> | undefined;

function authProviderTable(): Map<string, OnethingAuthProviderDefinition> {
	if (!authProviders) {
		authProviders = new Map();
		for (const vendor of VENDOR_RUNTIMES) {
			if (vendor.oauth) authProviders.set(vendor.oauth.providerId, vendor.oauth);
		}
	}
	return authProviders;
}

export function getAuthProviderDefinition(
	providerId: string,
): OnethingAuthProviderDefinition | undefined {
	return authProviderTable().get(providerId);
}

export function getAuthProviderDefinitions(): OnethingAuthProviderDefinition[] {
	return Array.from(authProviderTable().values());
}
