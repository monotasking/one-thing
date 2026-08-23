/**
 * P1 第 ① 道门 —— anthropic-messages 线协议的**逐字节基线**。
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
 * API 不是行为,逐字节盯 key 顺序只会逼着迁移去复刻偶然顺序。所以序列化前对
 * 对象做递归 key 排序 —— **数组元素顺序不动**(那是真行为:消息次序、内容块
 * 次序、工具表次序、流事件次序)。`sse.txt` 是输入,原样不动。
 *
 * ## 覆盖面
 *
 * anthropic-messages 线协议上的三个 id(见 `ANTHROPIC_PROVIDER_IDS`):
 *  - `claude`               —— 官方端点,`promptCaching: true`,带 `x-api-key`
 *  - `claude-code`          —— OAuth 那条(`omitApiKeyHeader` + `systemHeader`
 *                              + beta 头),同样 `promptCaching: true`
 *  - `custom-acme-anthropic` —— `custom-*` + `apiType: 'anthropic'`,走
 *                              `createCustomAgentProviderFromRuntime`;
 *                              **它没有 promptCaching**,所以 `cache_control`
 *                              在它的快照里应当一个都不出现
 *
 * 全部经**生产入口** `createAgentProviderFromRuntime` 构造 —— 覆盖层
 * (`withPerModelCapabilities`)也在里面。
 *
 * 每家六个请求体用例(见 `REQUEST_CASES` 的注释),claude 额外四条守着这条线
 * 上最容易迁移错的分支:
 *  - `thinking-xhigh.claude-opus-4-6`   —— adaptive 家族但 **不支持 xhigh**
 *    (`claudeEffort` 把 xhigh 钳成 high),且 `samplingRemoved: false`
 *  - `thinking-high.claude-opus-4-1`    —— **budget 线型**:`thinking:
 *    {type:'enabled', budget_tokens}` + max_tokens 被顶到 budget + 4096
 *    (`claude-opus-4-6` 已经是 adaptive 了,budget 线型必须另找一个模型才录得到)
 *  - `thinking-high.claude-3-7-sonnet`  —— 老式带日期的 id(版本在前、日期在后)
 *    必须读出 3.7:budget 线型 + temperature 照发(#11 修好之前,日期段被当成
 *    版本号读成 major=20250219,于是 3.7 被判成 adaptive + samplingRemoved)
 *  - `prompt-caching-no-system`         —— 没有 system 时,缓存断点落在**工具表
 *    最后一项**上(有 system 时落在 system 上),外加会话尾部那个滑动断点
 *  - `history-thinking-unset`           —— 思考回放块是 `thinking === 'enabled'`
 *    **才**拼进去的:同一段历史在 thinking 不传时,签名块整批消失
 *
 * ## 不稳定字段
 *
 * - `error.json` 里的 `retryAfterAt` 是 `Date.now() + retry-after`。错误用例把
 *   `Date.now` 钉在 `FIXED_NOW`(2023-11-14T22:13:20.000Z),所以快照里的
 *   1700000015000 = FIXED_NOW + 15s,是确定值。
 * - 其余快照没有时间戳/随机 id:tool_use id 来自手写的 `sse.txt`,`turn` 固定为 1。
 *
 * `sse.txt` 是**手写的输入 fixture**(不是快照),形状照 Anthropic 真实的线上流:
 * `message_start`(带 input / cache_read / cache_creation usage)→
 * content_block_start/delta(thinking_delta + signature_delta / text_delta /
 * 两个工具的 input_json_delta)→ content_block_stop → `message_delta`
 * (stop_reason + 累计 usage 的 output_tokens)→ message_stop。
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
	new URL("./__fixtures__/anthropic", import.meta.url),
);

/** 每个 id 的 fixture 目录名 = id 本身。 */
export const ANTHROPIC_PROVIDER_IDS = [
	"claude",
	"claude-code",
	"custom-acme-anthropic",
] as const;

type AnthropicProviderId = (typeof ANTHROPIC_PROVIDER_IDS)[number];

