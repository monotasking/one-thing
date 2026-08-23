/**
 * P1 第 ① 道门 —— openai-responses(codex)线协议的**逐字节基线**。
 *
 * 这些快照是从「今天的生产代码」跑出来的,记录的是 **2026-08-23 的实际行为**,
 * 不是「应该的行为」。Provider 面向对象重建(docs/design/provider-oop-2026-08.md
 * §9 P1)之后,重构过的代码必须逐字节通过同一批快照。
 *
 * ⚠️ **禁止用 `-u` / `--update` 更新这批快照。**
 * 快照红了 = 线上发出去的字节变了。若确实需要更新,必须在 PR 里逐处说明差异:
 * 哪个 provider、哪个字段、变成了什么、为什么是有意为之。
 *
 * **快照按深度排序 key 比对;数组顺序仍逐字节。** JSON 对象的 key 顺序对 HTTP
 * API 不是行为;数组顺序是(input 次序、content 次序、工具表次序、流事件次序)。
 * `sse.txt` 是输入,原样不动。
 *
 * ## 覆盖面
 *
 * Responses 线协议今天只有一个注册 id:`codex`(`registerAgentProviderRuntime
 * ('codex', …)` → `createCodexAgentProvider`)。凭证按 `resolveCodexToken` 的
 * 读法造:`authContext.kind === 'oauth'` 时取 `authContext.token`,固定字符串。
 * **`refreshOAuthToken` 不传** —— 传了会多一次 token 解析跳转,与「录今天的
 * 请求字节」无关。
 *
 * 走**生产入口** `createAgentProviderFromRuntime` 构造 —— 覆盖层
 * (`withPerModelCapabilities`)也在里面。
 *
 * ## 值得盯住的三处「今天的行为」
 *
 *  - **dump 的 metadata 里没有 `turn`**:codex 是唯一一个 `mode: 'codex-http'`
 *    的,元信息是 `{url, method, requestSource: 'agent-loop'}`,别的家族是
 *    `{url, method, turn}`。
 *  - **dump 发生在换 token 之前**:`requestDumper` 在 `resolveCodexTokenForRequest`
 *    之前就 await 了,所以「落盘了」并不等于「请求发出去了」。
 *  - **`include: ['reasoning.encrypted_content']` 与 `reasoning` 同生共死**:
 *    thinking 关掉时两者一起消失,`include` 退成空数组(不是不发)。
 *
 * ## 不稳定字段
 *
 * - `error.json` 里的 `retryAfterAt` 是 `Date.now() + retry-after`。错误用例把
 *   `Date.now` 钉在 `FIXED_NOW`(1700000000000),所以 1700000015000 = +15s。
 * - 其余快照没有时间戳/随机 id:call_id 来自手写的 `sse.txt`,`turn` 固定为 1。
 *
 * `sse.txt` 是**手写的输入 fixture**(不是快照),形状照真实的 Responses 事件流:
 * reasoning 的 output_item.added → reasoning_summary_text.delta ×2 →
 * output_item.done(带 encrypted_content)→ 文本 output_text.delta →
 * 两个 function_call 的 arguments.delta + output_item.done →
 * image_generation_call 的 added/done → `response.completed`
 * (usage 含 input/output/input_tokens_details.cached/output_tokens_details.reasoning)。
 */
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage, AgentTurnRequest } from "@onething/core/agent-loop";
import {
	isAgentProviderRuntimeSupported,
	type AgentProviderRuntimeConfig,
} from "../../factory.js";
import type { AgentProviderRequestDump } from "../../request-dump.js";
import {
	FIXED_NOW,
	MULTIMODAL_USER_MESSAGE,
	SYSTEM_MESSAGE,
	TOOLS,
	USER_MESSAGE,
	captureWireRequest,
	createRuntimeProvider,
	describeError,
	drain,
	expectFixtureDirectories,
	fixtureFile,
	jsonResponse,
	readFixtureFile,
	snapshotJson,
	sseResponse,
} from "./snapshot-harness.js";

const FIXTURE_ROOT = fileURLToPath(
	new URL("./__fixtures__/responses", import.meta.url),
);

/** 每个 id 的 fixture 目录名 = id 本身。 */
export const RESPONSES_PROVIDER_IDS = ["codex"] as const;

const CODEX_ID = "codex";
const DEFAULT_MODEL = "gpt-5.5";

