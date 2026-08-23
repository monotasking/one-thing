/**
 * P0a 第 ① 道门 —— openai-chat 线协议的**逐字节基线**。
 *
 * 这些快照是从「今天的生产代码」跑出来的,记录的是 **2026-08-23 的实际行为**,
 * 不是「应该的行为」。Provider 面向对象重建(docs/design/provider-oop-2026-08.md
 * §9 P0a)之后,重构过的代码必须逐字节通过同一批快照。
 *
 * ⚠️ **禁止用 `-u` / `--update` 更新这批快照。**
 * 快照红了 = 线上发出去的字节变了。若确实需要更新,必须在 PR 里逐处说明差异:
 * 哪个 provider、哪个字段、变成了什么、为什么是有意为之。
 *
 * **快照按深度排序 key 比对;数组顺序仍逐字节。** JSON 对象的 key 顺序对 HTTP
 * API 不是行为(同一条线上 deepseek 与 openai-compatible 拼 tool 消息的 key
 * 顺序就不同),逐字节盯 key 顺序只会逼着迁移去复刻偶然顺序。所以序列化前对
 * 对象做递归 key 排序 —— **数组元素顺序不动**(那是真行为:消息次序、内容块
 * 次序、工具表次序、流事件次序)。`sse.txt` 是输入,原样不动。
 *
 * ## 覆盖面
 *
 * openai-chat 线协议上全部 11 个注册 id(见 `OPENAI_CHAT_PROVIDER_IDS`):
 * 10 个 `registerAgentProviderRuntime(...)` 注册的 + 1 个 `custom-*`
 * (apiType `openai`,走 `createCustomAgentProviderFromRuntime`)。
 * 全部经**生产入口** `createAgentProviderFromRuntime` 构造 —— 覆盖层
 * (`withPerModelCapabilities`)也在里面。
 *
 * 每家五个请求体用例(deepseek 多一个 thinking-unset 的对照模型),外加一份
 * 流解析事件快照与一份错误快照。用例矩阵按 hook 正交裁剪,不做笛卡尔积:
 * 单个请求里叠加的是**互不干扰**的维度(工具 + thinking + maxTokens),
 * 会互相影响的维度(thinking 与 temperature 的互斥)则各自成例。
 *
 * ## 不稳定字段
 *
 * - `error.json` 里的 `retryAfterAt` 是 `Date.now() + retry-after`。错误用例把
 *   `Date.now` 钉在 `FIXED_NOW`(2023-11-14T22:13:20.000Z),所以快照里的
 *   1700000015000 = FIXED_NOW + 15s,是确定值。
 * - 其余快照没有时间戳/随机 id:tool call id 来自手写的 `sse.txt`,
 *   `turn` 固定为 1。
 *
 * 取样与序列化的公共实现在 `./snapshot-harness.ts`,四个线协议套件(openai-chat /
 * anthropic-messages / gemini / openai-responses)共用同一套规则。
 *
 * `sse.txt` / `sse-*.txt` 是**手写的输入 fixture**(不是快照),形状照各家真实
 * 的线上流:文本增量、reasoning 增量、两个工具调用按 index 交错、finish_reason、
 * 最后一块 usage(各家用各家真实的 usage 字段名)。
 */
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage, AgentTurnRequest } from "@onething/core/agent-loop";
import {
	isAgentProviderRuntimeSupported,
	type AgentProviderRuntimeConfig,
} from "../../factory.js";
import type {
	AgentProviderRequestDump,
	AgentProviderRequestDumper,
} from "../../request-dump.js";
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
	readFixtureFile,
	requestUrl,
	snapshotJson,
	sseResponse,
	type WireFetchStubFactory,
} from "./snapshot-harness.js";

const FIXTURE_ROOT = fileURLToPath(
	new URL("./__fixtures__/openai-chat", import.meta.url),
);

/** 每个 id 的 fixture 目录名 = id 本身。 */
export const OPENAI_CHAT_PROVIDER_IDS = [
	"openai",
	"deepseek",
	"kimi",
	"kimi-code",
	"zhipu",
	"qwen",
	"grok",
	"grok-oauth",
	"openrouter",
	"github-copilot",
	"custom-acme",
] as const;

