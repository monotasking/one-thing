/**
 * Kimi Code(编程套餐)的 OAuth 登录定义(经 `runtime.ts` 的 `oauth` 一格登记,`auth/auth-registry.ts` 惰性读名册建表)。
 *
 * 服务商自述试点 P2 第 4 批从 `auth/auth-registry.ts` 的手列五份配置里搬回家,逐字。
 * 授权服务器的 host 解析(`resolveKimiOAuthHost`,跟随官方 CLI 的两个环境变量)一起搬来。
 */
import { normalizeGenericOAuthToken } from "@onething/backend/network";
import type { OnethingAuthProviderDefinition } from "../../../auth/auth-types.js";

/** Kimi Code 授权服务器。两个环境变量与官方 CLI 同名,自建/灰度环境靠它切。 */
export const ONETHING_KIMI_CODE_DEFAULT_OAUTH_HOST = "https://auth.kimi.com";

export function resolveKimiOAuthHost(
	env: Record<string, string | undefined> = process.env,
): string {
	const host =
		env.KIMI_CODE_OAUTH_HOST ||
		env.KIMI_OAUTH_HOST ||
		ONETHING_KIMI_CODE_DEFAULT_OAUTH_HOST;
	return host.replace(/\/+$/, "");
}

/**
 * Kimi Code(编程套餐)—— OAuth 2.0 Device Authorization Grant(RFC 8628)。
 *
 * 三件事值得写在这儿,因为它们都是**实测**来的,不是抄文档:
 *
 * 1. **这是个公开 client**(`client_id` 无 secret),端点与参数取自开源的官方 CLI
 *    (MoonshotAI/kimi-cli,`src/kimi_cli/auth/oauth.py` + `klips/klip-14`)。
 *    与 Claude Code / Codex / Copilot 那三条同一性质:用厂商自己公开的 public
 *    client 走标准流程。
 * 2. **不需要伪装身份**。官方 CLI 会带一组 `X-Msh-*`(platform=kimi_cli、设备名、
 *    设备号…)。实测 device_authorization 不带这些头一样 200,带我们自己的
 *    platform 值也一样 200 —— 所以这里一个都不发。Kimi 的条款里写明「篡改客户端
 *    标识视为违规,可能暂停会员权益」,而"发得通"从来不是"可以发"的理由。
 * 3. **不带 scope**:官方实现只发 client_id,服务端也不要 scope。
 *
 * 换来的 `access_token` 就是打到 `https://api.kimi.com/coding/v1` 的那把 Bearer
 * key —— 与手贴 API Key 走的是同一个面(klip-14:「OAuth 模型和 API 兼容性与当前
 * Bearer key 完全一致」),所以下游一个字节都不用改。
 */
export const KIMI_CODE_CONFIG: OnethingAuthProviderDefinition = {
	providerId: "kimi-code",
	name: "Kimi Code",
	flowKind: "device-code",
	oauthFlow: "device",
	clientId: "17e5f671-d194-4dfb-9706-5516cb48c098",
	// host 可被官方 CLI 的两个环境变量覆盖(自建/灰度环境),这里跟随同一对名字。
	tokenUrl: `${resolveKimiOAuthHost()}/api/oauth/token`,
	deviceCodeUrl: `${resolveKimiOAuthHost()}/api/oauth/device_authorization`,
	scopes: [],
	tokenBodyFormat: "form",
	refreshBodyFormat: "form",
	refreshParams: (refreshToken) => ({
		client_id: KIMI_CODE_CONFIG.clientId,
		grant_type: "refresh_token",
		refresh_token: refreshToken,
	}),
	normalizeToken: normalizeGenericOAuthToken,
	statusMessage: "Connected with Kimi Code subscription",
};