/** `resolveCodexToken`:oauth 的 authContext 优先,取它的 `token`。 */
const CONFIG: AgentProviderRuntimeConfig = {
	authContext: {
		kind: "oauth",
		token: { accessToken: "codex-access-token" },
	},
};

/** 请求体用例只关心「发出去什么」,流内容取最短的一条合法流。 */
const MINIMAL_STREAM = `event: response.completed\ndata: ${JSON.stringify({
	type: "response.completed",
	response: {
		id: "resp_minimal",
		model: DEFAULT_MODEL,
		usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
	},
})}\n\n`;

/**
 * `codexEncryptedReasoning` 只读 `providerData` 里 `provider === 'codex'` 且
 * `type === 'encrypted-reasoning'` 的记录的 **`encryptedContent`** 字段 ——
 * 每条会被摊成一个独立的 `{type:'reasoning', summary:[], encrypted_content}`
 * input 项,而且**排在同一条 assistant 消息的文本与 function_call 之前**。
 * 这里造两条,把「多条各成一项 + 次序」一起钉住。
 */
const HISTORY_MESSAGES: AgentMessage[] = [
	SYSTEM_MESSAGE,
	{ role: "user", content: "读一下 a.txt。" },
	{
		role: "assistant",
		content: "我先读一下这个文件。",
		reasoningContent: "先确认文件存在，再决定要不要写。",
		providerData: [
			{
				provider: "codex",
				type: "encrypted-reasoning",
				encryptedContent: "enc-fixture-0001",
			},
			{
				provider: "codex",
				type: "encrypted-reasoning",
				encryptedContent: "enc-fixture-0002",
			},
		],
		toolCalls: [
			{ id: "call_read", name: "read_file", arguments: '{"path":"a.txt"}' },
			{
				id: "call_write",
				name: "write_file",
				arguments: '{"path":"b.txt","content":"done"}',
			},
		],
	},
	{ role: "tool", toolCallId: "call_read", content: "hello from a.txt" },
	{
		role: "tool",
		toolCallId: "call_write",
		content: "EACCES: permission denied, open 'b.txt'",
		isError: true,
	},
	{ role: "user", content: "总结一下。" },
];

type RequestCase = Omit<AgentTurnRequest, "model" | "turn">;

/**
 * 六个用例,按互不干扰的维度叠加(不做笛卡尔积):
 *  - `baseline`                 —— input / instructions 形状 + 固定字段
 *                                  (store / stream / parallel_tool_calls)
 *  - `tools-auto-thinking-high` —— 工具表 + tool_choice 'auto' + effort high;
 *                                  **Responses 没有 max_tokens / temperature 的
 *                                  出口**,给了也不会出现在请求里
 *  - `tools-named-thinking-max` —— 指名函数的 **扁平** tool_choice
 *                                  (`{type:'function', name}`,不是 chat 的嵌套形状)
 *                                  + effort 'max'(codex 没有这一档,钳成 high)
 *  - `thinking-off-multimodal`  —— thinking off ⇒ 没有 reasoning、`include` 空;
 *                                  input_image / input_file(PDF 要 filename)
 *  - `thinking-unset`           —— 什么都不说:`isCodexReasoningModel` 认出
 *                                  gpt-5 系,自己补上 effort 'medium'
 *  - `history-tool-roundtrip`   —— 加密 reasoning 回放 + function_call /
 *                                  function_call_output 的往返形状
 */
const REQUEST_CASES: Record<string, RequestCase> = {
	baseline: {
		messages: [SYSTEM_MESSAGE, USER_MESSAGE],
	},
	"tools-auto-thinking-high": {
		messages: [SYSTEM_MESSAGE, USER_MESSAGE],
		tools: TOOLS,
		toolChoice: "auto",
		thinking: "enabled",
		reasoningEffort: "high",
		temperature: 0.3,
		maxTokens: 1234,
	},
	"tools-named-thinking-max": {
		messages: [SYSTEM_MESSAGE, USER_MESSAGE],
		tools: TOOLS,
		toolChoice: { type: "function", function: { name: "read_file" } },
		thinking: "enabled",
		reasoningEffort: "max",
	},
	"thinking-off-multimodal": {
		messages: [SYSTEM_MESSAGE, MULTIMODAL_USER_MESSAGE],
		thinking: "disabled",
		temperature: 0.3,
		maxTokens: 1234,
	},
	"thinking-unset": {
		messages: [SYSTEM_MESSAGE, USER_MESSAGE],
		tools: TOOLS,
		toolChoice: "auto",
		temperature: 0.3,
		maxTokens: 1234,
	},
	"history-tool-roundtrip": {
		messages: HISTORY_MESSAGES,
		tools: TOOLS,
	},
};

