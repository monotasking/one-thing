/**
 * `createGeminiAgentProvider` —— gemini(`generateContent`)这条线的**构造门面**。
 *
 * P1-b(设计稿 `docs/design/provider-oop-2026-08.md` §9)之后,这个文件不再
 * 持有任何线协议逻辑:请求体构造、流解析、消息序列化、usage、错误、思考旋钮
 * 全部搬到 `wires/gemini-wire.ts` + `wires/gemini-messages.ts` +
 * `wires/gemini-errors.ts` + `thinking/gemini-thinking.ts` 上,方言配方在
 * `dialects/gemini.ts`(公共构件 `dialects/gemini-recipe.ts`)。
 *
 * 保留这个门面(而不是让调用方直接 `new GeminiWire`)有两个理由:
 *  - 导出名与 `GeminiAgentProviderOptions` 是 `@onething/runtime` 的公开面,
 *    backend 的 `wiring/agent-loop/providers/gemini.ts` 与几个测试都读它;
 *  - 它把「一堆 options」翻成「一份配方 + 一套凭据」,这一步是这条线上唯一
 *    还需要代码的地方。
 */
import type { AgentProvider } from "@onething/core/agent-loop";
import {
	GEMINI_DEFAULT_BASE_URL,
	createGeminiProvider,
	geminiAuth,
	geminiDialect,
} from "./dialects/gemini-recipe.js";
import type { ProviderMediaReader } from "./base/index.js";
import type { AgentProviderRequestDumper } from "./request-dump.js";

type FetchFn = typeof globalThis.fetch;

export interface GeminiAgentProviderOptions {
	apiKey?: string;
	baseUrl?: string;
	fetchImpl?: FetchFn;
	requestDumper?: AgentProviderRequestDumper;
	/**
	 * 只读媒体端口(P4-2)—— 多轮改图从这里取回历史生成图的字节。装配层
	 * (`packages/backend/wiring/agent-loop/providers/gemini.ts`)注入实现;
	 * 不给 = 不回放。
	 */
	media?: ProviderMediaReader;
}

export function createGeminiAgentProvider(
	options: GeminiAgentProviderOptions,
): AgentProvider {
	// 门面走 `geminiDialect()` 而不是 `defineGeminiDialect()`:每次构造一份
	// 即用即弃的配方,不往进程级注册表里再塞一个同名条目(注册表里该有的是
	// `dialects/gemini.ts` 那份**具名**配方)。
	const dialect = geminiDialect({
		id: "gemini",
		defaultBaseUrl: GEMINI_DEFAULT_BASE_URL,
		// 与 `dialects/gemini.ts` 那份具名配方保持同一份行为(P4-2)。
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
