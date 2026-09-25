/**
 * 批 4 §7.3:探测 + 规则 + 回验(`providers/custom-probe.ts`)。
 * 四条线的假样本各判对;规则判满不需分析;回验失败三例;脱敏;模型列表映射那一档。
 */
import { describe, expect, it } from "vitest";
import type { CustomAdapterSpec } from "@shared/contracts/adapter-spec";
import {
	adapterDeviations,
	adapterReasoningPath,
	classifyStreamSample,
	clipProbeSample,
	parseAdapterSpecAnswer,
	probeCustomEndpoint,
	redactProbeText,
	renderCustomAdapterProbePrompt,
	verifyAdapterSpec,
} from "../custom-probe.js";
import { parseProviderDirectModels } from "../models-endpoint.js";

const sse = (...frames: Array<string | object>) =>
	frames.map((f) => `data: ${typeof f === "string" ? f : JSON.stringify(f)}\n\n`).join("");

const chunk = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) => ({
	object: "chat.completion.chunk",
	choices: [{ index: 0, delta, finish_reason: finish }],
	...extra,
});

const CHAT_STANDARD = sse(
	chunk({ role: "assistant", reasoning_content: "hmm" }),
	chunk({ content: "Hello" }),
	chunk({}, "stop", { usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }),
	"[DONE]",
);
const CHAT_REASONING_FIELD = sse(
	chunk({ role: "assistant", reasoning: "hmm" }),
	chunk({ content: "Hello" }),
	chunk({}, "stop", { usage: { prompt_tokens: 5, completion_tokens: 3 } }),
	"[DONE]",
);
const RESPONSES = [
	"event: response.created",
	`data: ${JSON.stringify({ type: "response.created", response: { id: "r1" } })}`,
	"",
	"event: response.output_text.delta",
	`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hi" })}`,
	"",
	"",
].join("\n");
const ANTHROPIC = [
	"event: message_start",
	`data: ${JSON.stringify({ type: "message_start", message: { id: "m", usage: { input_tokens: 4, output_tokens: 1 } } })}`,
	"",
	"event: content_block_start",
	`data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
	"",
	"event: content_block_delta",
	`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } })}`,
	"",
	"event: message_delta",
	`data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } })}`,
	"",
	"event: message_stop",
	`data: ${JSON.stringify({ type: "message_stop" })}`,
	"",
	"",
].join("\n");
const GEMINI = sse({ candidates: [{ content: { role: "model", parts: [{ text: "Hi" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 } });

const MODELS = JSON.stringify({ object: "list", data: [{ id: "relay-1" }, { id: "relay-2" }] });

describe("classifyStreamSample", () => {
	it("四条线各判对", () => {
		expect(classifyStreamSample(CHAT_STANDARD)).toBe("openai-chat");
		expect(classifyStreamSample(RESPONSES)).toBe("openai-responses");
		expect(classifyStreamSample(ANTHROPIC)).toBe("anthropic-messages");
		expect(classifyStreamSample(GEMINI)).toBe("gemini-generateContent");
		expect(classifyStreamSample("<html>nope</html>")).toBeUndefined();
	});
});

describe("规则先判", () => {
	it("标准字段名:判满,不需要分析", () => {
		expect(adapterDeviations("openai-chat", { stream: CHAT_STANDARD, models: MODELS }, 2)).toEqual([]);
	});
	it("思考放在 `reasoning`:判不满", () => {
		expect(adapterDeviations("openai-chat", { stream: CHAT_REASONING_FIELD, models: MODELS }, 2)).toEqual([
			"response.delta.reasoning",
		]);
	});
	it("usage 字段名不标准 / 模型列表形状认不出:判不满", () => {
		const odd = sse(chunk({ content: "x" }, "stop", { usage: { input_tokens: 1, output_tokens: 1 } }));
		expect(adapterDeviations("openai-chat", { stream: odd, models: "{}" }, 0)).toEqual([
			"modelsList",
			"response.usage",
		]);
	});
});

describe("probeCustomEndpoint", () => {
	function fakeFetch(routes: Record<string, () => Response>) {
		const calls: string[] = [];
		const fetchImpl = async (input: string) => {
			calls.push(input);
			const hit = Object.entries(routes).find(([suffix]) => input.endsWith(suffix) || input.includes(suffix));
			return hit ? hit[1]() : new Response("not found", { status: 404 });
		};
		return { fetchImpl, calls };
	}

	it("标准 openai-chat:只写 wire,needsAnalysis=false,样本脱敏", async () => {
		const { fetchImpl, calls } = fakeFetch({
			"/models": () => new Response(MODELS, { status: 200 }),
			"/chat/completions": () => new Response(CHAT_STANDARD, { status: 200 }),
		});
		const result = await probeCustomEndpoint({ baseUrl: "http://relay.test/v1", apiKey: "sk-secret-123456", fetchImpl, now: () => 1 });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.wire).toBe("openai-chat");
		expect(result.needsAnalysis).toBe(false);
		expect(result.spec).toMatchObject({ version: 1, wire: "openai-chat", probe: { at: 1, model: "relay-1" } });
		expect(result.spec.response).toBeUndefined();
		expect(calls).toEqual(["http://relay.test/v1/models", "http://relay.test/v1/chat/completions"]);
	});

	it("chat 404 → 依次试到 anthropic", async () => {
		const { fetchImpl, calls } = fakeFetch({
			"/models": () => new Response(MODELS, { status: 200 }),
			"/messages": () => new Response(ANTHROPIC, { status: 200 }),
		});
		const result = await probeCustomEndpoint({ baseUrl: "http://relay.test/v1", fetchImpl, hintModel: "claude-x" });
		expect(result.ok && result.wire).toBe("anthropic-messages");
		expect(calls.slice(1)).toEqual([
			"http://relay.test/v1/chat/completions",
			"http://relay.test/v1/responses",
			"http://relay.test/v1/messages",
		]);
	});

	it("什么都不认:unrecognized / 连不上:unreachable", async () => {
		const html = fakeFetch({
			"/models": () => new Response(MODELS, { status: 200 }),
			"/chat/completions": () => new Response("<html/>", { status: 200 }),
		});
		const a = await probeCustomEndpoint({ baseUrl: "http://relay.test/v1", fetchImpl: html.fetchImpl });
		expect(a).toMatchObject({ ok: false, reason: "unrecognized" });

		const down = await probeCustomEndpoint({
			baseUrl: "http://relay.test/v1",
			hintModel: "m",
			fetchImpl: async () => {
				throw new Error("ECONNREFUSED");
			},
		});
		expect(down).toMatchObject({ ok: false, reason: "unreachable" });
	});
});

describe("verifyAdapterSpec", () => {
	const chat: CustomAdapterSpec = { version: 1, wire: "openai-chat" };

	it("通过:文本增量、usage、模型数", async () => {
		const verdict = await verifyAdapterSpec(chat, { stream: CHAT_STANDARD, models: MODELS });
		expect(verdict).toMatchObject({ ok: true, textDeltas: 1, reasoningDeltas: 1, usage: { input: 5, output: 3 }, modelCount: 2 });
	});

	it("四条线的样本都能重放出文本", async () => {
		for (const [wire, stream] of [
			["openai-responses", RESPONSES],
			["anthropic-messages", ANTHROPIC],
			["gemini-generateContent", GEMINI],
		] as const) {
			const verdict = await verifyAdapterSpec({ version: 1, wire }, { stream });
			expect(verdict.ok, wire).toBe(true);
		}
	});

	it("失败一:模型列表解不出", async () => {
		const verdict = await verifyAdapterSpec(chat, { stream: CHAT_STANDARD, models: JSON.stringify({ result: { items: [] } }) });
		expect(verdict).toMatchObject({ ok: false, reason: "no-models" });
	});

	it("失败二:没有文本增量(文本不在默认路径,表也没点名)", async () => {
		const stream = sse(chunk({ text: "Hi" }), chunk({}, "stop"));
		expect(await verifyAdapterSpec(chat, { stream })).toMatchObject({ ok: false, reason: "no-text" });
		// 点名之后就过
		expect(
			await verifyAdapterSpec({ ...chat, response: { textDeltaPath: "choices[0].delta.text" } }, { stream }),
		).toMatchObject({ ok: true });
	});

	it("失败三:样本带 usage 但表解不出", async () => {
		const stream = sse(chunk({ content: "Hi" }), chunk({}, "stop", { usage: { in: 3, out: 2 } }));
		expect(await verifyAdapterSpec(chat, { stream })).toMatchObject({ ok: false, reason: "no-usage" });
		expect(
			await verifyAdapterSpec({ ...chat, response: { usage: { input: "in", output: "out" } } }, { stream }),
		).toMatchObject({ ok: true, usage: { input: 3, output: 2 } });
	});

	it("模型列表按 spec 映射那一档", async () => {
		const models = JSON.stringify({ result: { items: [{ model_id: "a", title: "A", ctx: 32000 }] } });
		const verdict = await verifyAdapterSpec(
			{ ...chat, modelsList: { itemsPath: "result.items", idField: "model_id", nameField: "title", contextField: "ctx" } },
			{ stream: CHAT_STANDARD, models },
		);
		expect(verdict).toMatchObject({ ok: true, modelCount: 1 });
		const [row] = parseProviderDirectModels(JSON.parse(models), models, {
			itemsPath: "result.items",
			idField: "model_id",
			nameField: "title",
			contextField: "ctx",
		});
		expect(row).toMatchObject({ id: "a", name: "A", context_length: 32000 });
	});
});

describe("提示词 / 答案 / 摘要 / 脱敏", () => {
	it("提示词里有 schema、线与两份样本", () => {
		const prompt = renderCustomAdapterProbePrompt("openai-chat", { stream: CHAT_REASONING_FIELD, models: MODELS });
		expect(prompt).toContain('"reasoningDeltaPath"');
		expect(prompt).toContain("`openai-chat`");
		expect(prompt).toContain("relay-1");
		expect(prompt).toContain('"reasoning":"hmm"');
	});

	it("答案只认一个对象、version 1、同一条线", () => {
		expect(parseAdapterSpecAnswer('```json\n{"version":1,"wire":"openai-chat","response":{"reasoningDeltaPath":"choices[0].delta.reasoning"}}\n```', "openai-chat"))
			.toMatchObject({ response: { reasoningDeltaPath: "choices[0].delta.reasoning" } });
		expect(parseAdapterSpecAnswer("sure! here you go", "openai-chat")).toBeUndefined();
		expect(parseAdapterSpecAnswer('{"version":1,"wire":"anthropic-messages"}', "openai-chat")).toBeUndefined();
		expect(parseAdapterSpecAnswer('{"version":1,"wire":"openai-chat","response":"x"}', "openai-chat")).toBeUndefined();
	});

	it("思考路径:点名的优先;没点名但样本里真见过默认那一格才说", () => {
		expect(adapterReasoningPath({ version: 1, wire: "openai-chat", response: { reasoningDeltaPath: "choices[0].delta.reasoning" } }, { stream: "" }))
			.toBe("choices[0].delta.reasoning");
		expect(adapterReasoningPath({ version: 1, wire: "openai-chat" }, { stream: CHAT_STANDARD })).toBe("choices[0].delta.reasoning_content");
		expect(adapterReasoningPath({ version: 1, wire: "openai-chat" }, { stream: sse(chunk({ content: "x" })) })).toBeUndefined();
	});

	it("脱敏:密钥原文、Bearer 值、sk- 串、邮箱", () => {
		const text = 'key=abcd-SECRET-1 auth="Bearer tok.en_123" other sk-abcdefghijk user a.b@example.com';
		const out = redactProbeText(text, ["abcd-SECRET-1"]);
		expect(out).not.toContain("SECRET");
		expect(out).not.toContain("tok.en_123");
		expect(out).not.toContain("sk-abcdefghijk");
		expect(out).not.toContain("example.com");
	});

	it("截断截在事件边界上", () => {
		const big = sse(...Array.from({ length: 400 }, (_, i) => chunk({ content: `piece-${i}` })));
		const clipped = clipProbeSample(big, 8 * 1024, true);
		expect(new TextEncoder().encode(clipped).length).toBeLessThanOrEqual(8 * 1024);
		expect(clipped.endsWith("\n\n")).toBe(true);
	});
});
