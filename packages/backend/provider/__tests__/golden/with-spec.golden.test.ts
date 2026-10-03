/**
 * golden 另一半(§7.2):**有 spec** 时,同一批夹具经 `dialectFromSpec` 编译出来的方言解出思考增量
 * 与 usage —— 而且是经工厂的真路(manifest 指 `custom:<id>` → 工厂认它)。
 */
import { afterAll, describe, expect, it } from "vitest";
import type { CustomAdapterSpec } from "@shared/contracts/adapter-spec";
import { registerCustomProvidersForTest } from "../custom-manifest-fixture.js";
import { registerDialect } from "../../base/dialect.js";
import {
	dialectFromSpec,
	unsupportedAdapterSpecFields,
} from "../../dialects/custom-from-spec.js";
import { runGolden, type GoldenFixture } from "./golden-harness.js";

const undo: Array<() => void> = [];
function withAdapter(id: string, adapter: CustomAdapterSpec): string {
	undo.push(registerDialect(dialectFromSpec(id, adapter)));
	undo.push(registerCustomProvidersForTest([{ id, adapter }]));
	return id;
}
afterAll(() => {
	for (const fn of undo.reverse()) fn();
});

function reasoningOf(events: Awaited<ReturnType<typeof runGolden>>["events"]): string {
	return events.flatMap((e) => (e.type === "reasoning-delta" ? [e.delta] : [])).join("");
}
function textOf(events: Awaited<ReturnType<typeof runGolden>>["events"]): string {
	return events.flatMap((e) => (e.type === "text-delta" ? [e.delta] : [])).join("");
}
function finishOf(events: Awaited<ReturnType<typeof runGolden>>["events"]) {
	const finish = events.find((e) => e.type === "finish");
	if (finish?.type !== "finish") throw new Error("no finish");
	return finish;
}

