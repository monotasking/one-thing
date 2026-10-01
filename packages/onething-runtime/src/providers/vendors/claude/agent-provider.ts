/**
 * `createClaudeAgentProvider` —— anthropic-messages 这条线的**构造门面**。
 *
 * P1-a(设计稿 `docs/design/provider-oop-2026-08.md` §9)之后,这个文件不再
 * 持有任何线协议逻辑:请求体构造、流解析、消息序列化、usage、错误、缓存断点
 * 全部搬到 `wires/anthropic-messages-wire.ts` + `wires/anthropic-messages.ts`
 * + `wires/anthropic-errors.ts` + `thinking/anthropic-*.ts` 上,方言配方在
 * `vendors/{claude,claude-code}/dialect.ts` 与 `dialects/custom-anthropic.ts`。
 *
 * 服务商自述试点 P2 第 2 批从 `agent-loop/providers/claude.ts` 搬回家。**生产路不走这里**
 * (运行时工厂是同目录 `runtime.ts`;backend 那层只加了缺省 fetch 的包装零调用者,已删);
 * 今天它的调用方是十来个测试 —— 拿它当「一份即用即弃的 anthropic 配方 + 一套凭据」的构造捷径。
 */
import type {
	AgentModelCapabilities,
	AgentProvider,
} from "@onething/core/agent-loop";
import {
	ANTHROPIC_DEFAULT_BASE_URL,
	ANTHROPIC_TRANSPORT_CAPABILITIES,
	anthropicAuth,
	anthropicDialect,
	createAnthropicProvider,
} from "../../../agent-loop/providers/dialects/anthropic-recipe.js";
import type { AgentProviderRequestDumper } from "../../../agent-loop/providers/request-dump.js";

type FetchFn = typeof globalThis.fetch;

export interface ClaudeAgentProviderOptions {
	providerId?: string;
	apiKey?: string;
	baseUrl?: string;
	capabilities?: AgentModelCapabilities;
	fetchImpl?: FetchFn;
	headers?: Record<string, string>;
	omitApiKeyHeader?: boolean;
	systemHeader?: string;
	/**
	 * Set explicit prompt-cache breakpoints (cache_control: ephemeral) on the
	 * system prompt and the conversation tail. Opt-in: enabled for the official
	 * Anthropic endpoints; left off for third-party anthropic-compatible
	 * endpoints that may reject the field.
	 */
	promptCaching?: boolean;
	requestDumper?: AgentProviderRequestDumper;
}

export function createClaudeAgentProvider(
	options: ClaudeAgentProviderOptions,
): AgentProvider {
	const providerId = options.providerId ?? "claude";
	// 门面走 `anthropicDialect()` 而不是 `defineAnthropicDialect()`:每次构造
	// 一份即用即弃的配方,不往进程级注册表里塞一个以 providerId 命名的条目
	// (注册表里该有的是三份**具名**配方:`vendors/{claude,claude-code}/dialect.ts` 与
	// `dialects/custom-anthropic.ts`)。
	const dialect = anthropicDialect({
		id: providerId,
		defaultBaseUrl: ANTHROPIC_DEFAULT_BASE_URL,
		...(options.promptCaching ? { promptCaching: true } : {}),
		...(options.systemHeader ? { systemHeader: options.systemHeader } : {}),
		transport: options.capabilities ?? ANTHROPIC_TRANSPORT_CAPABILITIES,
	});
	return createAnthropicProvider(dialect, {
		providerId,
		...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
		auth: anthropicAuth({
			...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
			...(options.omitApiKeyHeader ? { omitApiKeyHeader: true } : {}),
			...(options.headers ? { headers: options.headers } : {}),
		}),
		...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
		...(options.requestDumper ? { requestDumper: options.requestDumper } : {}),
	});
}