interface ProviderFixture {
	model: string;
	config: AgentProviderRuntimeConfig;
}

/**
 * 各家构造所需的最小 config —— 逐条对着 `factory.ts` 的注册块读出来的:
 * `claude-code` 走 `accessTokenFromRuntimeConfig`(凭证只能挂在
 * `authContext.token` 或 `oauthToken` 上),`custom-*` 靠 `apiType: 'anthropic'`
 * 才落到 `createClaudeAgentProvider` 上。
 */
const PROVIDERS: Record<AnthropicProviderId, ProviderFixture> = {
	claude: {
		model: "claude-sonnet-5",
		config: { apiKey: "sk-anthropic-fixture" },
	},
	"claude-code": {
		model: "claude-sonnet-5",
		config: {
			authContext: {
				kind: "oauth",
				token: { accessToken: "claude-code-access-token" },
			},
		},
	},
	"custom-acme-anthropic": {
		model: "claude-sonnet-5",
		config: {
			apiKey: "sk-custom-anthropic-fixture",
			apiType: "anthropic",
			baseUrl: "https://acme.example.com/anthropic/v1",
		},
	},
};

/** 请求体用例只关心「发出去什么」,流内容取最短的一条合法流。 */
const MINIMAL_STREAM = [
	`event: message_start\ndata: ${JSON.stringify({
		type: "message_start",
		message: { usage: { input_tokens: 1, output_tokens: 1 } },
	})}`,
	`event: message_delta\ndata: ${JSON.stringify({
		type: "message_delta",
		delta: { stop_reason: "end_turn" },
		usage: { output_tokens: 2 },
	})}`,
	`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
].join("\n\n");

/**
 * 带 provider 回放载荷的历史。
 *
 * `claudeThinkingReplayBlocks` 只读 `providerData` 里 `provider === 'claude'`
 * 的两种记录:`type: 'thinking'`(要有非空 `signature`)与
 * `type: 'redacted-thinking'`(要有非空 `data`)。`reasoningContent` 这条线
 * **不看** —— 所以这里两样都造上,让快照把「读哪个字段」钉死。
 *
 * 第二个工具结果带 `isError: true`,守着 `tool_result.is_error`(没有它,
 * 失败的工具在模型眼里就是一条「内容碰巧在讲问题」的成功结果)。
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
				provider: "claude",
				type: "thinking",
				thinking: "先确认文件存在，再决定要不要写。",
				signature: "sig-fixture-0001",
			},
			{
				provider: "claude",
				type: "redacted-thinking",
				data: "redacted-fixture-0001",
			},
		],
		toolCalls: [
			{ id: "toolu_read", name: "read_file", arguments: '{"path":"a.txt"}' },
			{
				id: "toolu_write",
				name: "write_file",
				arguments: '{"path":"b.txt","content":"done"}',
			},
		],
	},
	{ role: "tool", toolCallId: "toolu_read", content: "hello from a.txt" },
	{
		role: "tool",
		toolCallId: "toolu_write",
		content: "EACCES: permission denied, open 'b.txt'",
		isError: true,
	},
	{ role: "user", content: "总结一下。" },
];

type RequestCase = Omit<AgentTurnRequest, "model" | "turn">;

/**
 * 六个用例,按互不干扰的维度叠加(不做笛卡尔积):
 *  - `baseline`                 —— 消息形状 + 固定字段(stream),thinking 不传
 *  - `tools-auto-thinking-high` —— 工具表 + tool_choice auto + thinking on/high
 *                                  + maxTokens + temperature(检验 thinking on
 *                                  时 temperature 被丢掉)
 *  - `tools-named-thinking-max` —— 指名函数的 tool_choice + effort 'max'
 *  - `thinking-off-multimodal`  —— thinking off(adaptive 家族要显式发
 *                                  `{type:'disabled'}`)+ 图片/PDF 内容块
 *  - `thinking-unset`           —— 什么都不说:thinking 键整个不出现,而
 *                                  temperature 在 samplingRemoved 家族上照样被丢
 *  - `history-tool-roundtrip`   —— 思考签名块回放 + 两个 tool_use + 两条
 *                                  tool_result(其中一条 is_error)
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
		thinking: "enabled",
		reasoningEffort: "high",
	},
};

function fixturePath(providerId: string, file: string): string {
	return fixtureFile(FIXTURE_ROOT, providerId, file);
}

function readFixture(providerId: string, file: string): string {
	return readFixtureFile(FIXTURE_ROOT, providerId, file);
}

function runtimeConfig(
	providerId: AnthropicProviderId,
	model: string = PROVIDERS[providerId].model,
): AgentProviderRuntimeConfig {
	return { ...PROVIDERS[providerId].config, model };
}

/** 构造 provider —— 走生产入口,覆盖层(withPerModelCapabilities)也在里面。 */
function buildProvider(
	providerId: AnthropicProviderId,
	fetchImpl: typeof globalThis.fetch,
) {
	return createRuntimeProvider(providerId, runtimeConfig(providerId), {
		fetchImpl,
	});
}

/**
 * 截获出站请求。
 *
 * **`requestBody` 取的是 `fetchImpl` 真收到的 `init.body`**(线上字节),不是
 * dumper 那份 —— 落盘那份是排障视图。dump 的其余字段(`providerId` / `model` /
 * `mode` / `metadata.url|method|turn`)照旧进快照,由同一份 fixture 一并守着。
 */
async function captureRequest(
	providerId: AnthropicProviderId,
	request: RequestCase,
	model: string = PROVIDERS[providerId].model,
): Promise<AgentProviderRequestDump> {
	return captureWireRequest({
		providerId,
		config: runtimeConfig(providerId, model),
		request: { ...request, model, turn: 1 },
		respond: () => sseResponse(MINIMAL_STREAM),
	});
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("anthropic-messages wire snapshots — request bodies", () => {
	for (const providerId of ANTHROPIC_PROVIDER_IDS) {
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
	 * `claude-opus-4-6` 也是 adaptive(4.6 起),但它 **不是 modern**:
	 * `supportsXhigh: false` 把 xhigh 钳成 high,`samplingRemoved: false` ——
	 * 于是 temperature 之所以还是没了,原因只剩「thinking 开着」这一条。
	 */
	it("claude — thinking xhigh on claude-opus-4-6 (adaptive, no xhigh)", async () => {
		const dump = await captureRequest(
			"claude",
			{
				messages: [SYSTEM_MESSAGE, USER_MESSAGE],
				tools: TOOLS,
				toolChoice: "auto",
				thinking: "enabled",
				reasoningEffort: "xhigh",
				temperature: 0.3,
				maxTokens: 1234,
			},
			"claude-opus-4-6",
		);
		await expect(snapshotJson(dump)).toMatchFileSnapshot(
			fixturePath("claude", "thinking-xhigh.claude-opus-4-6.request.json"),
		);
	});

	/**
	 * **budget 线型**(4.6 以下):`thinking: {type:'enabled', budget_tokens}`,
	 * 且 `budget_tokens` 必须小于 `max_tokens` —— 这里 maxTokens 1234 会被顶成
	 * budget + 4096。
	 */
	it("claude — thinking high on claude-opus-4-1 (budget wire)", async () => {
		const dump = await captureRequest(
			"claude",
			{
				messages: [SYSTEM_MESSAGE, USER_MESSAGE],
				tools: TOOLS,
				toolChoice: "auto",
				thinking: "enabled",
				reasoningEffort: "high",
				temperature: 0.3,
				maxTokens: 1234,
			},
			"claude-opus-4-1",
		);
		await expect(snapshotJson(dump)).toMatchFileSnapshot(
			fixturePath("claude", "thinking-high.claude-opus-4-1.request.json"),
		);
	});

	/**
	 * #11 —— 老式 id 把版本放在名字前、日期放在最后。修好之前
	 * `onethingClaudeModelFamily` 先试 `/(?:opus|sonnet|haiku)-(\d+)…/`,
	 * `claude-3-7-sonnet-20250219` 的 `sonnet-20250219` 当场把 major 读成
	 * 20250219,后面那条 `claude-(\d+)` 兜底永远轮不上,于是一个 3.7 的模型被
	 * 判成 adaptive + modern(temperature 也被当作已移除)。现在它读回 3.7:
	 * **budget 线型**(`thinking:{type:'enabled', budget_tokens}` + max_tokens
	 * 被顶到 budget + 4096),`samplingRemoved: false` —— temperature 之所以
	 * 还是没了,原因只剩「thinking 开着」这一条。
	 */
	it("claude — legacy dated id claude-3-7-sonnet reads as 3.7 (budget wire)", async () => {
		const dump = await captureRequest(
			"claude",
			{
				messages: [SYSTEM_MESSAGE, USER_MESSAGE],
				tools: TOOLS,
				toolChoice: "auto",
				thinking: "enabled",
				reasoningEffort: "high",
				temperature: 0.3,
				maxTokens: 1234,
			},
			"claude-3-7-sonnet-20250219",
		);
		await expect(snapshotJson(dump)).toMatchFileSnapshot(
			fixturePath("claude", "thinking-high.claude-3-7-sonnet.request.json"),
		);
	});

	/**
	 * 没有 system 消息时,第一个缓存断点改落在**工具表最后一项**上;第二个
	 * (滑动的那个)照旧落在会话最后一条消息的最后一个内容块上。
	 */
	it("claude — prompt cache breakpoints without a system prompt", async () => {
		const dump = await captureRequest("claude", {
			messages: [USER_MESSAGE],
			tools: TOOLS,
			toolChoice: "auto",
		});
		await expect(snapshotJson(dump)).toMatchFileSnapshot(
			fixturePath("claude", "prompt-caching-no-system.request.json"),
		);
	});

	/**
	 * 思考回放块的开关是 `request.thinking === 'enabled'`,不是「历史里有没有」:
	 * 同一段历史,thinking 不传时签名块整批不出现。
	 */
	it("claude — thinking replay blocks vanish when thinking is unset", async () => {
		const dump = await captureRequest("claude", {
			messages: HISTORY_MESSAGES,
			tools: TOOLS,
		});
		await expect(snapshotJson(dump)).toMatchFileSnapshot(
			fixturePath("claude", "history-thinking-unset.request.json"),
		);
	});
});

describe("anthropic-messages wire snapshots — stream parsing", () => {
	for (const providerId of ANTHROPIC_PROVIDER_IDS) {
		it(`${providerId} — sse.txt → events`, async () => {
			const provider = buildProvider(providerId, (async () =>
				sseResponse(
					readFixture(providerId, "sse.txt"),
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
				fixturePath(providerId, "events.json"),
			);
		});
	}
});

const ERROR_BODY = JSON.stringify({
	type: "error",
	error: {
		type: "rate_limit_error",
		message: "Number of request tokens has exceeded your per-minute rate limit",
	},
});

describe("anthropic-messages wire snapshots — HTTP errors", () => {
	for (const providerId of ANTHROPIC_PROVIDER_IDS) {
		it(`${providerId} — 429 + retry-after`, async () => {
			vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW);
			const provider = buildProvider(providerId, (async () =>
				jsonResponse(ERROR_BODY, {
					status: 429,
					headers: { "retry-after": "15" },
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
				fixturePath(providerId, "error.json"),
			);
		});
	}
});

describe("anthropic-messages wire snapshots — fixture inventory", () => {
	it("every listed id is a supported runtime provider", () => {
		for (const providerId of ANTHROPIC_PROVIDER_IDS) {
			expect(
				isAgentProviderRuntimeSupported(providerId),
				`${providerId} is not a supported agent provider runtime`,
			).toBe(true);
		}
	});

	it("every listed id has a non-empty fixture directory", () => {
		expectFixtureDirectories(FIXTURE_ROOT, ANTHROPIC_PROVIDER_IDS);
	});
});
