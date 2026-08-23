/**
 * DeepSeek 的**构造门面**。
 *
 * 线协议是 openai-chat(`wires/openai-chat-wire.ts`),DeepSeek 的全部特殊之处
 * 都在 `dialects/deepseek.ts` 那份配方里:纯文本 user 内容、无条件回传
 * `reasoning_content`、`prompt_cache_hit_tokens` 的 usage、按**推断后**的思考
 * 状态判 temperature、`DeepSeek` 大写的错误文案。
 *
 * 这个文件从 507 行缩到这里,是因为那 507 行里有 490 行与
 * `openai-compatible.ts` 逐字同源(设计稿 §1:去重后可删 ≈1550 行)。
 */
import type { AgentProvider } from "@onething/core/agent-loop";
import { BearerApiKeyAuth } from "./base/index.js";
import { DEEPSEEK_DIALECT, createOpenAIChatProvider } from "./dialects/index.js";
import type { AgentProviderRequestDumper } from "./request-dump.js";

type FetchFn = typeof globalThis.fetch;

export type {
	AgentProviderRequestDump,
	AgentProviderRequestDumper,
	AgentProviderRequestDumpValue,
} from "./request-dump.js";

/**
 * DeepSeek 的 reasoner 类模型默认思考,其余不。调用方什么都不说 = 「这个模型
 * 平时怎样就怎样」,而只有这条线知道每个模型平时怎样 —— 判据本体住在
 * `thinking/deepseek-inferred.ts`,这里只是老出口。
 */
export { isDeepSeekThinkingModel } from "./thinking/index.js";

export interface DeepSeekAgentProviderOptions {
	apiKey: string;
	baseUrl?: string;
	fetchImpl?: FetchFn;
	capabilities?: AgentProvider["capabilities"];
	requestDumper?: AgentProviderRequestDumper;
}

export function createDeepSeekAgentProvider(
	options: DeepSeekAgentProviderOptions,
): AgentProvider {
	return createOpenAIChatProvider(DEEPSEEK_DIALECT, {
		...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
		auth: new BearerApiKeyAuth(options.apiKey),
		...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
		...(options.requestDumper ? { requestDumper: options.requestDumper } : {}),
		// 运行时传进来的能力声明覆盖配方的默认档(factory 会把账本的
		// per-model 覆盖再盖一层)。
		...(options.capabilities ? { transport: options.capabilities } : {}),
	});
}
