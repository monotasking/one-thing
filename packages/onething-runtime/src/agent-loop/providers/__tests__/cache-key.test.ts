/**
 * `prompt_cache_key` 透传(P0b-B 泳道甲 #4,设计稿 §5.1 / §8)。
 *
 * `AgentTurnRequest.cacheKey` 是**宿主给的会话级不透明键** —— 它是标识符不是
 * 内容,但它确实会离开本机,所以「谁发」是逐家点名的:认这个字段的五家
 * (openai / kimi / kimi-code / grok / grok-oauth / openrouter)在配方上挂
 * `extraBody: promptCacheKeyExtraBody`,其余家一个字节都不多发。
 *
 * 判据一律是**线上那份 body**(`fetchImpl` 收到的 `init.body`),不是 dump。
 */
import { describe, expect, it, vi } from "vitest";
import type { AgentTurnRequest } from "@onething/core/agent-loop";
import {
	createAgentProviderFromRuntime,
	type AgentProviderRuntimeConfig,
} from "../factory.js";
import type { AgentProviderRequestDumper } from "../request-dump.js";
import { drain, sseResponse, SYSTEM_MESSAGE, USER_MESSAGE } from "./wire-snapshots/snapshot-harness.js";

const CACHE_KEY = "session-2f9c-cache-key";

const SSE = [
	'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}',
	"data: [DONE]",
	"",
].join("\n\n");

/** 各家构造所需的最小 config —— 与快照套件同源,OAuth 家族凭证挂 authContext。 */
const CONFIGS: Record<string, { model: string; config: AgentProviderRuntimeConfig }> = {
	openai: { model: "gpt-5.5", config: { apiKey: "sk-openai" } },
	kimi: {
		model: "kimi-k2.6",
		config: {
			apiKey: "sk-kimi",
			providerOptions: { kimiApiMode: "standard", kimiRegion: "cn" },
		},
	},
	"kimi-code": {
		model: "kimi-k2.6",
		config: {
			authContext: { kind: "oauth", token: { accessToken: "kimi-code-token" } },
		},
	},
	grok: { model: "grok-4.6", config: { apiKey: "sk-grok" } },
	"grok-oauth": {
		model: "grok-4.6",
		config: {
			authContext: { kind: "oauth", token: { accessToken: "grok-oauth-token" } },
		},
	},
	openrouter: { model: "openai/gpt-5.5", config: { apiKey: "sk-openrouter" } },
	deepseek: { model: "deepseek-v4-flash", config: { apiKey: "sk-deepseek" } },
	zhipu: {
		model: "glm-5",
		config: { apiKey: "sk-zhipu", providerOptions: { zhipuApiMode: "standard" } },
	},
	qwen: {
		model: "qwen3.8-max",
		config: {
			apiKey: "sk-qwen",
			providerOptions: { qwenApiMode: "standard", qwenRegion: "cn" },
		},
	},
};

/** 认 `prompt_cache_key` 的家 —— 与配方上挂 `extraBody` 的那一批一一对应。 */
const SENDS_CACHE_KEY = [
	"openai",
	"kimi",
	"kimi-code",
	"grok",
	"grok-oauth",
	"openrouter",
] as const;

/** 同一条线上不认这个字段的家。 */
const IGNORES_CACHE_KEY = ["deepseek", "zhipu", "qwen"] as const;

async function wireBody(
	providerId: keyof typeof CONFIGS,
	request: Partial<AgentTurnRequest>,
): Promise<Record<string, unknown>> {
	const { model, config } = CONFIGS[providerId]!;
	let body: Record<string, unknown> = {};
	const provider = createAgentProviderFromRuntime(
		providerId,
		{ ...config, model },
		{
			requestDumper: vi.fn(async () => undefined) as AgentProviderRequestDumper,
			fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
				body = JSON.parse(String(init?.body ?? "null"));
				return sseResponse(SSE);
			}) as typeof globalThis.fetch,
		},
	);
	await drain(
		provider!.streamTurn!({
			turn: 1,
			model,
			messages: [SYSTEM_MESSAGE, USER_MESSAGE],
			...request,
		}),
	);
	return body;
}

describe("prompt_cache_key —— 逐家点名的透传", () => {
	for (const providerId of SENDS_CACHE_KEY) {
		it(`${providerId}:带 cacheKey 就发 prompt_cache_key`, async () => {
			const body = await wireBody(providerId, { cacheKey: CACHE_KEY });
			expect(body.prompt_cache_key).toBe(CACHE_KEY);
		});
	}

	for (const providerId of IGNORES_CACHE_KEY) {
		it(`${providerId}:带 cacheKey 也不发`, async () => {
			const body = await wireBody(providerId, { cacheKey: CACHE_KEY });
			expect(body).not.toHaveProperty("prompt_cache_key");
		});
	}

	it("不带 cacheKey 时,认这个字段的家也一个字节都不多发", async () => {
		for (const providerId of SENDS_CACHE_KEY) {
			const body = await wireBody(providerId, {});
			expect(body, providerId).not.toHaveProperty("prompt_cache_key");
		}
	});

	it("空串当作没给 —— 不发一个空的路由键", async () => {
		const body = await wireBody("openai", { cacheKey: "" });
		expect(body).not.toHaveProperty("prompt_cache_key");
	});
});
