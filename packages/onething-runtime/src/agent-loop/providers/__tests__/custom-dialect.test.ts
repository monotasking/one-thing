/**
 * `custom-*` 可选方言(P2-a 第 3 项)。
 *
 * 自建端点今天只有两份通用配方(`custom-openai` / `custom-anthropic`),于是
 * 一个跑在自己网关后面的 OpenRouter 只能拿到通用的线型与 usage 表 —— 请求体
 * 里没有 `reasoning{}`,回来的 `cost` 没人读。`config.dialect` 让它直接点名
 * 一份**已登记**的配方:线材(线型 / usage 表 / `maxTokensField` / 端点形状 /
 * 传输声明)全取那一家的,地址与凭据取自己的。
 *
 * 判据不是「长得像」,是**逐字节等于**那一家自己发的请求 —— 用同一份请求跑
 * 真 `openrouter` 与 `custom-*` + `dialect:'openrouter'`,两份 body 深比对。
 *
 * 不认识的方言 id 是**明确错误**:静默退回 `custom-openai` 会让请求体悄悄
 * 变成另一家的形状,而用户以为自己选了 OpenRouter。
 */
import { describe, expect, it, vi } from "vitest";
import type { AgentTurnRequest } from "@onething/core/agent-loop";
import {
	createAgentProviderFromRuntime,
	type AgentProviderRuntimeConfig,
} from "../factory.js";
import type { AgentProviderRequestDumper } from "../request-dump.js";
import { drain, sseResponse, SYSTEM_MESSAGE, TOOLS, USER_MESSAGE } from "./wire-snapshots/snapshot-harness.js";

const MODEL = "anthropic/claude-sonnet-5";

const REQUEST: AgentTurnRequest = {
	turn: 1,
	model: MODEL,
	messages: [SYSTEM_MESSAGE, USER_MESSAGE],
	tools: TOOLS,
	toolChoice: "auto",
	thinking: "enabled",
	reasoningEffort: "high",
	temperature: 0.7,
};

const SSE = [
	'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}',
	'data: {"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120,"cost":0.004,"prompt_tokens_details":{"cached_tokens":40}}}',
	"data: [DONE]",
	"",
].join("\n\n");

interface Capture {
	url: string;
	body: Record<string, unknown>;
	events: unknown[];
}

async function capture(
	providerId: string,
	config: AgentProviderRuntimeConfig,
): Promise<Capture> {
	let url = "";
	let body: Record<string, unknown> = {};
	const provider = createAgentProviderFromRuntime(providerId, config, {
		requestDumper: vi.fn(async () => undefined) as AgentProviderRequestDumper,
		fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
			url = String(input);
			body = JSON.parse(String(init?.body ?? "null"));
			return sseResponse(SSE);
		}) as typeof globalThis.fetch,
	});
	const events = await drain(provider!.streamTurn!(REQUEST));
	return { url, body, events };
}

describe("custom-* 点名方言", () => {
	it("请求体与 openrouter 配方逐字节相同,地址取自己的", async () => {
		const native = await capture("openrouter", { apiKey: "sk-native", model: MODEL });
		const custom = await capture("custom-acme-router", {
			apiKey: "sk-custom",
			baseUrl: "https://router.acme.test/v1",
			dialect: "openrouter",
			model: MODEL,
		});

		// 线型(openrouter 的 `reasoning{}`)、`maxTokensField`、tool_choice 拼法、
		// 消息序列化 —— 全在这一句里。
		expect(custom.body).toEqual(native.body);
		expect(custom.body.reasoning).toEqual(native.body.reasoning);
		expect(custom.body.reasoning).toBeDefined();

		// 地址是自己的,路径是 openrouter 配方的 `/chat/completions`。
		expect(native.url).toBe("https://openrouter.ai/api/v1/chat/completions");
		expect(custom.url).toBe("https://router.acme.test/v1/chat/completions");
	});

	it("usage 走 openrouter 那张表(顶层 cost + prompt_tokens_details)", async () => {
		const native = await capture("openrouter", { apiKey: "sk-native", model: MODEL });
		const custom = await capture("custom-acme-router", {
			apiKey: "sk-custom",
			baseUrl: "https://router.acme.test/v1",
			dialect: "openrouter",
			model: MODEL,
		});

		expect(custom.events).toEqual(native.events);
		// prompt 100 − cached 40 = 60 uncached;input = uncached + read = 100。
		expect(custom.events.at(-1)).toMatchObject({
			type: "finish",
			usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40 },
		});
	});

	it("不给 dialect 就还是今天的 custom-openai(默认地址 + openai-effort)", async () => {
		const custom = await capture("custom-acme-plain", {
			apiKey: "sk-custom",
			baseUrl: "https://plain.acme.test/v1",
			model: MODEL,
		});
		expect(custom.url).toBe("https://plain.acme.test/v1/chat/completions");
		expect(custom.body.reasoning).toBeUndefined();
		expect(custom.body.reasoning_effort).toBe("high");
	});

	it("认不出的方言 id 是明确错误,不静默回退", () => {
		expect(() =>
			createAgentProviderFromRuntime("custom-acme-nope", {
				apiKey: "k",
				dialect: "not-a-dialect",
			}),
		).toThrow(/Unknown provider dialect: not-a-dialect/);
	});

	it("点名 anthropic 那条也走得通(一份配方服务任意 custom id)", async () => {
		const custom = await capture("custom-acme-anthropic-named", {
			apiKey: "sk-custom",
			baseUrl: "https://anthropic.acme.test/v1",
			dialect: "claude",
			model: "claude-sonnet-5",
		});
		expect(custom.url).toBe("https://anthropic.acme.test/v1/messages");
		// Anthropic 线协议的形状,不是 chat/completions 的:system 独立成字段、
		// 工具用 `input_schema`、线型是账本给 claude-sonnet-5 的 `anthropic-adaptive`。
		expect(custom.body.system).toBeDefined();
		expect((custom.body.tools as Array<Record<string, unknown>>)[0]).toHaveProperty(
			"input_schema",
		);
		expect(custom.body.thinking).toEqual({ type: "adaptive" });
	});
});
