/**
 * 线协议快照门的**公共工具** —— 四个套件(openai-chat / anthropic-messages /
 * gemini / openai-responses)共用同一套取样与序列化规则。
 *
 * 规则本身写在各套件的文件头,这里只放实现。三条要点:
 *
 *  1. **请求体取的是 `fetchImpl` 真收到的 `init.body`**(线上字节),不是 dumper
 *     那一份 —— 落盘那份走 `RequestBodyBuilder.forDump()`(data URI 截断),是
 *     排障视图不是线上事实。dump 的其余字段(`providerId` / `model` / `mode` /
 *     `metadata`)照旧进快照,由同一份 fixture 一并守着。
 *  2. **序列化前对对象递归排序 key,数组顺序原样保留。** key 顺序对 HTTP API
 *     不是行为;数组顺序是(消息次序、内容块次序、工具表次序、流事件次序)。
 *  3. **一律走生产入口** `createAgentProviderFromRuntime` —— 覆盖层
 *     (`withPerModelCapabilities`)也在里面。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, vi } from "vitest";
import type {
	AgentMessage,
	AgentProvider,
	AgentTool,
	AgentTurnRequest,
	AgentTurnStreamEvent,
} from "@onething/core/agent-loop";
import {
	createAgentProviderFromRuntime,
	type AgentProviderRuntimeConfig,
	type CreateAgentProviderFromRuntimeOptions,
} from "../../factory.js";
import type {
	AgentProviderRequestDump,
	AgentProviderRequestDumper,
} from "../../request-dump.js";

/**
 * 错误用例把 `Date.now` 钉在这里(2023-11-14T22:13:20.000Z = 1700000000000),
 * 于是 `retryAfterAt` 这类「现在 + retry-after」的字段在快照里是确定值。
 */
export const FIXED_NOW = Date.UTC(2023, 10, 14, 22, 13, 20);

/**
 * 递归排序对象 key;**数组顺序原样保留**。见文件头:key 顺序不是行为,
 * 数组顺序是。
 */
export function sortKeysDeep(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeysDeep);
	if (value === null || typeof value !== "object") return value;
	const source = value as Record<string, unknown>;
	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(source).sort()) {
		sorted[key] = sortKeysDeep(source[key]);
	}
	return sorted;
}

export function snapshotJson(value: unknown): string {
	return JSON.stringify(sortKeysDeep(value), null, 2);
}

/** name + message + 可枚举自有字段(序列化时统一深度排序 key)。 */
export function describeError(error: unknown): unknown {
	if (!(error instanceof Error)) return { thrown: error };
	const own: Record<string, unknown> = {};
	for (const key of Object.keys(error)) {
		if (key === "stack") continue;
		own[key] = (error as unknown as Record<string, unknown>)[key];
	}
	return {
		name: error.name,
		message: error.message,
		ownEnumerableProperties: own,
	};
}

