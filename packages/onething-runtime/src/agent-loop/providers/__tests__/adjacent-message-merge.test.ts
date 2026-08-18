/**
 * 相邻同角色消息合并(C5,2026-08-14)。
 *
 * 压缩摘要的注入从「一条 user + 一条伪造的 assistant 握手」改成只有一条 user
 * 之后,注入的摘要会与被保留的最近一轮真 user 消息相邻 —— 而 DeepSeek 系严格
 * 要求 user/assistant 交替。这里钉的是那条兜底真的落在**传输层**:
 *
 *  1. 纯函数的合并规则(合谁、不合谁、内容怎么接);
 *  2. 严格交替的 provider 发出去的请求体里,连续两条 user 已经是一条。
 */
import { describe, expect, it } from "vitest";
import type {
	AgentMessage,
	AgentTurnRequest,
	AgentTurnStreamEvent,
} from "@onething/core/agent-loop";
import { mergeAdjacentSameRoleMessages } from "../message-merge.js";
import { createDeepSeekAgentProvider } from "../deepseek.js";
import { createOpenAICompatibleAgentProvider } from "../openai-compatible.js";
import { createClaudeAgentProvider } from "../claude.js";

const COMPACT_SUMMARY_USER =
	"The conversation history before this point was compacted into the following summary:\n\n<summary>\nEarlier work\n</summary>";

function sseResponse(dataLines: string[]): Response {
	return new Response(
		[...dataLines.map((line) => `data: ${line}`), "data: [DONE]", ""].join(
			"\n\n",
		),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

async function drain(events: AsyncIterable<AgentTurnStreamEvent>) {
	for await (const _event of events) {
		// The stream body is irrelevant here — the request body is the subject.
	}
}

/** 压缩注入之后的真实形态:摘要 user 紧跟着被保留的最近一轮 user。 */
const compactedMessages: AgentMessage[] = [
	{ role: "system", content: "sys" },
	{ role: "user", content: COMPACT_SUMMARY_USER },
	{ role: "user", content: "接着上面继续" },
];

function requestWith(messages: AgentMessage[]): AgentTurnRequest {
	return { turn: 1, model: "test-model", messages } as AgentTurnRequest;
}

describe("mergeAdjacentSameRoleMessages", () => {
	it("合并相邻 user,内容以 \\n\\n 连接", () => {
		expect(mergeAdjacentSameRoleMessages(compactedMessages)).toEqual([
			{ role: "system", content: "sys" },
			{ role: "user", content: `${COMPACT_SUMMARY_USER}\n\n接着上面继续` },
		]);
	});

	it("三条以上连续同角色一路合成一条", () => {
		const merged = mergeAdjacentSameRoleMessages([
			{ role: "user", content: "a" },
			{ role: "user", content: "b" },
			{ role: "user", content: "c" },
			{ role: "assistant", content: "ok" },
		]);
		expect(merged).toEqual([
			{ role: "user", content: "a\n\nb\n\nc" },
			{ role: "assistant", content: "ok" },
		]);
	});

	it("带协议载荷的一条都不合:toolCalls / toolCallId / providerData / reasoning", () => {
		const withToolCalls: AgentMessage[] = [
			{
				role: "assistant",
				content: "",
				toolCalls: [{ id: "c1", name: "read", arguments: "{}" }],
			},
			{ role: "assistant", content: "after" },
		];
		expect(mergeAdjacentSameRoleMessages(withToolCalls)).toEqual(withToolCalls);

		const toolMessages: AgentMessage[] = [
			{ role: "tool", content: "r1", toolCallId: "c1" },
			{ role: "tool", content: "r2", toolCallId: "c2" },
		];
		expect(mergeAdjacentSameRoleMessages(toolMessages)).toEqual(toolMessages);

		const systemMessages: AgentMessage[] = [
			{ role: "system", content: "one" },
			{ role: "system", content: "two" },
		];
		expect(mergeAdjacentSameRoleMessages(systemMessages)).toEqual(
			systemMessages,
		);

		const withProviderData: AgentMessage[] = [
			{
				role: "assistant",
				content: "kept",
				providerData: [
					{
						provider: "codex",
						type: "encrypted-reasoning",
						encryptedContent: "x",
					} as never,
				],
			},
			{ role: "assistant", content: "next" },
		];
		expect(mergeAdjacentSameRoleMessages(withProviderData)).toEqual(
			withProviderData,
		);
	});

	it("多模态内容归一成 parts 数组拼接,图片不会被压成文本丢掉", () => {
		const merged = mergeAdjacentSameRoleMessages([
			{ role: "user", content: "look at this" },
			{
				role: "user",
				content: [{ type: "image", image: "data:image/png;base64,AAA" }],
			},
		]);
		expect(merged).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "look at this" },
					{ type: "image", image: "data:image/png;base64,AAA" },
				],
			},
		]);
	});
});

describe("严格交替的 provider 请求体里没有连续两条 user", () => {
	it("deepseek", async () => {
		let body: { messages: Array<{ role: string; content: string }> } | undefined;
		const provider = createDeepSeekAgentProvider({
			apiKey: "sk-test",
			fetchImpl: async (_url: unknown, init: { body?: string } = {}) => {
				body = JSON.parse(init.body ?? "{}");
				return sseResponse([]);
			},
		} as never);

		await drain(provider.streamTurn!(requestWith(compactedMessages)));

		expect(body?.messages.map((message) => message.role)).toEqual([
			"system",
			"user",
		]);
		expect(body?.messages[1].content).toBe(
			`${COMPACT_SUMMARY_USER}\n\n接着上面继续`,
		);
	});

	it("openai-compatible", async () => {
		let body: { messages: Array<{ role: string }> } | undefined;
		const provider = createOpenAICompatibleAgentProvider({
			apiKey: "sk-test",
			baseUrl: "https://example.test/v1",
			fetchImpl: async (_url: unknown, init: { body?: string } = {}) => {
				body = JSON.parse(init.body ?? "{}");
				return sseResponse([]);
			},
		} as never);

		await drain(provider.streamTurn!(requestWith(compactedMessages)));

		expect(body?.messages.map((message) => message.role)).toEqual([
			"system",
			"user",
		]);
	});

	it("claude", async () => {
		let body: { messages: Array<{ role: string }> } | undefined;
		const provider = createClaudeAgentProvider({
			apiKey: "sk-test",
			fetchImpl: async (_url: unknown, init: { body?: string } = {}) => {
				body = JSON.parse(init.body ?? "{}");
				return sseResponse([]);
			},
		} as never);

		await drain(provider.streamTurn!(requestWith(compactedMessages)));

		// system 走 body.system,messages 里只剩合并后的那一条 user。
		expect(body?.messages.map((message) => message.role)).toEqual(["user"]);
	});
});