function fixturePath(file: string): string {
	return fixtureFile(FIXTURE_ROOT, CODEX_ID, file);
}

function buildProvider(fetchImpl: typeof globalThis.fetch) {
	return createRuntimeProvider(
		CODEX_ID,
		{ ...CONFIG, model: DEFAULT_MODEL },
		{ fetchImpl },
	);
}

async function captureRequest(
	request: RequestCase,
): Promise<AgentProviderRequestDump> {
	return captureWireRequest({
		providerId: CODEX_ID,
		config: { ...CONFIG, model: DEFAULT_MODEL },
		request: { ...request, model: DEFAULT_MODEL, turn: 1 },
		respond: () => sseResponse(MINIMAL_STREAM),
	});
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("openai-responses wire snapshots — request bodies", () => {
	for (const [caseName, request] of Object.entries(REQUEST_CASES)) {
		it(caseName, async () => {
			const dump = await captureRequest(request);
			await expect(snapshotJson(dump)).toMatchFileSnapshot(
				fixturePath(`${caseName}.request.json`),
			);
		});
	}

	/**
	 * 生图不是一个开关,而是**工具表里多一项** `{type:'image_generation',
	 * output_format:'png'}` —— 由 `requestedOutputModalities` 含 'image' 决定。
	 */
	it("image-output — requestedOutputModalities adds the image_generation tool", async () => {
		const dump = await captureRequest({
			messages: [SYSTEM_MESSAGE, USER_MESSAGE],
			tools: TOOLS,
			toolChoice: "auto",
			requestedOutputModalities: ["image"],
			thinking: "enabled",
			reasoningEffort: "high",
		});
		await expect(snapshotJson(dump)).toMatchFileSnapshot(
			fixturePath("image-output.request.json"),
		);
	});
});

describe("openai-responses wire snapshots — stream parsing", () => {
	it("sse.txt → events", async () => {
		const provider = buildProvider((async () =>
			sseResponse(
				readFixtureFile(FIXTURE_ROOT, CODEX_ID, "sse.txt"),
			)) as typeof globalThis.fetch);
		const events = await drain(
			provider.streamTurn({
				messages: [SYSTEM_MESSAGE, USER_MESSAGE],
				tools: TOOLS,
				requestedOutputModalities: ["image"],
				model: DEFAULT_MODEL,
				turn: 1,
			}),
		);
		await expect(snapshotJson(events)).toMatchFileSnapshot(
			fixturePath("events.json"),
		);
	});
});

const ERROR_BODY = JSON.stringify({
	error: {
		message: "Rate limit reached for requests",
		type: "requests",
		code: "rate_limit_exceeded",
	},
});

describe("openai-responses wire snapshots — HTTP errors", () => {
	it("429 + retry-after", async () => {
		vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW);
		const provider = buildProvider((async () =>
			jsonResponse(ERROR_BODY, {
				status: 429,
				headers: {
					"retry-after": "15",
					"x-oai-request-id": "req_fixture_0001",
				},
			})) as typeof globalThis.fetch);
		let caught: unknown;
		try {
			await drain(
				provider.streamTurn({
					messages: [SYSTEM_MESSAGE, USER_MESSAGE],
					model: DEFAULT_MODEL,
					turn: 1,
				}),
			);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Error);
		await expect(snapshotJson(describeError(caught))).toMatchFileSnapshot(
			fixturePath("error.json"),
		);
	});
});

describe("openai-responses wire snapshots — fixture inventory", () => {
	it("every listed id is a supported runtime provider", () => {
		for (const providerId of RESPONSES_PROVIDER_IDS) {
			expect(
				isAgentProviderRuntimeSupported(providerId),
				`${providerId} is not a supported agent provider runtime`,
			).toBe(true);
		}
	});

	it("every listed id has a non-empty fixture directory", () => {
		expectFixtureDirectories(FIXTURE_ROOT, RESPONSES_PROVIDER_IDS);
	});
});