type OpenAIChatProviderId = (typeof OPENAI_CHAT_PROVIDER_IDS)[number];

interface ProviderFixture {
	model: string;
	config: AgentProviderRuntimeConfig;
}

/**
 * 各家构造所需的最小 config —— 逐条对着 `factory.ts` 的注册块读出来的:
 * OAuth 家族(kimi-code / grok-oauth / github-copilot)走
 * `accessTokenFromRuntimeConfig`,凭证只能挂在 `authContext.token` 或
 * `oauthToken` 上(`apiKey` 对它们恒为空);带私有旋钮的(kimi / zhipu / qwen)
 * 的地址由 `providerOptions` 决定。
 */
const PROVIDERS: Record<OpenAIChatProviderId, ProviderFixture> = {
	openai: {
		model: "gpt-5.5",
		config: { apiKey: "sk-openai-fixture" },
	},
	deepseek: {
		model: "deepseek-v4-flash",
		config: { apiKey: "sk-deepseek-fixture" },
	},
	kimi: {
		model: "kimi-k2.6",
		config: {
			apiKey: "sk-kimi-fixture",
			providerOptions: { kimiApiMode: "standard", kimiRegion: "cn" },
		},
	},
	"kimi-code": {
		model: "k3",
		config: {
			authContext: {
				kind: "oauth",
				token: { accessToken: "kimi-code-access-token" },
			},
		},
	},
	zhipu: {
		model: "glm-5",
		config: {
			apiKey: "sk-zhipu-fixture",
			providerOptions: { zhipuApiMode: "standard" },
		},
	},
	qwen: {
		model: "qwen3.8-max",
		config: {
			apiKey: "sk-qwen-fixture",
			providerOptions: { qwenApiMode: "standard", qwenRegion: "cn" },
		},
	},
	grok: {
		model: "grok-4.6",
		config: { apiKey: "sk-grok-fixture" },
	},
	"grok-oauth": {
		model: "grok-4.6",
		config: {
			authContext: {
				kind: "oauth",
				token: { accessToken: "grok-oauth-access-token" },
			},
		},
	},
	openrouter: {
		model: "openai/gpt-5.5",
		config: { apiKey: "sk-openrouter-fixture" },
	},
	"github-copilot": {
		model: "gpt-5.5",
		config: {
			authContext: {
				kind: "oauth",
				token: { accessToken: "gho-copilot-fixture" },
			},
		},
	},
	"custom-acme": {
		model: "acme-chat-1",
		config: {
			apiKey: "sk-custom-fixture",
			apiType: "openai",
			baseUrl: "https://acme.example.com/v1",
		},
	},
};

/**
 * OpenRouter 上一个「能聊天又能出图」的模型 —— 图像输出两个用例共用。
 * 账本对 openrouter 的 `imageOutput` 只认目录条目(名字正则不管这一家),
 * 所以两处都得把 `models[…].supportsImageOutput` 传进去。
 */
const OPENROUTER_IMAGE_MODEL = "google/gemini-2.5-flash-image";

const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";

/**
 * 按 URL 分派的 fetch 桩:github-copilot 的 `resolveAuth` 会先去 GitHub 换一个
 * completion token,那一跳必须先答上,chat 请求才发得出去。
 */
const createFetchStub = ((
	chatResponse: () => Response,
	onChatRequest?: (init: RequestInit | undefined) => void,
) =>
	(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = requestUrl(input);
		if (url.startsWith(COPILOT_TOKEN_URL)) {
			return new Response(
				JSON.stringify({ token: "copilot-completion-token", expires_in: 1800 }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}
		onChatRequest?.(init);
		return chatResponse();
	}) as typeof globalThis.fetch) satisfies WireFetchStubFactory;

/** 请求体用例只关心「发出去什么」,流内容取最短的一条合法流。 */
const MINIMAL_STREAM = `data: ${JSON.stringify({
	choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
})}\n\ndata: [DONE]\n\n`;

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
	{
		role: "tool",
		toolCallId: "call_read",
		content: "hello from a.txt",
	},
	{ role: "user", content: "总结一下。" },
];

