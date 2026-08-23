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
 * Responses 线协议上**三个**注册 id(P4-4):`codex`(ChatGPT 后台,OAuth)
 * 与 xAI 的两条通路 `grok` / `grok-oauth`(`https://api.x.ai/v1/responses`,
 * Bearer)。同一条 wire 服务一台订阅制后台和一家纯 API-key 端点 —— 这就是
 * 「Responses wire 脱得开 codex 怪癖」那道门(设计稿 §9 P1 门 ①)。
 *
 * codex 的凭证按 `resolveCodexToken` 的读法造:`authContext.kind === 'oauth'`
 * 时取 `authContext.token`,固定字符串。**`refreshOAuthToken` 不传** ——
 * 传了会多一次 token 解析跳转,与「录今天的请求字节」无关。
 *
 * 走**生产入口** `createAgentProviderFromRuntime` 构造 —— 覆盖层
 * (`withPerModelCapabilities`)也在里面。
 *
 * ## codex 的 9 份 fixture 是这一期的**零变门**
 *
 * P4-4 把 wire 里的 codex 专属项(端点归一化 / 认证 / `store` /
 * `image_generation` / `include`+`reasoning` 同生共死 / 错误措辞 /
 * provider-data 标签)全部下沉成配方字段。做对了 = codex 那 9 份一个字节
 * 都不动。`-u` 只许 `-t "(grok|grok-oauth)"`。
 *
 * ## 值得盯住的三处「codex 今天的行为」
 *
 *  - **dump 的 metadata 里没有 `turn`**:codex 是唯一一个 `mode: 'codex-http'`
 *    的,元信息是 `{url, method, requestSource: 'agent-loop'}`,别的家族是
 *    `{url, method, turn}`。
 *  - **dump 发生在换 token 之前**:`requestDumper` 在 `resolveCodexTokenForRequest`
 *    之前就 await 了,所以「落盘了」并不等于「请求发出去了」。
 *  - **`include: ['reasoning.encrypted_content']` 与 `reasoning` 同生共死**:
 *    thinking 关掉时两者一起消失,`include` 退成空数组(不是不发)。
 *    **xAI 不是这样**:官方说 reasoning 关不掉,所以加密思维链永远存在 ——
 *    `include` 恒发那一条,`reasoning` 才随 thinking 开关进出。
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
export const RESPONSES_PROVIDER_IDS = ["codex", "grok", "grok-oauth"] as const;

type ResponsesProviderId = (typeof RESPONSES_PROVIDER_IDS)[number];

const CODEX_ID = "codex";
const DEFAULT_MODEL = "gpt-5.5";
/** xAI 的当家模型 —— 四档 effort(含 `xhigh`)、500k 上下文、收图与 PDF。 */
const GROK_MODEL = "grok-4.6";

interface ProviderFixture {
	model: string;
	config: AgentProviderRuntimeConfig;
}

/**
 * 各家构造所需的最小 config —— 逐条对着 `factory.ts` 的注册块读出来的。
 * `grok` 是普通 API key;`grok-oauth` 走 `accessTokenFromRuntimeConfig`,
 * 凭证只能挂在 `authContext.token` 或 `oauthToken` 上(`apiKey` 对它恒为空)。
 */
const PROVIDERS: Record<ResponsesProviderId, ProviderFixture> = {
	codex: {
		model: DEFAULT_MODEL,
		// `resolveCodexToken`:oauth 的 authContext 优先,取它的 `token`。
		config: {
			authContext: {
				kind: "oauth",
				token: { accessToken: "codex-access-token" },
			},
		},
	},
	grok: {
		model: GROK_MODEL,
		config: { apiKey: "sk-grok-fixture" },
	},
	"grok-oauth": {
		model: GROK_MODEL,
		config: {
			authContext: {
				kind: "oauth",
				token: { accessToken: "grok-oauth-access-token" },
			},
		},
	},
};

const CONFIG = PROVIDERS.codex.config;

