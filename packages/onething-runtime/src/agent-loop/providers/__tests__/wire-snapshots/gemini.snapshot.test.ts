/**
 * P1 第 ① 道门 —— gemini(generateContent)线协议的**逐字节基线**。
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
 * API 不是行为;数组顺序是(消息次序、parts 次序、工具表次序、流事件次序)。
 * `sse.txt` 是输入,原样不动。
 *
 * ## 覆盖面
 *
 * 只有一个注册 id(`gemini`),但它有两条**思考线型**,各录一份:
 *  - `gemini-3.1-pro`   —— `thinkingConfig.thinkingLevel`(3+ 的旋钮),
 *                          且这一档只接受 low/medium/high
 *  - `gemini-2.5-flash` —— `thinkingConfig.thinkingBudget`(2.5 的旋钮,数值预算);
 *                          **只有 flash 档能把预算真正设成 0** 来关思考
 *
 * 走**生产入口** `createAgentProviderFromRuntime` 构造 —— 覆盖层
 * (`withPerModelCapabilities`)也在里面。
 *
 * ## 值得盯住的两处「今天的行为」
 *
 *  - **URL 上不带凭据**:钥匙只走 `x-goog-api-key` 头。P2-b 之前它**同时**挂在
 *    `?key=<apiKey>` 上,dump 那份换成 `key=[redacted]`;这批快照的 `metadata.url`
 *    因此少了 `&key=%5Bredacted%5D`(本文件唯一一次有意 `-u`)。
 *  - **usage 的 outputTokens 不含 thoughts**:`candidatesTokenCount` 直接当
 *    outputTokens,`thoughtsTokenCount` 另挂 `reasoningTokens`,`totalTokens`
 *    则取 `totalTokenCount`(于是 input + output ≠ total,这是现状不是笔误)。
 *
 * ## 不稳定字段
 *
 * - `error*.json` 里的 `retryAfterAt` 是 `Date.now() + <retry-after 或 RetryInfo>`。
 *   错误用例把 `Date.now` 钉在 `FIXED_NOW`(1700000000000),于是 1700000015000
 *   = +15s(响应头那条)、1700000027000 = +27s(响应体 RetryInfo 那条)。
 * - 其余快照没有时间戳/随机 id:工具调用 id 是 `gemini-<turn>-<index>-<name>`
 *   这样的确定式拼接,`turn` 固定为 1。
 *
 * `sse.txt` 是**手写的输入 fixture**(不是快照),形状照 `streamGenerateContent?
 * alt=sse` 真实的多块 GenerateContentResponse:thought:true 的 part、普通 text
 * part、同一块里两个 functionCall、最后一块带 usageMetadata。
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
	new URL("./__fixtures__/gemini", import.meta.url),
);

/** 每个 id 的 fixture 目录名 = id 本身。 */
export const GEMINI_PROVIDER_IDS = ["gemini"] as const;

const GEMINI_ID = "gemini";
const DEFAULT_MODEL = "gemini-3.1-pro";
/** 2.5 档:思考旋钮换成数值预算,`flash` 是唯一能把预算设成 0 的。 */
const BUDGET_MODEL = "gemini-2.5-flash";

const CONFIG: AgentProviderRuntimeConfig = { apiKey: "sk-gemini-fixture" };

/** 请求体用例只关心「发出去什么」,流内容取最短的一条合法流。 */
const MINIMAL_STREAM = `data: ${JSON.stringify({
	candidates: [
		{
			index: 0,
			content: { role: "model", parts: [{ text: "ok" }] },
			finishReason: "STOP",
		},
	],
})}\n\n`;

/**
 * Gemini 的历史有两处只有回放才看得见的形状:assistant 的 `functionCall` 不带
 * id(名字就是配对键),而工具结果是一条 **`role: 'function'`** 的 content,
 * 名字靠 `toolCallId → toolName` 的表反查 —— 表里没有就退回 toolCallId 本身。
 * 这里第二条工具结果故意用一个**没被 assistant 声明过**的 id,把那条兜底也钉住。
 */
const HISTORY_MESSAGES: AgentMessage[] = [
	SYSTEM_MESSAGE,
	{ role: "user", content: "读一下 a.txt。" },
	{
		role: "assistant",
		content: "我先读一下这个文件。",
		reasoningContent: "先确认文件存在，再决定要不要写。",
		toolCalls: [
			{ id: "call_read", name: "read_file", arguments: '{"path":"a.txt"}' },
		],
	},
	{ role: "tool", toolCallId: "call_read", content: "hello from a.txt" },
	{ role: "tool", toolCallId: "call_unknown", content: "orphaned result" },
	{ role: "user", content: "总结一下。" },
];

type RequestCase = Omit<AgentTurnRequest, "model" | "turn">;

