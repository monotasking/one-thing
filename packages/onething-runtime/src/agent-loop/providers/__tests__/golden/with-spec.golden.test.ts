/**
 * golden 另一半(§7.2):**有 spec** 时,同一批夹具经 `dialectFromSpec` 编译出来的方言解出思考增量
 * 与 usage —— 而且是经工厂的真路(manifest 指 `custom:<id>` → 工厂认它)。
 */
import { afterAll, describe, expect, it } from "vitest";
import type { CustomAdapterSpec } from "@shared/contracts/adapter-spec";
import { registerCustomProvidersForTest } from "../../../../providers/__tests__/custom-manifest-fixture.js";
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

	it("落不进策略格的格如实列出", () => {
		expect(
			unsupportedAdapterSpecFields({
				version: 1,
				wire: "openai-chat",
				response: {
					toolCallsPath: "choices[0].delta.function_call",
					finishReasonMap: { end_turn: "stop" },
					doneMarker: "[END]",
					reasoningDeltaPath: "choices[0].delta.reasoning",
				},
			}),
		).toEqual(["response.toolCallsPath", "response.finishReasonMap", "response.doneMarker"]);
		expect(unsupportedAdapterSpecFields({ version: 1, wire: "openai-chat", response: { doneMarker: null } })).toEqual([]);
	});
});