type RequestCase = Omit<AgentTurnRequest, "model" | "turn">;

/**
 * 五个用例,按互不干扰的维度叠加:
 *  - `baseline`            —— 消息形状 + 固定字段(stream / stream_options),thinking 不传
 *  - `tools-auto-thinking-high` —— 工具表 + toolChoice auto + thinking on/high
 *                                 + maxTokens(检验 maxTokensField)
 *                                 + temperature(检验 thinking on 时被丢掉)
 *  - `tools-named-thinking-max` —— 指名函数的 toolChoice + effort 'max' 的各家钳位
 *  - `thinking-off-multimodal`  —— thinking off + 多模态三块 + temperature 保留
 *  - `history-tool-roundtrip`   —— assistant.reasoningContent 回传 + tool 消息形状
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
	"history-tool-roundtrip": {
		messages: HISTORY_MESSAGES,
		tools: TOOLS,
	},
};

function fixturePath(providerId: string, file: string): string {
	return fixtureFile(FIXTURE_ROOT, providerId, file);
}

function readFixture(providerId: string, file: string): string {
	return readFixtureFile(FIXTURE_ROOT, providerId, file);
}

function runtimeConfig(
	providerId: OpenAIChatProviderId,
	model: string = PROVIDERS[providerId].model,
): AgentProviderRuntimeConfig {
	return { ...PROVIDERS[providerId].config, model };
}

/** 构造 provider —— 走生产入口,覆盖层(withPerModelCapabilities)也在里面。 */
function buildProvider(
	providerId: OpenAIChatProviderId,
	fetchImpl: typeof globalThis.fetch,
	requestDumper?: AgentProviderRequestDumper,
) {
	return createRuntimeProvider(providerId, runtimeConfig(providerId), {
		fetchImpl,
		requestDumper,
	});
}

/**
 * 截获出站请求。
 *
 * **`requestBody` 取的是 `fetchImpl` 真收到的 `init.body`**(线上字节),
 * 不是 dumper 那份:落盘的那份从 P0b-A 起走 `RequestBodyBuilder.forDump()`
 * (data-URI 截断),它是**排障视图**,不是线上事实。dump 的其余字段
 * (`providerId` / `model` / `mode` / `metadata.url|method|turn`)照旧进快照,
 * 由同一份 fixture 一并守着。
 */