/**
 * 六个用例,按互不干扰的维度叠加(不做笛卡尔积):
 *  - `baseline`                 —— 消息形状 + systemInstruction,thinkingConfig 不发
 *  - `tools-auto-thinking-high` —— functionDeclarations + toolConfig AUTO +
 *                                  thinkingLevel high + maxOutputTokens + temperature
 *  - `tools-named-thinking-max` —— 指名函数(mode ANY + allowedFunctionNames)+
 *                                  effort 'max'(不在 Gemini 的档位里,落回 high)
 *  - `thinking-off-multimodal`  —— thinking off(3.x 关不掉,取该模型最低档)+
 *                                  inlineData 的图片/PDF
 *  - `thinking-unset`           —— 什么都不说:generationConfig 里没有 thinkingConfig,
 *                                  temperature 照常保留
 *  - `history-tool-roundtrip`   —— functionCall / functionResponse 的往返形状
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
	return fixtureFile(FIXTURE_ROOT, GEMINI_ID, file);
}

function buildProvider(fetchImpl: typeof globalThis.fetch, model: string) {
	return createRuntimeProvider(GEMINI_ID, { ...CONFIG, model }, { fetchImpl });
}

async function captureRequest(
	request: RequestCase,
	model: string = DEFAULT_MODEL,
): Promise<AgentProviderRequestDump> {
	return captureWireRequest({
		providerId: GEMINI_ID,
		config: { ...CONFIG, model },
		request: { ...request, model, turn: 1 },
		respond: () => sseResponse(MINIMAL_STREAM),
	});
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("gemini wire snapshots — request bodies", () => {
	for (const [caseName, request] of Object.entries(REQUEST_CASES)) {
		it(caseName, async () => {
			const dump = await captureRequest(request);
			await expect(snapshotJson(dump)).toMatchFileSnapshot(
				fixturePath(`${caseName}.request.json`),
			);
		});
	}

	/** 2.5 档的思考旋钮是数值预算,不是档位名。 */
	it("thinking high on gemini-2.5-flash (budget wire)", async () => {
		const dump = await captureRequest(
			{
				messages: [SYSTEM_MESSAGE, USER_MESSAGE],
				tools: TOOLS,
				toolChoice: "auto",
				thinking: "enabled",
				reasoningEffort: "high",
				temperature: 0.3,
				maxTokens: 1234,
			},
			BUDGET_MODEL,
		);
		await expect(snapshotJson(dump)).toMatchFileSnapshot(
			fixturePath("thinking-high.gemini-2.5-flash.request.json"),
		);
	});

	/** flash 是唯一能真正关掉思考的档:`thinkingBudget: 0`。 */
	it("thinking off on gemini-2.5-flash (budget 0)", async () => {
		const dump = await captureRequest(
			{
				messages: [SYSTEM_MESSAGE, USER_MESSAGE],
				thinking: "disabled",
				temperature: 0.3,
				maxTokens: 1234,
			},
			BUDGET_MODEL,
		);
		await expect(snapshotJson(dump)).toMatchFileSnapshot(
			fixturePath("thinking-off.gemini-2.5-flash.request.json"),
		);
	});
});

describe("gemini wire snapshots — stream parsing", () => {
	it("sse.txt → events", async () => {
		const provider = buildProvider(
			(async () =>
				sseResponse(
					readFixtureFile(FIXTURE_ROOT, GEMINI_ID, "sse.txt"),
				)) as typeof globalThis.fetch,
			DEFAULT_MODEL,
		);
		const events = await drain(
			provider.streamTurn({
				messages: [SYSTEM_MESSAGE, USER_MESSAGE],
				tools: TOOLS,
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
		code: 429,
		message: "Resource has been exhausted (e.g. check quota).",
		status: "RESOURCE_EXHAUSTED",
	},
});

/** Gemini 没有 `Retry-After` 头 —— 恢复时刻藏在 `error.details[]` 的 RetryInfo 里。 */
const ERROR_BODY_WITH_RETRY_INFO = JSON.stringify({
	error: {
		code: 429,
		message: "You exceeded your current quota, please check your plan.",
		status: "RESOURCE_EXHAUSTED",
		details: [
			{
				"@type": "type.googleapis.com/google.rpc.QuotaFailure",
				violations: [{ quotaMetric: "generate_content_free_tier_requests" }],
			},
			{
				"@type": "type.googleapis.com/google.rpc.RetryInfo",
				retryDelay: "27s",
			},
		],
	},
});

async function captureError(response: () => Response): Promise<unknown> {
	const provider = buildProvider(
		(async () => response()) as typeof globalThis.fetch,
		DEFAULT_MODEL,
	);
	try {
		await drain(
			provider.streamTurn({
				messages: [SYSTEM_MESSAGE, USER_MESSAGE],
				model: DEFAULT_MODEL,
				turn: 1,
			}),
		);
	} catch (error) {
		return error;
	}
	throw new Error("expected the 429 to throw");
}

describe("gemini wire snapshots — HTTP errors", () => {
	it("429 + retry-after header", async () => {
		vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW);
		const caught = await captureError(() =>
			jsonResponse(ERROR_BODY, {
				status: 429,
				headers: { "retry-after": "15" },
			}),
		);
		expect(caught).toBeInstanceOf(Error);
		await expect(snapshotJson(describeError(caught))).toMatchFileSnapshot(
			fixturePath("error.json"),
		);
	});

	it("429 + RetryInfo in the body (no retry-after header)", async () => {
		vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW);
		const caught = await captureError(() =>
			jsonResponse(ERROR_BODY_WITH_RETRY_INFO, { status: 429 }),
		);
		expect(caught).toBeInstanceOf(Error);
		await expect(snapshotJson(describeError(caught))).toMatchFileSnapshot(
			fixturePath("error-retry-info.json"),
		);
	});
});

describe("gemini wire snapshots — fixture inventory", () => {
	it("every listed id is a supported runtime provider", () => {
		for (const providerId of GEMINI_PROVIDER_IDS) {
			expect(
				isAgentProviderRuntimeSupported(providerId),
				`${providerId} is not a supported agent provider runtime`,
			).toBe(true);
		}
	});

	it("every listed id has a non-empty fixture directory", () => {
		expectFixtureDirectories(FIXTURE_ROOT, GEMINI_PROVIDER_IDS);
	});
});
