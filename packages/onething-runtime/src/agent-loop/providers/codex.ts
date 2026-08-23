/**
 * `createCodexAgentProvider` —— codex(OpenAI Responses)这条线的**构造门面**。
 *
 * P1-c(设计稿 `docs/design/provider-oop-2026-08.md` §9)之后,这个文件不再
 * 持有任何线协议逻辑:请求体构造、流解析、消息序列化、usage、错误、认证、
 * 思考旋钮全部搬到 `wires/openai-responses-wire.ts` +
 * `wires/openai-responses-messages.ts` + `wires/openai-responses-errors.ts` +
 * `thinking/responses-reasoning.ts` 上,方言配方在 `dialects/codex.ts`
 * (公共构件 `dialects/responses-recipe.ts`)。
 *
 * 保留这个门面(而不是让调用方直接 `new OpenAIResponsesWire`)有两个理由:
 *  - 导出名与 `CodexAgentProviderOptions` 是 `@onething/runtime` 的公开面,
 *    backend 的 `wiring/agent-loop/providers/codex.ts`(OAuth 类型桥接)与
 *    一批测试都读它;
 *  - **构造即校验**:一个 access token 都拿不到时当场抛「没登录」,而不是拖到
 *    第一回合才炸 —— 这是今天的行为,原样保留。
 */
import type { AgentProvider } from "@onething/core/agent-loop";
import {
	CODEX_BASE_URL,
	CODEX_DIALECT_SPEC,
	CODEX_NOT_LOGGED_IN,
	CODEX_PROVIDER_ID,
	codexAuth,
	createResponsesProvider,
	resolveCodexToken,
	responsesDialect,
	type CodexAuthOptions,
} from "./dialects/responses-recipe.js";
import type { AgentProviderRequestDump, AgentProviderRequestDumper } from "./request-dump.js";

type FetchFn = typeof globalThis.fetch;

export {
	CODEX_BASE_URL,
	CODEX_CLIENT_VERSION,
	CODEX_FALLBACK_INSTRUCTIONS,
	CODEX_PROVIDER_ID,
} from "./dialects/responses-recipe.js";
export type {
	OAuthToken,
	ProviderAuthContext,
} from "./dialects/responses-recipe.js";
export { toCodexToolChoice } from "./wires/openai-responses-messages.js";

/** @deprecated Use `AgentProviderRequestDump` from ./request-dump.js. */
export type CodexAgentProviderRequestDump = AgentProviderRequestDump & {
	mode: "codex-http";
};

export interface CodexAgentProviderOptions extends CodexAuthOptions {
	baseUrl?: string;
	fetchImpl?: FetchFn;
	requestDumper?: AgentProviderRequestDumper;
}

export function createCodexAgentProvider(
	options: CodexAgentProviderOptions,
): AgentProvider {
	const initialToken = resolveCodexToken(options);
	if (!initialToken?.accessToken) throw new Error(CODEX_NOT_LOGGED_IN);

	// 门面走 `responsesDialect()` 而不是 `defineResponsesDialect()`:每次构造
	// 一份即用即弃的配方,不往进程级注册表里再塞一个同名条目(注册表里该有的
	// 是 `dialects/codex.ts` 那份**具名**配方)。**配方主体是同一个常量** ——
	// P4-4 把 codex 的怪癖从「配方默认值」改成「配方字段」之后,这里不明说
	// 就会丢掉 `store:false` 与 image_generation 原生工具。
	const dialect = responsesDialect({
		id: CODEX_PROVIDER_ID,
		...CODEX_DIALECT_SPEC,
	});
	return createResponsesProvider(dialect, {
		providerId: CODEX_PROVIDER_ID,
		...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
		auth: codexAuth({
			...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
			...(options.oauthToken ? { oauthToken: options.oauthToken } : {}),
			...(options.authContext ? { authContext: options.authContext } : {}),
			...(options.refreshOAuthToken
				? { refreshOAuthToken: options.refreshOAuthToken }
				: {}),
		}),
		...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
		...(options.requestDumper ? { requestDumper: options.requestDumper } : {}),
	});
}