export function sseResponse(body: string): Response {
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

export function jsonResponse(
	body: string,
	init: { status: number; headers?: Record<string, string> },
): Response {
	return new Response(body, {
		status: init.status,
		headers: { "content-type": "application/json", ...init.headers },
	});
}

export async function drain(
	stream: AsyncIterable<AgentTurnStreamEvent>,
): Promise<AgentTurnStreamEvent[]> {
	const events: AgentTurnStreamEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

export function requestUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}

/**
 * 出站 fetch 桩的工厂。默认实现把每一次请求都当作那一跳线上请求;需要额外
 * 前置跳转的家族(github-copilot 先去 GitHub 换 completion token)自己传一个。
 */
export type WireFetchStubFactory = (
	respond: () => Response,
	onWireRequest: (init: RequestInit | undefined) => void,
) => typeof globalThis.fetch;

export const defaultWireFetchStub: WireFetchStubFactory = (
	respond,
	onWireRequest,
) =>
	(async (_input: RequestInfo | URL, init?: RequestInit) => {
		onWireRequest(init);
		return respond();
	}) as typeof globalThis.fetch;

export interface RuntimeProviderOptions
	extends CreateAgentProviderFromRuntimeOptions {
	fetchImpl: typeof globalThis.fetch;
}

/** 构造 provider —— 走生产入口,覆盖层(withPerModelCapabilities)也在里面。 */
export function createRuntimeProvider(
	providerId: string,
	config: AgentProviderRuntimeConfig,
	options: RuntimeProviderOptions,
): AgentProvider & { streamTurn: NonNullable<AgentProvider["streamTurn"]> } {
	const provider = createAgentProviderFromRuntime(providerId, config, options);
	if (!provider?.streamTurn) {
		throw new Error(`provider ${providerId} has no streamTurn`);
	}
	return provider as AgentProvider & {
		streamTurn: NonNullable<AgentProvider["streamTurn"]>;
	};
}

export interface CaptureWireRequestOptions {
	providerId: string;
	/** 传给生产入口的完整 config(含 `model` —— 各家注册块会读它)。 */
	config: AgentProviderRuntimeConfig;
	request: AgentTurnRequest;
	/** 请求体用例只关心「发出去什么」,流内容取最短的一条合法流。 */
	respond: () => Response;
	fetchStub?: WireFetchStubFactory;
	providerOptions?: Omit<CreateAgentProviderFromRuntimeOptions, "fetchImpl">;
}

/**
 * 截获出站请求:返回 dump 的元信息 + **线上那份** requestBody。
 */
export async function captureWireRequest(
	options: CaptureWireRequestOptions,
): Promise<AgentProviderRequestDump> {
	const dumps: AgentProviderRequestDump[] = [];
	const wireBodies: unknown[] = [];
	const requestDumper = vi.fn(async (dump: AgentProviderRequestDump) => {
		dumps.push(dump);
		return undefined;
	});
	const fetchStub = (options.fetchStub ?? defaultWireFetchStub)(
		options.respond,
		(init) => {
			wireBodies.push(JSON.parse(String(init?.body ?? "null")));
		},
	);
	const provider = createRuntimeProvider(options.providerId, options.config, {
		...options.providerOptions,
		fetchImpl: fetchStub,
		requestDumper: requestDumper as AgentProviderRequestDumper,
	});
	await drain(provider.streamTurn(options.request));
	expect(requestDumper).toHaveBeenCalledTimes(1);
	expect(wireBodies).toHaveLength(1);
	return {
		...dumps[0]!,
		requestBody: wireBodies[0] as AgentProviderRequestDump["requestBody"],
	};
}

// ---------------------------------------------------------------------------
// 共用的请求素材 —— 四个套件的 baseline / 工具表 / 多模态用例都用同一批,
// 这样跨家族看一眼就能对上「同一句话在四条线上长什么样」。
// ---------------------------------------------------------------------------

export function tool(
	name: string,
	description: string,
	properties: object,
	required: string[],
): AgentTool {
	return {
		name,
		description,
		parameters: { type: "object", properties, required },
		execute: async () => ({ content: "" }),
	} as AgentTool;
}

export const TOOLS: AgentTool[] = [
	tool(
		"read_file",
		"Read a UTF-8 text file from the workspace.",
		{ path: { type: "string", description: "Workspace-relative path." } },
		["path"],
	),
	tool(
		"write_file",
		"Write a UTF-8 text file into the workspace.",
		{
			path: { type: "string", description: "Workspace-relative path." },
			content: { type: "string", description: "Full file content." },
		},
		["path", "content"],
	),
];

export const SYSTEM_MESSAGE: AgentMessage = {
	role: "system",
	content: "You are onething, a careful engineering assistant.",
};

export const USER_MESSAGE: AgentMessage = {
	role: "user",
	content: "读一下 a.txt，然后把结论写进 b.txt。",
};

export const MULTIMODAL_USER_MESSAGE: AgentMessage = {
	role: "user",
	content: [
		{ type: "text", text: "这张截图和这份 PDF 说的是同一件事吗？" },
		{
			type: "image",
			image: "iVBORw0KGgoAAAANSUhEUg==",
			mediaType: "image/png",
		},
		{
			type: "file",
			data: "JVBERi0xLjcKJcOkw7zDtsOfCg==",
			mediaType: "application/pdf",
			filename: "spec.pdf",
		},
	],
};

// ---------------------------------------------------------------------------
// fixture 目录
// ---------------------------------------------------------------------------

export function fixtureFile(
	root: string,
	providerId: string,
	file: string,
): string {
	return path.join(root, providerId, file);
}

export function readFixtureFile(
	root: string,
	providerId: string,
	file: string,
): string {
	return readFileSync(fixtureFile(root, providerId, file), "utf8");
}

/** 元测试:每个 id 都有一个非空 fixture 目录。 */
export function expectFixtureDirectories(
	root: string,
	providerIds: readonly string[],
): void {
	for (const providerId of providerIds) {
		const dir = path.join(root, providerId);
		expect(existsSync(dir), `missing fixture dir for ${providerId}`).toBe(true);
		expect(
			readdirSync(dir).length,
			`empty fixture dir for ${providerId}`,
		).toBeGreaterThan(0);
	}
}