/** 请求体用例只关心「发出去什么」,流内容取最短的一条合法流。 */
function minimalStream(model: string): string {
	return `event: response.completed\ndata: ${JSON.stringify({
		type: "response.completed",
		response: {
			id: "resp_minimal",
			model,
			usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
		},
	})}\n\n`;
}

const MINIMAL_STREAM = minimalStream(DEFAULT_MODEL);

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

function fixturePath(file: string, providerId: string = CODEX_ID): string {
	return fixtureFile(FIXTURE_ROOT, providerId, file);
}

function buildProviderFor(
	providerId: ResponsesProviderId,
	fetchImpl: typeof globalThis.fetch,
) {
	const { model, config } = PROVIDERS[providerId];
	return createRuntimeProvider(providerId, { ...config, model }, { fetchImpl });
}

function buildProvider(fetchImpl: typeof globalThis.fetch) {
	return buildProviderFor(CODEX_ID, fetchImpl);
}

async function captureRequestFor(
	providerId: ResponsesProviderId,
	request: RequestCase,
): Promise<AgentProviderRequestDump> {
	const { model, config } = PROVIDERS[providerId];
	return captureWireRequest({
		providerId,
		config: { ...config, model },
		request: { ...request, model, turn: 1 },
		respond: () => sseResponse(minimalStream(model)),
	});
}

