/**
 * `createGeminiAgentProvider` —— gemini(`generateContent`)这条线的**构造门面**。
 *
 * P1-b(设计稿 `docs/design/provider-oop-2026-08.md` §9)之后,这个文件不再
 * 持有任何线协议逻辑:请求体构造、流解析、消息序列化、usage、错误、思考旋钮
 * 全部搬到 `wires/provider-gemini-wire.ts` + `wires/provider-wires-gemini-messages.ts` +
 * `wires/provider-wires-gemini-errors.ts` + `thinking/provider-thinking-gemini.ts` 上,方言配方在
 * 同目录 `dialect.ts`(公共构件 `providers/dialects/gemini-recipe.ts`)。
 *
 * 服务商自述试点 P2 第 2 批从 `agent-loop/providers/gemini.ts` 搬回家。**生产路不走这里**
 * (运行时工厂是同目录 `runtime.ts`;backend 那层只加了缺省 fetch / 媒体端口的包装零调用者,
 * 已删);今天它的调用方是几个测试 —— 拿它当构造捷径。
 */
import type { AgentProvider } from "@onething/backend/agent-loop/agent-loop-primitives";
import {
	GEMINI_DEFAULT_BASE_URL,
	createGeminiProvider,
	geminiAuth,
	geminiDialect,
} from "../../dialects/provider-dialects-gemini-recipe.js";
import type { ProviderMediaReader } from "../../base/provider-base.js";
import type { AgentProviderRequestDumper } from "../../provider-request-dumper.js";

type FetchFn = typeof globalThis.fetch;

export interface GeminiAgentProviderOptions {
	apiKey?: string;
	baseUrl?: string;
	fetchImpl?: FetchFn;
	requestDumper?: AgentProviderRequestDumper;
	/**
	 * 只读媒体端口(P4-2)—— 多轮改图从这里取回历史生成图的字节。生产路上由运行时
	 * 工厂从 `CreateAgentProviderFromRuntimeOptions.media` 透传(装配层注入实现);
	 * 不给 = 不回放。
	 */
	media?: ProviderMediaReader;
}

export function createGeminiAgentProvider(
	options: GeminiAgentProviderOptions,
): AgentProvider {
	// 门面走 `geminiDialect()` 而不是 `defineGeminiDialect()`:每次构造一份
	// 即用即弃的配方,不往进程级注册表里再塞一个同名条目(注册表里该有的是
	// 同目录 `dialect.ts` 那份**具名**配方)。
	const dialect = geminiDialect({
		id: "gemini",
		defaultBaseUrl: GEMINI_DEFAULT_BASE_URL,
		// 与同目录 `dialect.ts` 那份具名配方保持同一份行为(P4-2)。
		replayGeneratedImages: true,
	});
	return createGeminiProvider(dialect, {
		providerId: "gemini",
		...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
		auth: geminiAuth({
			...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
		}),
		...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
		...(options.requestDumper ? { requestDumper: options.requestDumper } : {}),
		...(options.media ? { media: options.media } : {}),
	});
}
