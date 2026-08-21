import { describe, expect, it } from "vitest";
import {
	createAgentProviderFromRuntime,
	getSupportedAgentProviderRuntimeIds,
	isAgentProviderRuntimeSupported,
	registerAgentProviderRuntime,
} from "../providers/factory.js";
import { builtinProviders } from "../../providers/builtin/index.js";
import type { AgentTurnStreamEvent } from "@onething/core/agent-loop";
import { resolveAgentModelCapabilities } from "@onething/core/agent-loop";

describe("agent provider runtime factory", () => {
	const emptyFetch: typeof globalThis.fetch = async () => new Response("");

	it("requires every built-in provider to have an agent runtime route", () => {
		const missing = builtinProviders
			.map((provider) => provider.id)
			.filter((providerId) => !isAgentProviderRuntimeSupported(providerId));

		expect(missing).toEqual([]);
	});

	it("creates supported agent providers from runtime config", () => {
		const deepseek = createAgentProviderFromRuntime(
			"deepseek",
			{
				apiKey: "key",
				baseUrl: "https://example.test",
			},
			{
				fetchImpl: emptyFetch,
			},
		);
		const acp = createAgentProviderFromRuntime(
			"acp",
			{},
			{
				workingDirectory: "/tmp/work",
				localSessionId: "session-1",
			},
		);
		const codex = createAgentProviderFromRuntime(
			"codex",
			{
				apiKey: "access-token",
				baseUrl: "https://chatgpt.test/backend-api/codex",
			},
			{
				fetchImpl: emptyFetch,
			},
		);
		const openai = createAgentProviderFromRuntime(
			"openai",
			{
				apiKey: "key",
				baseUrl: "https://openai.test/v1",
			},
			{
				fetchImpl: emptyFetch,
			},
		);
		const kimi = createAgentProviderFromRuntime(
			"kimi",
			{
				apiKey: "key",
				baseUrl: "https://kimi.test/v1",
			},
			{
				fetchImpl: emptyFetch,
			},
		);
		const claude = createAgentProviderFromRuntime(
			"claude",
			{
				apiKey: "key",
				baseUrl: "https://anthropic.test/v1",
			},
			{
				fetchImpl: emptyFetch,
			},
		);
		const gemini = createAgentProviderFromRuntime(
			"gemini",
			{
				apiKey: "key",
				baseUrl: "https://gemini.test/v1beta",
			},
			{
				fetchImpl: emptyFetch,
			},
		);
		const githubCopilot = createAgentProviderFromRuntime(
			"github-copilot",
			{
				apiKey: "github-token",
				baseUrl: "https://copilot.test",
			},
			{
				fetchImpl: emptyFetch,
			},
		);
		const claudeCode = createAgentProviderFromRuntime(
			"claude-code",
			{
				apiKey: "claude-oauth-token",
				baseUrl: "https://claude-code.test/v1",
			},
			{
				fetchImpl: emptyFetch,
			},
		);

		expect(isAgentProviderRuntimeSupported("deepseek")).toBe(true);
		expect(isAgentProviderRuntimeSupported("acp")).toBe(true);
		expect(isAgentProviderRuntimeSupported("codex")).toBe(true);
		expect(isAgentProviderRuntimeSupported("openai")).toBe(true);
		expect(isAgentProviderRuntimeSupported("kimi")).toBe(true);
		expect(isAgentProviderRuntimeSupported("zhipu")).toBe(true);
		expect(isAgentProviderRuntimeSupported("openrouter")).toBe(true);
		expect(isAgentProviderRuntimeSupported("claude")).toBe(true);
		expect(isAgentProviderRuntimeSupported("gemini")).toBe(true);
		expect(isAgentProviderRuntimeSupported("grok")).toBe(true);
		expect(isAgentProviderRuntimeSupported("grok-oauth")).toBe(true);
		expect(isAgentProviderRuntimeSupported("github-copilot")).toBe(true);
		expect(isAgentProviderRuntimeSupported("claude-code")).toBe(true);
		expect(getSupportedAgentProviderRuntimeIds()).toEqual(
			expect.arrayContaining([
				"deepseek",
				"codex",
				"openai",
				"openrouter",
				"kimi",
				"zhipu",
				"claude",
				"gemini",
				"grok",
				"grok-oauth",
				"github-copilot",
				"claude-code",
				"acp",
			]),
		);
		expect(deepseek?.id).toBe("deepseek");
		expect(codex?.id).toBe("codex");
		expect(openai?.id).toBe("openai");
		expect(kimi?.id).toBe("kimi");
		expect(claude?.id).toBe("claude");
		expect(gemini?.id).toBe("gemini");
		expect(githubCopilot?.id).toBe("github-copilot");
		expect(claudeCode?.id).toBe("claude-code");
		expect(acp?.id).toBe("acp");
	});

	it("passes DeepSeek model token limits from runtime metadata into provider capabilities", () => {
		const provider = createAgentProviderFromRuntime(
			"deepseek",
			{
				apiKey: "key",
				model: "deepseek-v4-pro",
				models: {
					"deepseek-v4-pro": {
						supportsTools: true,
						supportsReasoning: true,
						contextLength: 1_000_000,
						maxOutputTokens: 384_000,
					},
				},
			},
			{
				fetchImpl: emptyFetch,
			},
		);

		expect(provider?.capabilities?.maxInputTokens).toBe(1_000_000);
		expect(provider?.capabilities?.maxOutputTokens).toBe(384_000);
	});

	it("streams GitHub Copilot through the agent runtime with a exchanged Copilot token", async () => {
		const requests: Array<{
			url: string;
			authorization: string;
			integration: string;
		}> = [];
		const fetchImpl: typeof globalThis.fetch = async (input, init) => {
			const url = String(input);
			const headers = new Headers(init?.headers);
			requests.push({
				url,
				authorization:
					headers.get("authorization") ?? headers.get("Authorization") ?? "",
				integration: headers.get("Copilot-Integration-Id") ?? "",
			});

			if (url === "https://api.github.com/copilot_internal/v2/token") {
				return new Response(
					JSON.stringify({ token: "copilot-token", expires_in: 1800 }),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				);
			}

			return new Response(
				[
					'data: {"choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}',
					"",
					'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}',
					"",
					"data: [DONE]",
					"",
				].join("\n"),
				{
					status: 200,
					headers: { "content-type": "text/event-stream" },
				},
			);
		};

		const provider = createAgentProviderFromRuntime(
			"github-copilot",
			{
				apiKey: "github-token",
				baseUrl: "https://copilot.test",
				model: "gpt-4o",
			},
			{ fetchImpl },
		);

		if (!provider?.streamTurn)
			throw new Error(
				"GitHub Copilot runtime did not create a stream provider",
			);

		const events: AgentTurnStreamEvent[] = [];
		for await (const event of provider.streamTurn({
			model: "gpt-4o",
			messages: [{ role: "user", content: "hi" }],
			turn: 1,
		})) {
			events.push(event);
		}

		expect(requests).toMatchObject([
			{
				url: "https://api.github.com/copilot_internal/v2/token",
				authorization: "Bearer github-token",
			},
			{
				url: "https://copilot.test/chat/completions",
				authorization: "Bearer copilot-token",
				integration: "vscode-chat",
			},
		]);
		expect(events).toContainEqual({
			type: "text-delta",
			turn: 1,
			delta: "hello",
		});
		expect(events).toContainEqual({
			type: "finish",
			turn: 1,
			finishReason: "stop",
			usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
		});
	});

	it("streams Claude Code through the agent runtime with OAuth headers", async () => {
		let requestHeaders = new Headers();
		let requestBody = "";
		const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
			requestHeaders = new Headers(init?.headers);
			requestBody = typeof init?.body === "string" ? init.body : "";
			return new Response(
				[
					'data: {"type":"message_start","message":{"usage":{"input_tokens":3,"output_tokens":0}}}',
					"",
					'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}',
					"",
					'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
					"",
					"data: [DONE]",
					"",
				].join("\n"),
				{
					status: 200,
					headers: { "content-type": "text/event-stream" },
				},
			);
		};

		const provider = createAgentProviderFromRuntime(
			"claude-code",
			{
				apiKey: "claude-oauth-token",
				baseUrl: "https://claude-code.test/v1",
				model: "claude-sonnet-4",
			},
			{ fetchImpl },
		);

		if (!provider?.streamTurn)
			throw new Error("Claude Code runtime did not create a stream provider");

		const events: AgentTurnStreamEvent[] = [];
		for await (const event of provider.streamTurn({
			model: "claude-sonnet-4",
			messages: [
				{ role: "system", content: "Project instructions" },
				{ role: "user", content: "hi" },
			],
			turn: 1,
		})) {
			events.push(event);
		}

		const body = JSON.parse(requestBody) as {
			system?: Array<{ type: string; text: string }>;
		};
		expect(requestHeaders.get("authorization")).toBe(
			"Bearer claude-oauth-token",
		);
		expect(requestHeaders.get("x-api-key")).toBeNull();
		expect(requestHeaders.get("anthropic-beta")).toContain(
			"claude-code-20250219",
		);
		expect(body.system).toEqual([
			{
				type: "text",
				text: "You are Claude Code, Anthropic's official CLI for Claude.",
			},
			// claude-code enables prompt caching: breakpoint on the system tail.
			{
				type: "text",
				text: "Project instructions",
				cache_control: { type: "ephemeral" },
			},
		]);
		expect(events).toContainEqual({
			type: "text-delta",
			turn: 1,
			delta: "hello",
		});
		expect(events).toContainEqual({
			type: "finish",
			turn: 1,
			finishReason: "stop",
			usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
		});
	});

	it("creates custom OpenAI-compatible agent providers from runtime config", () => {
		const provider = createAgentProviderFromRuntime(
			"custom-local-openai",
			{
				apiKey: "key",
				baseUrl: "https://custom.test/v1",
				model: "custom-model",
				apiType: "openai",
				modelCapabilitiesByModel: {
					"custom-model": {
						tools: false,
						vision: false,
						reasoning: false,
					},
				},
			},
			{
				fetchImpl: emptyFetch,
			},
		);

		expect(isAgentProviderRuntimeSupported("custom-local-openai")).toBe(true);
		expect(provider?.id).toBe("custom-local-openai");
		const capabilities = provider?.capabilities;
		expect(capabilities).toBeDefined();
		expect(capabilities?.supportsTools).toBe(false);
		expect(capabilities?.supportsReasoning).toBe(false);
		expect(capabilities?.capabilities).not.toContain("vision-input");
	});

	it("creates custom Anthropic-compatible agent providers from runtime config", () => {
		const provider = createAgentProviderFromRuntime(
			"custom-local-anthropic",
			{
				apiKey: "key",
				baseUrl: "https://anthropic-compatible.test/v1",
				model: "claude-compatible",
				apiType: "anthropic",
				modelCapabilitiesByModel: {
					"claude-compatible": {
						tools: false,
						vision: false,
						reasoning: false,
					},
				},
			},
			{
				fetchImpl: emptyFetch,
			},
		);

		expect(isAgentProviderRuntimeSupported("custom-local-anthropic")).toBe(
			true,
		);
		expect(provider?.id).toBe("custom-local-anthropic");
		const capabilities = provider?.capabilities;
		expect(capabilities).toBeDefined();
		expect(capabilities?.supportsTools).toBe(false);
		expect(capabilities?.supportsReasoning).toBe(false);
		expect(capabilities?.capabilities).not.toContain("vision-input");
	});

	it("points the qwen runtime at the host its mode + region select", async () => {
		// The dials travel in the opaque providerOptions bag now, not as named
		// fields on the runtime config — see providers/provider-options.ts.
		async function requestedUrl(
			providerOptions: Record<string, unknown>,
		): Promise<string> {
			let url = "";
			const provider = createAgentProviderFromRuntime(
				"qwen",
				{ apiKey: "k", providerOptions },
				{
					fetchImpl: async (input) => {
						url = String(input);
						return new Response("", {
							status: 200,
							headers: { "content-type": "text/event-stream" },
						});
					},
				},
			);
			for await (const _ of provider!.streamTurn!({
				turn: 0,
				model: "qwen3.7-plus",
				messages: [{ role: "user", content: "hi" }],
			})) {
				// drain
			}
			return url;
		}

		expect(await requestedUrl({})).toBe(
			"https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
		);
		expect(await requestedUrl({ qwenRegion: "intl" })).toBe(
			"https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
		);
		// Token Plan is a different host, not just a different key.
		expect(await requestedUrl({ qwenApiMode: "token-plan" })).toBe(
			"https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
		);
		expect(
			await requestedUrl({ qwenApiMode: "token-plan", qwenRegion: "intl" }),
		).toBe(
			"https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
		);
		// Coding Plan hangs off a bare /v1, unlike every other qwen host.
		expect(await requestedUrl({ qwenApiMode: "coding-plan" })).toBe(
			"https://coding.dashscope.aliyuncs.com/v1/chat/completions",
		);
		expect(
			await requestedUrl({ qwenApiMode: "coding-plan", qwenRegion: "intl" }),
		).toBe("https://coding-intl.dashscope.aliyuncs.com/v1/chat/completions");
	});

	it("points the kimi runtime at the host its mode + region select", async () => {
		async function requestedUrl(
			providerOptions: Record<string, unknown>,
			baseUrl?: string,
		): Promise<string> {
			let url = "";
			const provider = createAgentProviderFromRuntime(
				"kimi",
				{ apiKey: "k", providerOptions, ...(baseUrl ? { baseUrl } : {}) },
				{
					fetchImpl: async (input) => {
						url = String(input);
						return new Response("", {
							status: 200,
							headers: { "content-type": "text/event-stream" },
						});
					},
				},
			);
			for await (const _ of provider!.streamTurn!({
				turn: 0,
				model: "kimi-k3",
				messages: [{ role: "user", content: "hi" }],
			})) {
				// drain
			}
			return url;
		}

		expect(await requestedUrl({})).toBe(
			"https://api.moonshot.cn/v1/chat/completions",
		);
		expect(await requestedUrl({ kimiRegion: "intl" })).toBe(
			"https://api.moonshot.ai/v1/chat/completions",
		);
		// 编程套餐是另一个 host(还带一段 /coding 路径),不只是另一把 key。
		expect(await requestedUrl({ kimiApiMode: "coding-plan" })).toBe(
			"https://api.kimi.com/coding/v1/chat/completions",
		);
		// 套餐不分区:海外也是同一个地址,不是漏了一格。
		expect(
			await requestedUrl({ kimiApiMode: "coding-plan", kimiRegion: "intl" }),
		).toBe("https://api.kimi.com/coding/v1/chat/completions");
		// 自己写的地址仍然赢过档位。
		expect(
			await requestedUrl({ kimiApiMode: "coding-plan" }, "https://kimi.test/v1"),
		).toBe("https://kimi.test/v1/chat/completions");
	});

	it("sends the OAuth access token as kimi-code's Bearer key", async () => {
		// OAuth 凭证在 authContext 里,config.apiKey 恒为空串 —— 曾经只读 apiKey,
		// 空 Bearer 打到套餐 host 直接 401(症状:「API Key 无效或未授权」)。
		let authHeader = "";
		const provider = createAgentProviderFromRuntime(
			"kimi-code",
			{
				apiKey: "",
				authContext: {
					kind: "oauth",
					token: { accessToken: "kimi-oauth-token", expiresAt: 0, tokenType: "Bearer" },
					account: {},
				},
			},
			{
				fetchImpl: async (_input, init) => {
					authHeader = new Headers(init?.headers).get("authorization") ?? "";
					return new Response("", {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					});
				},
			},
		);
		for await (const _ of provider!.streamTurn!({
			turn: 0,
			model: "k3",
			messages: [{ role: "user", content: "hi" }],
		})) {
			// drain
		}
		expect(authHeader).toBe("Bearer kimi-oauth-token");
	});

	it("rejects kimi-code without any credential instead of sending an empty key", () => {
		expect(() => createAgentProviderFromRuntime("kimi-code", { apiKey: "" })).toThrow(
			/not logged in/i,
		);
	});

	it("allows additional provider runtimes to register without changing the factory", () => {
		const unregister = registerAgentProviderRuntime(
			"plugin-agent",
			(config) => ({
				id: `plugin-agent:${config.model ?? "default"}`,
				capabilities: {
					capabilities: ["text-input", "text-output"],
					inputModalities: ["text"],
					outputModalities: ["text"],
				},
			}),
		);

		try {
			expect(isAgentProviderRuntimeSupported("plugin-agent")).toBe(true);
			expect(
				createAgentProviderFromRuntime("plugin-agent", { model: "m1" })?.id,
			).toBe("plugin-agent:m1");
			expect(() =>
				registerAgentProviderRuntime("plugin-agent", () => ({
					id: "duplicate",
				})),
			).toThrow("Agent provider runtime already registered: plugin-agent");
		} finally {
			unregister();
		}

		expect(isAgentProviderRuntimeSupported("plugin-agent")).toBe(false);
	});

	it("lets a provider keep its own capabilities out of the ledger overlay", async () => {
		// The ledger says this model has no tools. A provider whose capabilities
		// come from a live backend must not be overruled by that — the ledger has
		// never seen the model. Previously this was a hardcoded list of provider
		// ids inside the factory, so every new external agent had to be added to it.
		const selfDeclared = registerAgentProviderRuntime("self-declared-agent", () => ({
			id: "self-declared-agent",
			capabilitiesAreSelfDeclared: true,
			capabilities: {
				capabilities: ["text-input", "text-output", "tool-calls"],
				inputModalities: ["text"],
				outputModalities: ["text"],
				supportsTools: true,
			},
		}));
		const ledgerRuled = registerAgentProviderRuntime("ledger-ruled-agent", () => ({
			id: "ledger-ruled-agent",
			capabilities: {
				capabilities: ["text-input", "text-output", "tool-calls"],
				inputModalities: ["text"],
				outputModalities: ["text"],
				supportsTools: true,
			},
		}));

		try {
			const denyTools = {
				model: "m1",
				modelCapabilitiesByModel: { m1: { tools: false } },
			};

			// resolveAgentModelCapabilities is what real consumers call: it prefers
			// getModelCapabilities and falls back to the provider's own declaration.
			const kept = createAgentProviderFromRuntime("self-declared-agent", denyTools)!;
			expect((await resolveAgentModelCapabilities(kept, "m1")).supportsTools).toBe(true);

			const overruled = createAgentProviderFromRuntime("ledger-ruled-agent", denyTools)!;
			expect((await resolveAgentModelCapabilities(overruled, "m1")).supportsTools).toBe(false);
		} finally {
			selfDeclared();
			ledgerRuled();
		}
	});
});