async function captureRequest(
	request: RequestCase,
): Promise<AgentProviderRequestDump> {
	return captureRequestFor(CODEX_ID, request);
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


// ---------------------------------------------------------------------------
// xAI(grok / grok-oauth)—— P4-4
// ---------------------------------------------------------------------------

/**
 * xAI 的加密思维链回放。**标签是 `'grok'` 而不是 providerId** —— 两条通路共用
 * 一个家族标签(见 `dialects/grok.ts` 的 `GROK_PROVIDER_DATA_TAG`),所以
 * grok-oauth 也认这一段历史。
 */
const GROK_HISTORY_MESSAGES: AgentMessage[] = [
	SYSTEM_MESSAGE,
	{ role: "user", content: "读一下 a.txt。" },
	{
		role: "assistant",
		content: "我先读一下这个文件。",
		reasoningContent: "先确认文件存在，再决定要不要写。",
		providerData: [
			{
				provider: "grok",
				type: "encrypted-reasoning",
				encryptedContent: "grok-enc-fixture-0001",
			},
			{
				provider: "grok",
				type: "encrypted-reasoning",
				encryptedContent: "grok-enc-fixture-0002",
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

/**
 * 五个用例,与 codex 那批同维度 —— 差异因此是**方言字段的差异**,一眼看得出:
 *
 *  - `baseline`                 —— `instructions` / `input` / `store:false` /
 *                                  `include` 恒发 `reasoning.encrypted_content`
 *                                  (xAI 关不掉思考,加密内容永远存在);
 *                                  **没有** `reasoning`(thinking 没说 = 不发);
 *  - `tools-auto-thinking-high` —— 工具表(**没有** codex 的 `image_generation`)
 *                                  + `tool_choice:'auto'` + `reasoning:{effort:'high'}`;
 *                                  temperature / maxTokens 这条线上没有出口;
 *  - `tools-named-thinking-max` —— 扁平 `{type:'function', name}` +
 *                                  effort `'max'` → **`xhigh`**(官方:xhigh
 *                                  available on grok-4.6 and later);
 *  - `thinking-off-multimodal`  —— thinking off ⇒ 没有 `reasoning`,但 `include`
 *                                  **仍在**;`input_image` / `input_file`(PDF
 *                                  要 filename)—— 后者是换线之后新拿到的通道;
 *  - `history-tool-roundtrip`   —— 加密 reasoning 回放(标签 `'grok'`)+
 *                                  function_call / function_call_output 往返。
 */
const GROK_REQUEST_CASES: Record<string, RequestCase> = {
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
	"history-tool-roundtrip": {
		messages: GROK_HISTORY_MESSAGES,
		tools: TOOLS,
	},
};

const XAI_IDS = ["grok", "grok-oauth"] as const;

describe("openai-responses wire snapshots — xAI request bodies", () => {
	for (const providerId of XAI_IDS) {
		describe(providerId, () => {
			for (const [caseName, request] of Object.entries(GROK_REQUEST_CASES)) {
				it(caseName, async () => {
					const dump = await captureRequestFor(providerId, request);
					await expect(snapshotJson(dump)).toMatchFileSnapshot(
						fixturePath(`${caseName}.request.json`, providerId),
					);
				});
			}
		});
	}

	/**
	 * 请求级 providerOptions 袋(P3-3 的机制,这条线的白名单)。一份 fixture
	 * 守三件事:`searchParameters` 的合法子键原样写进顶层 `search_parameters`
	 * (官方 `POST /v1/responses` 的 Request Body 上原样列着这个对象)、
	 * `imageDetail` 进**每一个** `input_image.detail`、白名单外的 `unknownKey`
	 * 与 `searchParameters.bogus` 一个字都不出现。
	 *
	 * 上面五个用例**不带袋**,所以那批 fixture 与袋无关。
	 */
	it("grok — request providerOptions bag: imageDetail + search_parameters", async () => {
		const dump = await captureRequestFor("grok", {
			messages: [SYSTEM_MESSAGE, MULTIMODAL_USER_MESSAGE],
			providerOptions: {
				grok: {
					imageDetail: "high",
					searchParameters: {
						mode: "auto",
						max_search_results: 5,
						return_citations: true,
						bogus: 1,
					},
					unknownKey: 1,
				},
			},
		});
		const body = dump.requestBody as { search_parameters?: unknown };
		expect(body.search_parameters).toEqual({
			mode: "auto",
			max_search_results: 5,
			return_citations: true,
		});
		const serialized = JSON.stringify(dump.requestBody);
		expect(serialized).toContain('"detail":"high"');
		expect(serialized).not.toContain("bogus");
		expect(serialized).not.toContain("unknownKey");
		await expect(snapshotJson(dump)).toMatchFileSnapshot(
			fixturePath("provider-options.request.json", "grok"),
		);
	});
});

describe("openai-responses wire snapshots — xAI stream parsing", () => {
	/**
	 * `sse.txt` 是**手写的输入 fixture**,形状照官方的 Responses 事件流:
	 * reasoning 的 `output_item.added` → `reasoning_summary_text.delta` ×2 →
	 * `output_item.done`(带 `encrypted_content`)→ `output_text.delta` ×2 →
	 * 两个 function_call 的 `arguments.delta` + `output_item.done` →
	 * message 项的 `output_item.done`(带 `annotations[].url_citation` ——
	 * 官方 `/developers/tools/citations` 的形状)→ `response.completed`
	 * (usage 含 `input_tokens_details.cached_tokens` /
	 * `output_tokens_details.reasoning_tokens` / **`cost_in_usd_ticks`**)。
	 */
	for (const providerId of XAI_IDS) {
		it(`${providerId} — sse.txt → events`, async () => {
			const provider = buildProviderFor(providerId, (async () =>
				sseResponse(
					readFixtureFile(FIXTURE_ROOT, "grok", "sse.txt"),
				)) as typeof globalThis.fetch);
			const events = await drain(
				provider.streamTurn({
					messages: [SYSTEM_MESSAGE, USER_MESSAGE],
					tools: TOOLS,
					model: PROVIDERS[providerId].model,
					turn: 1,
				}),
			);
			await expect(snapshotJson(events)).toMatchFileSnapshot(
				fixturePath("events.json", providerId),
			);
		});
	}
});

describe("openai-responses wire snapshots — xAI HTTP errors", () => {
	for (const providerId of XAI_IDS) {
		it(`${providerId} — 429 + retry-after`, async () => {
			vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW);
			const provider = buildProviderFor(providerId, (async () =>
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
						model: PROVIDERS[providerId].model,
						turn: 1,
					}),
				);
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(Error);
			await expect(snapshotJson(describeError(caught))).toMatchFileSnapshot(
				fixturePath("error.json", providerId),
			);
		});
	}
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