describe("golden:有 spec", () => {
	it("thinking-field:默认读不出的 `delta.thinking` 与 `input_tokens` 形 usage,spec 之后都解得出", async () => {
		const id = withAdapter("custom-golden-thinking", {
			version: 1,
			wire: "openai-chat",
			response: {
				reasoningDeltaPath: "choices[0].delta.thinking",
				usage: { input: "input_tokens", output: "output_tokens", cacheRead: "cache_read_tokens" },
				doneMarker: null,
			},
		});
		const { events } = await runGolden(id, "thinking-field");
		expect(reasoningOf(events)).toBe("先想一想。");
		expect(textOf(events)).toBe("好的。");
		expect(finishOf(events).usage).toMatchObject({ inputTokens: 17, outputTokens: 6, cacheReadTokens: 4 });
	});

	const reasoningCases: Array<[GoldenFixture, string, string]> = [
		["aggregator-reasoning", "choices[0].delta.reasoning", "Greeting — reply briefly."],
		["ollama", "choices[0].delta.reasoning", "The user says hi."],
		["lmstudio", "choices[0].delta.reasoning", "User greets. Respond."],
		["vllm", "choices[0].delta.reasoning_content", "Need to read a.txt first."],
		["deepseek-direct", "choices[0].delta.reasoning_content", "用户只是打招呼,简短回应即可。"],
	];
	for (const [name, path, expected] of reasoningCases) {
		it(`${name}:spec 点名 ${path},思考增量与 usage 都在`, async () => {
			const id = withAdapter(`custom-golden-${name}`, {
				version: 1,
				wire: "openai-chat",
				response: { reasoningDeltaPath: path, usage: { input: "prompt_tokens", output: "completion_tokens" } },
			});
			const { events } = await runGolden(id, name);
			expect(reasoningOf(events)).toBe(expected);
			const usage = finishOf(events).usage;
			expect(usage?.inputTokens).toBeGreaterThan(0);
			expect(usage?.outputTokens).toBeGreaterThan(0);
		});
	}

	it("textDeltaPath 非默认:按路径补文本增量", async () => {
		const id = withAdapter("custom-golden-text", {
			version: 1,
			wire: "openai-chat",
			response: { textDeltaPath: "choices[0].delta.thinking" },
		});
		const { events } = await runGolden(id, "thinking-field");
		expect(textOf(events)).toBe("先想一想。好的。");
	});

	it("request 表:maxTokensField / extraBody / 声明式思考映射进请求体", async () => {
		const id = withAdapter("custom-golden-request", {
			version: 1,
			wire: "openai-chat",
			request: {
				maxTokensField: "max_completion_tokens",
				streamUsage: "none",
				extraBody: { relay_tag: "x" },
				reasoning: { effortPath: "thinking.level", effortValues: { high: "deep" } },
			},
		});
		const { body } = await runGolden(id, "ollama");
		expect(body.stream_options).toBeUndefined();
		expect(body.relay_tag).toBe("x");
		expect(body.thinking).toEqual({ level: "deep" });
	});

	it("openai-chat 的适配表整张都落进策略格(§7.5 补齐四格);另外三条线的 response 仍列出", () => {
		expect(
			unsupportedAdapterSpecFields({
				version: 1,
				wire: "openai-chat",
				response: {
					toolCallsPath: "choices[0].delta.function_call",
					finishReasonPath: "choices[0].stop_reason",
					finishReasonMap: { end_turn: "stop" },
					doneMarker: "[END]",
					reasoningDeltaPath: "choices[0].delta.reasoning",
				},
			}),
		).toEqual([]);
		expect(unsupportedAdapterSpecFields({ version: 1, wire: "openai-chat", response: { doneMarker: null } })).toEqual([]);
		expect(
			unsupportedAdapterSpecFields({ version: 1, wire: "anthropic-messages", response: { doneMarker: null } }),
		).toEqual(["response"]);
	});

	function toolEventsOf(events: Awaited<ReturnType<typeof runGolden>>["events"]) {
		return events.filter((e) => e.type.startsWith("tool-call"));
	}

	it("function-call-legacy:`toolCallsStyle: function_call` + finishReasonMap 解出一次工具调用与正确收尾", async () => {
		const id = withAdapter("custom-golden-legacy-style", {
			version: 1,
			wire: "openai-chat",
			response: { toolCallsStyle: "function_call", finishReasonMap: { function_call: "tool-calls" } },
		});
		const { events } = await runGolden(id, "function-call-legacy");
		expect(textOf(events)).toBe("Let me read it.");
		expect(toolEventsOf(events)).toEqual([
			{ type: "tool-call-start", turn: 1, toolCallId: "tool-1-0", toolName: "read_file" },
			{ type: "tool-call-delta", turn: 1, toolCallId: "tool-1-0", toolName: "read_file", argumentsDelta: '{"path":' },
			{ type: "tool-call-delta", turn: 1, toolCallId: "tool-1-0", toolName: "read_file", argumentsDelta: '"a.txt"}' },
			{
				type: "tool-call-done",
				turn: 1,
				toolCall: { id: "tool-1-0", name: "read_file", arguments: '{"path":"a.txt"}' },
			},
		]);
		const finish = finishOf(events);
		expect(finish.finishReason).toBe("tool_calls");
		expect(finish.usage).toMatchObject({ inputTokens: 21, outputTokens: 9 });
	});

	it("function-call-legacy:只写 `toolCallsPath` 指老格式那条路径,编译到同一个 codec", async () => {
		const id = withAdapter("custom-golden-legacy-path", {
			version: 1,
			wire: "openai-chat",
			response: { toolCallsPath: "choices[0].delta.function_call" },
		});
		const { events } = await runGolden(id, "function-call-legacy");
		const done = events.find((e) => e.type === "tool-call-done");
		expect(done).toMatchObject({ toolCall: { name: "read_file", arguments: '{"path":"a.txt"}' } });
	});

	it("style 与 path 都写时 style 优先:`tool_calls` 盖过路径 = 线的默认读法(老格式解不出)", async () => {
		const id = withAdapter("custom-golden-legacy-style-wins", {
			version: 1,
			wire: "openai-chat",
			response: { toolCallsStyle: "tool_calls", toolCallsPath: "choices[0].delta.function_call" },
		});
		const { events } = await runGolden(id, "function-call-legacy");
		expect(toolEventsOf(events)).toEqual([]);
	});

	it("finishReasonMap 只加词:表里没有的原值仍走线的默认映射", async () => {
		const id = withAdapter("custom-golden-finish-map", {
			version: 1,
			wire: "openai-chat",
			response: { finishReasonMap: { end_turn: "stop" } },
		});
		const { events } = await runGolden(id, "ollama");
		expect(finishOf(events).finishReason).toBe("stop");
	});
});