async function captureRequest(
	providerId: OpenAIChatProviderId,
	request: RequestCase,
	model: string = PROVIDERS[providerId].model,
): Promise<AgentProviderRequestDump> {
	return captureWireRequest({
		providerId,
		config: runtimeConfig(providerId, model),
		request: { ...request, model, turn: 1 },
		respond: () => sseResponse(MINIMAL_STREAM),
		fetchStub: createFetchStub,
	});
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("openai-chat wire snapshots — request bodies", () => {
	for (const providerId of OPENAI_CHAT_PROVIDER_IDS) {
		describe(providerId, () => {
			for (const [caseName, request] of Object.entries(REQUEST_CASES)) {
				it(caseName, async () => {
					const dump = await captureRequest(providerId, request);
					await expect(snapshotJson(dump)).toMatchFileSnapshot(
						fixturePath(providerId, `${caseName}.request.json`),
					);
				});
			}
		});
	}

	/**
	 * DeepSeek 是唯一会**从模型名推断** thinking 的:调用方什么都不说时,
	 * reasoner 类模型自己打开思考,其它模型什么都不发。基线里 baseline 用的是
	 * `deepseek-v4-flash`(推断为 enabled),这里补一条 `deepseek-chat` 的对照。
	 */
	/**
	 * 落盘的那份**不是**线上那份:`RequestBodyBuilder.forDump()` 把 data URI 的
	 * base64 载荷换成一行摘要(真机上 provider dump 曾写出 1.1G)。这条门守着
	 * 「两份确实不同,且线上那份没被截断」—— 上面所有 `*.request.json` 记的都是
	 * 线上那份。
	 */
	it("dump 截断 data URI,线上字节不受影响", async () => {
		const dumps: AgentProviderRequestDump[] = [];
		const wireBodies: unknown[] = [];
		const provider = buildProvider(
			"openai",
			createFetchStub(
				() => sseResponse(MINIMAL_STREAM),
				(init) => {
					wireBodies.push(JSON.parse(String(init?.body ?? "null")));
				},
			),
			async (dump) => {
				dumps.push(dump);
				return "/tmp/onething-dump.json";
			},
		);
		await drain(
			provider.streamTurn({
				messages: [SYSTEM_MESSAGE, MULTIMODAL_USER_MESSAGE],
				model: PROVIDERS.openai.model,
				turn: 1,
			}),
		);

		const dumped = JSON.stringify(dumps[0]!.requestBody);
		expect(dumped).toContain("<data-uri:image/png ");
		expect(dumped).not.toContain("iVBORw0KGgoAAAANSUhEUg==");
		expect(JSON.stringify(wireBodies[0])).toContain(
			"data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
		);
	});

	/**
	 * OpenRouter 的图像输出(P3-2)。`modalities: ['text','image']` 只在账本判出
	 * 「这个模型在回合内出图」时才发 —— 判据是 `ModelProfile.imageOutput.servedBy
	 * === 'in-loop'`(openrouter 家 + `supportsImageOutput`)。上面五个用例的模型
	 * `openai/gpt-5.5` 不出图,那五份 fixture 因此一个字节都没变。
	 */
	it("openrouter — image output adds `modalities`", async () => {
		const dump = await captureWireRequest({
			providerId: "openrouter",
			config: {
				...PROVIDERS.openrouter.config,
				model: OPENROUTER_IMAGE_MODEL,
				models: { [OPENROUTER_IMAGE_MODEL]: { supportsImageOutput: true } },
			},
			request: {
				messages: [SYSTEM_MESSAGE, { role: "user", content: "画一轮月亮。" }],
				model: OPENROUTER_IMAGE_MODEL,
				turn: 1,
			},
			respond: () => sseResponse(MINIMAL_STREAM),
			fetchStub: createFetchStub,
		});
		await expect(snapshotJson(dump)).toMatchFileSnapshot(
			fixturePath("openrouter", "image-output.request.json"),
		);
	});

	/**
	 * 请求级 providerOptions 袋(P3-3)。上面五个用例**不带袋**,所以那批 fixture
	 * 一个字节都没变;袋是这一条独有的输入。
	 *
	 * 三件事一份 fixture 一起守:白名单里的 `verbosity` 上顶层、`imageDetail`
	 * 进每个 `image_url.detail`、白名单外的 `unknownKey` 一个字都不出现
	 * (它被丢弃时留的那条 `setting-dropped` 在 `wires/__tests__/provider-options.test.ts`
	 * 里断)。
	 */
	it("openai — request providerOptions bag", async () => {
		const dump = await captureRequest("openai", {
			messages: [SYSTEM_MESSAGE, MULTIMODAL_USER_MESSAGE],
			providerOptions: {
				openai: { verbosity: "low", imageDetail: "low", unknownKey: 1 },
			},
		});
		const body = JSON.stringify(dump.requestBody);
		expect(body).toContain('"verbosity":"low"');
		expect(body).toContain('"detail":"low"');
		expect(body).not.toContain("unknownKey");
		await expect(snapshotJson(dump)).toMatchFileSnapshot(
			fixturePath("openai", "provider-options.request.json"),
		);
	});

	it("deepseek — thinking-unset on a non-reasoner model", async () => {
		const dump = await captureRequest(
			"deepseek",
			{ messages: [SYSTEM_MESSAGE, USER_MESSAGE] },
			"deepseek-chat",
		);
		await expect(snapshotJson(dump)).toMatchFileSnapshot(
			fixturePath("deepseek", "baseline-deepseek-chat.request.json"),
		);
	});
});

describe("openai-chat wire snapshots — stream parsing", () => {
	for (const providerId of OPENAI_CHAT_PROVIDER_IDS) {
		it(`${providerId} — sse.txt → events`, async () => {
			const provider = buildProvider(
				providerId,
				createFetchStub(() => sseResponse(readFixture(providerId, "sse.txt"))),
			);
			const events = await drain(
				provider.streamTurn({
					messages: [SYSTEM_MESSAGE, USER_MESSAGE],
					tools: TOOLS,
					model: PROVIDERS[providerId].model,
					turn: 1,
				}),
			);
			await expect(snapshotJson(events)).toMatchFileSnapshot(
				fixturePath(providerId, "events.json"),
			);
		});
	}

	/**
	 * OpenRouter 的上游有的发 `reasoning_content`、有的发统一的 `reasoning`。
	 * 适配层两个都读(`delta.reasoning_content ?? delta.reasoning`),两份都记。
	 */
	/**
	 * OpenRouter 的图像输出(P3-2)。
	 *
	 * ⚠️ **流式的 `delta.images` 在 OpenRouter 的 OpenAPI 里没有声明**;
	 * `sse-image.txt` 里那一块是按**非流式** `choices[].message.images[]` 的项
	 * 形状(`{type:'image_url', image_url:{url}}`,`url` 为 data URL)假定手写的
	 * —— **待真机核**。解析两种落点都认(见 `dialects/openrouter.ts`)。
	 *
	 * 这份快照只到 **provider 事件层**:`saveMediaImage` 在引擎那一侧
	 * (`provider-data.ts`),这里不会被调到。
	 */
	it("openrouter — `images[]` → provider-data", async () => {
		const provider = createRuntimeProvider(
			"openrouter",
			{
				...PROVIDERS.openrouter.config,
				model: OPENROUTER_IMAGE_MODEL,
				models: { [OPENROUTER_IMAGE_MODEL]: { supportsImageOutput: true } },
			},
			{
				fetchImpl: createFetchStub(() =>
					sseResponse(readFixture("openrouter", "sse-image.txt")),
				),
			},
		);
		const events = await drain(
			provider.streamTurn({
				messages: [SYSTEM_MESSAGE, { role: "user", content: "画一轮月亮。" }],
				model: OPENROUTER_IMAGE_MODEL,
				turn: 1,
			}),
		);
		await expect(snapshotJson(events)).toMatchFileSnapshot(
			fixturePath("openrouter", "events-image.json"),
		);
	});

	it("openrouter — unified `reasoning` field", async () => {
		const provider = buildProvider(
			"openrouter",
			createFetchStub(() =>
				sseResponse(readFixture("openrouter", "sse-reasoning-field.txt")),
			),
		);
		const events = await drain(
			provider.streamTurn({
				messages: [SYSTEM_MESSAGE, USER_MESSAGE],
				tools: TOOLS,
				model: PROVIDERS.openrouter.model,
				turn: 1,
			}),
		);
		await expect(snapshotJson(events)).toMatchFileSnapshot(
			fixturePath("openrouter", "events-reasoning-field.json"),
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

describe("openai-chat wire snapshots — HTTP errors", () => {
	for (const providerId of OPENAI_CHAT_PROVIDER_IDS) {
		it(`${providerId} — 429 + retry-after`, async () => {
			vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW);
			const provider = buildProvider(
				providerId,
				createFetchStub(
					() =>
						new Response(ERROR_BODY, {
							status: 429,
							headers: {
								"content-type": "application/json",
								"retry-after": "15",
							},
						}),
				),
			);
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
				fixturePath(providerId, "error.json"),
			);
		});
	}
});

describe("openai-chat wire snapshots — fixture inventory", () => {
	it("every listed id is a supported runtime provider", () => {
		for (const providerId of OPENAI_CHAT_PROVIDER_IDS) {
			expect(
				isAgentProviderRuntimeSupported(providerId),
				`${providerId} is not a supported agent provider runtime`,
			).toBe(true);
		}
	});

	it("every listed id has a non-empty fixture directory", () => {
		expectFixtureDirectories(FIXTURE_ROOT, OPENAI_CHAT_PROVIDER_IDS);
	});
});
