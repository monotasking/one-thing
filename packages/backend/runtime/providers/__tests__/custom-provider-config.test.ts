/**
 * 批 M §5.3:自定义服务商的三格(`dialect` / `headers` / `modelsUrl`)在工厂里真生效。
 *
 *  - 方言:配置点名的优先,其次 manifest 自述的(设置里那条自定义服务商映射来的);
 *  - Header:每个请求都带,值里的 `{{apiKey}}` 换成当前凭证;
 *  - 有自定义 `Authorization` 头时不再加默认 Bearer(不分大小写)。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentTurnRequest } from "@onething/backend/runtime/agent-loop/loop-primitives";
import {
	createAgentProviderFromRuntime,
	isAgentProviderRuntimeSupported,
	type AgentProviderRuntimeConfig,
} from "../factory.js";
import {
	isSubscriptionProvider,
	registerProviderManifest,
	type ProviderManifest,
} from "../manifest.js";
import { getOnethingModelsDevProviderId } from "../models-dev-catalog.js";
import { providerReadsModelsDevCatalog } from "../model-registry.js";
import { resolveOnethingProviderKind } from "../model-capability.js";
import type { AgentProviderRequestDumper } from "../request-dumper.js";
import { BearerApiKeyAuth, HeaderApiKeyAuth, expandHeaderTemplates } from "../base/index.js";
import { registerCustomProvidersForTest } from "./custom-manifest-fixture.js";
import { drain, sseResponse, USER_MESSAGE } from "./wire-snapshots/snapshot-harness.js";

const OPENAI_SSE = [
	'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}',
	"data: [DONE]",
	"",
].join("\n\n");

const ANTHROPIC_SSE = [
	'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":1,"output_tokens":0}}}',
	'event: message_stop\ndata: {"type":"message_stop"}',
	"",
].join("\n\n");

interface Capture {
	url: string;
	headers: Record<string, string>;
}

async function capture(
	providerId: string,
	config: AgentProviderRuntimeConfig,
	sse = OPENAI_SSE,
): Promise<Capture> {
	let url = "";
	let headers: Record<string, string> = {};
	const provider = createAgentProviderFromRuntime(providerId, config, {
		requestDumper: vi.fn(async () => undefined) as AgentProviderRequestDumper,
		fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
			url = String(input);
			headers = Object.fromEntries(new Headers(init?.headers).entries());
			return sseResponse(sse);
		}) as typeof globalThis.fetch,
	});
	const request: AgentTurnRequest = { turn: 1, model: "m-1", messages: [USER_MESSAGE] };
	await drain(provider!.streamTurn!(request));
	return { url, headers };
}

const undo: Array<() => void> = [];
afterEach(() => {
	while (undo.length) undo.pop()!();
});

describe("自定义服务商 · 方言", () => {
	it("manifest 自述的方言生效(anthropic 那一档,配置上不带 apiType 也认)", async () => {
		undo.push(registerCustomProvidersForTest([{ id: "custom-m-anthropic", apiType: "anthropic" }]));
		const got = await capture(
			"custom-m-anthropic",
			{ apiKey: "sk-1", baseUrl: "https://a.example/v1", model: "m-1" },
			ANTHROPIC_SSE,
		);
		expect(got.url).toBe("https://a.example/v1/messages");
		expect(got.headers["x-api-key"]).toBe("sk-1");
	});

	it("配置上的 dialect 盖过 manifest 的", async () => {
		undo.push(registerCustomProvidersForTest([{ id: "custom-m-override", apiType: "anthropic" }]));
		const got = await capture("custom-m-override", {
			apiKey: "sk-2",
			baseUrl: "https://o.example/v1",
			dialect: "openrouter",
			model: "m-1",
		});
		expect(got.url).toBe("https://o.example/v1/chat/completions");
		expect(got.headers.authorization).toBe("Bearer sk-2");
	});

	it("没登记的 id 不是自定义服务商:工厂不认", () => {
		expect(
			createAgentProviderFromRuntime("custom-never-registered", { apiKey: "k", model: "m-1" }),
		).toBeUndefined();
	});
});

describe("自定义服务商 · Header", () => {
	it("每个请求都带,{{apiKey}} 换成当前凭证", async () => {
		undo.push(registerCustomProvidersForTest(["custom-h-template"]));
		const got = await capture("custom-h-template", {
			apiKey: "sk-3",
			baseUrl: "https://h.example/v1",
			headers: { "X-Api-Token": "{{apiKey}}", "X-Tenant": "acme" },
			model: "m-1",
		});
		expect(got.headers["x-api-token"]).toBe("sk-3");
		expect(got.headers["x-tenant"]).toBe("acme");
		// 没写 Authorization:默认 Bearer 照旧。
		expect(got.headers.authorization).toBe("Bearer sk-3");
	});

	it("有自定义 Authorization 头(不分大小写)时不再加默认 Bearer", async () => {
		undo.push(registerCustomProvidersForTest(["custom-h-auth"]));
		const got = await capture("custom-h-auth", {
			apiKey: "sk-4",
			baseUrl: "https://h.example/v1",
			headers: { authorization: "Token {{apiKey}}" },
			model: "m-1",
		});
		expect(got.headers.authorization).toBe("Token sk-4");
	});

	it("anthropic 那一档:自定义头与 x-api-key 同名时让位", async () => {
		undo.push(registerCustomProvidersForTest([{ id: "custom-h-anthropic", apiType: "anthropic" }]));
		const got = await capture(
			"custom-h-anthropic",
			{
				apiKey: "sk-5",
				baseUrl: "https://a.example/v1",
				headers: { "X-API-Key": "relay-{{apiKey}}" },
				model: "m-1",
			},
			ANTHROPIC_SSE,
		);
		expect(got.headers["x-api-key"]).toBe("relay-sk-5");
	});
});

describe("认证策略的让位与模板(单元)", () => {
	it("expandHeaderTemplates:无凭证换成空串,空名字的行丢掉", () => {
		expect(expandHeaderTemplates({ A: "k={{apiKey}};{{apiKey}}", " ": "x" }, "s")).toEqual({ A: "k=s;s" });
		expect(expandHeaderTemplates({ A: "{{apiKey}}" }, undefined)).toEqual({ A: "" });
		expect(expandHeaderTemplates(undefined, "s")).toBeUndefined();
	});

	it("BearerApiKeyAuth / HeaderApiKeyAuth 在同名头面前让位", async () => {
		const bearer = await new BearerApiKeyAuth("k", { headers: { AUTHORIZATION: "Basic x" } }).headers();
		expect(bearer).not.toHaveProperty("Authorization");
		expect(bearer.AUTHORIZATION).toBe("Basic x");

		const header = await new HeaderApiKeyAuth("x-api-key", "k", { headers: { "X-Api-Key": "mine" } }).headers();
		expect(header).not.toHaveProperty("x-api-key");
		expect(header["X-Api-Key"]).toBe("mine");
	});
});

describe("陌生能力演练(批 M §5.6):加一家 Mistral = 一个 manifest 字面量", () => {
	it("只登记 manifest,工厂 / 目录键 / 计费 / 型号规则都读得到,别处零改", async () => {
		const mistral: ProviderManifest = {
			id: "mistral-drill",
			origin: "builtin",
			name: "Mistral",
			description: "providers.desc.mistral-drill",
			icon: "mistral",
			dialect: "custom-openai",
			auth: { kind: "apiKey" },
			models: { kind: "models.dev", key: "mistral" },
			billing: "api",
			modelRules: "openai",
			defaultBaseUrl: "https://api.mistral.ai/v1",
			supportsCustomBaseUrl: true,
			defaultModel: "mistral-large-latest",
		};
		undo.push(registerProviderManifest(mistral));

		expect(isAgentProviderRuntimeSupported("mistral-drill")).toBe(true);
		const got = await capture("mistral-drill", { apiKey: "sk-m", model: "m-1" });
		expect(got.url).toBe("https://api.mistral.ai/v1/chat/completions");
		expect(got.headers.authorization).toBe("Bearer sk-m");

		expect(getOnethingModelsDevProviderId("mistral-drill")).toBe("mistral");
		expect(providerReadsModelsDevCatalog("mistral-drill")).toBe(true);
		expect(isSubscriptionProvider("mistral-drill")).toBe(false);
		expect(resolveOnethingProviderKind("mistral-drill")).toBe("openai");
	});
});
