/**
 * Gemini 官方端点的图像输出 + 多轮改图(P4-2,设计稿 §5.2 Gemini 行 / §12)。
 *
 * 四段链路各一组用例:
 *  1. **能力账本** —— gemini 家 + `supportsImageOutput` ⇒
 *     `imageOutputServedBy: 'in-loop'`(图像模型也是聊天模型,专用生图流退役);
 *  2. **请求侧** —— 能出图才发 `generationConfig.responseModalities`;
 *  3. **响应侧** —— `candidates[0].content.parts[].inlineData` → `provider-data`
 *     (与 codex / OpenRouter 同形,落点按 type 判);
 *  4. **多轮改图** —— 历史 assistant 正文里的 `mediaId:` 经只读媒体端口取回
 *     字节,作为 `inlineData` 跟在文本之后放回 `contents`。
 *
 * ⚠️ **待真机核**:流式下 `inlineData` 是不是一整块回来(还是像文本那样分片)。
 * 这里按 `streamGenerateContent` 的响应形状假定「一块一张图」——`inlineData`
 * 在 REST 文档里是一个完整的 `Blob`,没有增量语义。
 */
import { describe, expect, it, vi } from "vitest";
import type {
	AgentMessage,
	AgentTurnStreamEvent,
} from "@onething/core/agent-loop";
import { createAgentProviderFromRuntime } from "../../factory.js";
import { geminiParts } from "../gemini-messages.js";
import type { GeminiContent } from "../gemini-messages.js";
import { resolveOnethingModelCapabilities } from "../../../../providers/model-capability.js";

const IMAGE_MODEL = "gemini-3-pro-image";
const TEXT_MODEL = "gemini-3.1-pro";

const REPLAY_BASE64 = "aVJlcGxheQ==";

function sse(...chunks: unknown[]): string {
	return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");
}

function sseResponse(body: string): Response {
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

const MINIMAL = sse({
	candidates: [
		{
			index: 0,
			content: { role: "model", parts: [{ text: "ok" }] },
			finishReason: "STOP",
		},
	],
});

interface StreamRun {
	events: AgentTurnStreamEvent[];
	requestBody: Record<string, unknown>;
}

interface RunOptions {
	messages?: AgentMessage[];
	media?: {
		readImageBase64: (
			mediaId: string,
		) => Promise<{ base64: string; mediaType: string } | undefined>;
	};
}

async function runGeminiTurn(
	model: string,
	body: string,
	options: RunOptions = {},
): Promise<StreamRun> {
	const bodies: Record<string, unknown>[] = [];
	const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
		bodies.push(JSON.parse(String(init?.body ?? "null")));
		return sseResponse(body);
	}) as typeof globalThis.fetch;

	const provider = createAgentProviderFromRuntime(
		"gemini",
		{
			apiKey: "sk-gemini-test",
			model,
			models: { [IMAGE_MODEL]: { supportsImageOutput: true } },
		},
		{ fetchImpl, ...(options.media ? { media: options.media } : {}) },
	);
	const events: AgentTurnStreamEvent[] = [];
	for await (const event of provider!.streamTurn!({
		messages: options.messages ?? [{ role: "user", content: "画一只猫。" }],
		model,
		turn: 1,
	})) {
		events.push(event);
	}
	return { events, requestBody: bodies[0]! };
}

function providerDataEvents(events: AgentTurnStreamEvent[]): unknown[] {
	return events
		.filter((event) => event.type === "provider-data")
		.map((event) => (event as { providerData: unknown }).providerData);
}

function generationConfig(body: Record<string, unknown>): Record<string, unknown> {
	return (body.generationConfig ?? {}) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 1. 能力账本
// ---------------------------------------------------------------------------

describe("gemini image output — capability ledger", () => {
	it("serves image output in-loop (the image model IS the chat model)", () => {
		for (const modelId of [
			"gemini-2.5-flash-image",
			"gemini-3-pro-image",
			"gemini-3.1-flash-image",
		]) {
			const resolved = resolveOnethingModelCapabilities({
				providerId: "gemini",
				modelId,
				registryEntry: { supportsImageOutput: true },
			});
			expect(resolved.imageOutput, modelId).toBe(true);
			expect(resolved.imageOutputServedBy, modelId).toBe("in-loop");
		}
	});

	it("leaves the real dedicated image endpoints alone", () => {
		expect(
			resolveOnethingModelCapabilities({
				providerId: "openai",
				modelId: "gpt-image-1",
				registryEntry: { supportsImageOutput: true },
			}).imageOutputServedBy,
		).toBe("dedicated-api");
	});

	it("says nothing for a gemini model that cannot draw", () => {
		expect(
			resolveOnethingModelCapabilities({
				providerId: "gemini",
				modelId: TEXT_MODEL,
			}).imageOutputServedBy,
		).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// 2. 请求侧
// ---------------------------------------------------------------------------

describe("gemini image output — request body", () => {
	it("declares `responseModalities` for a model that draws in-loop", async () => {
		const { requestBody } = await runGeminiTurn(IMAGE_MODEL, MINIMAL);
		expect(generationConfig(requestBody).responseModalities).toEqual([
			"TEXT",
			"IMAGE",
		]);
	});

	it("sends no extra byte for a text-only model", async () => {
		const { requestBody } = await runGeminiTurn(TEXT_MODEL, MINIMAL);
		expect(generationConfig(requestBody)).not.toHaveProperty(
			"responseModalities",
		);
	});
});

// ---------------------------------------------------------------------------
// 3. 响应侧
// ---------------------------------------------------------------------------

describe("gemini image output — stream decoding", () => {
	it("decodes an `inlineData` image part", async () => {
		const { events } = await runGeminiTurn(
			IMAGE_MODEL,
			sse(
				{
					candidates: [
						{
							index: 0,
							content: {
								role: "model",
								parts: [
									{ text: "给你。" },
									{
										inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" },
									},
								],
							},
						},
					],
				},
				{ candidates: [{ index: 0, finishReason: "STOP" }] },
			),
		);
		expect(providerDataEvents(events)).toEqual([
			{
				provider: "gemini",
				type: "image-generation-result",
				callId: "1-img-0",
				status: "completed",
				result: "iVBORw0KGgo=",
				mediaType: "image/png",
			},
		]);
		// 文本没有被这一格吃掉。
		expect(
			events.filter((event) => event.type === "text-delta"),
		).toHaveLength(1);
	});

	it("numbers several images inside one turn", async () => {
		const { events } = await runGeminiTurn(
			IMAGE_MODEL,
			sse(
				{
					candidates: [
						{
							index: 0,
							content: {
								role: "model",
								parts: [
									{ inlineData: { mimeType: "image/png", data: "AAA=" } },
									{ inlineData: { mimeType: "image/webp", data: "BBB=" } },
								],
							},
						},
					],
				},
				{ candidates: [{ index: 0, finishReason: "STOP" }] },
			),
		);
		expect(
			providerDataEvents(events).map(
				(data) => (data as { callId: string }).callId,
			),
		).toEqual(["1-img-0", "1-img-1"]);
	});

	it("never mistakes a non-image `inlineData` for a picture", async () => {
		const { events } = await runGeminiTurn(
			IMAGE_MODEL,
			sse({
				candidates: [
					{
						index: 0,
						content: {
							role: "model",
							parts: [
								{ inlineData: { mimeType: "audio/mpeg", data: "SUQz" } },
								{ inlineData: { data: "no-mime" } },
								{ inlineData: { mimeType: "image/png" } },
							],
						},
						finishReason: "STOP",
					},
				],
			}),
		);
		expect(providerDataEvents(events)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 4. 多轮改图 —— 历史回放
// ---------------------------------------------------------------------------

const GENERATED_IMAGE_MARKDOWN =
	"这是你要的猫。\n\n![Generated Image|mediaId:img-1](media://img-1.png)";

const HISTORY: AgentMessage[] = [
	{ role: "user", content: "画一只猫。" },
	{ role: "assistant", content: GENERATED_IMAGE_MARKDOWN },
	{ role: "user", content: "把它换成蓝色的。" },
];

function modelContents(body: Record<string, unknown>): GeminiContent[] {
	return (body.contents as GeminiContent[]).filter(
		(content) => content.role === "model",
	);
}

describe("gemini image output — multi-turn edit replay", () => {
	it("puts the generated image back as an `inlineData` part after the text", async () => {
		const readImageBase64 = vi.fn(async (mediaId: string) =>
			mediaId === "img-1"
				? { base64: REPLAY_BASE64, mediaType: "image/png" }
				: undefined,
		);
		const { requestBody } = await runGeminiTurn(IMAGE_MODEL, MINIMAL, {
			messages: HISTORY,
			media: { readImageBase64 },
		});

		expect(readImageBase64).toHaveBeenCalledWith("img-1");
		expect(modelContents(requestBody)).toEqual([
			{
				role: "model",
				parts: [
					{ text: GENERATED_IMAGE_MARKDOWN },
					{ inlineData: { mimeType: "image/png", data: REPLAY_BASE64 } },
				],
			},
		]);
	});

	it("leaves a plain assistant message alone (and never asks the media library)", async () => {
		const readImageBase64 = vi.fn(async () => undefined);
		const { requestBody } = await runGeminiTurn(IMAGE_MODEL, MINIMAL, {
			messages: [
				{ role: "user", content: "你好。" },
				{ role: "assistant", content: "你好呀。" },
				{ role: "user", content: "再说一次。" },
			],
			media: { readImageBase64 },
		});

		expect(readImageBase64).not.toHaveBeenCalled();
		expect(modelContents(requestBody)).toEqual([
			{ role: "model", parts: [{ text: "你好呀。" }] },
		]);
	});

	it("degrades to text-only when the media library has no such image", async () => {
		const readImageBase64 = vi.fn(async () => undefined);
		const { requestBody } = await runGeminiTurn(IMAGE_MODEL, MINIMAL, {
			messages: HISTORY,
			media: { readImageBase64 },
		});

		expect(readImageBase64).toHaveBeenCalledWith("img-1");
		expect(modelContents(requestBody)).toEqual([
			{ role: "model", parts: [{ text: GENERATED_IMAGE_MARKDOWN }] },
		]);
	});

	it("replays nothing — and throws nothing — when no media port is injected", async () => {
		const { requestBody } = await runGeminiTurn(IMAGE_MODEL, MINIMAL, {
			messages: HISTORY,
		});
		expect(modelContents(requestBody)).toEqual([
			{ role: "model", parts: [{ text: GENERATED_IMAGE_MARKDOWN }] },
		]);
	});
});

// ---------------------------------------------------------------------------
// 4b. codec 直测 —— warning 与块序在这一层最好观察
// ---------------------------------------------------------------------------

function fakeLogger() {
	const warn = vi.fn();
	return { warn, logger: { warn } as never };
}

describe("gemini image output — codec replay contract", () => {
	it("warns once per unreadable image instead of throwing", async () => {
		const contents: GeminiContent[] = [
			{ role: "model", parts: [{ text: GENERATED_IMAGE_MARKDOWN }] },
		];
		const { warn, logger } = fakeLogger();
		await geminiParts.replayGeneratedImages?.(
			contents,
			{ readImageBase64: async () => undefined },
			logger,
		);
		expect(warn).toHaveBeenCalledWith(
			"generated image not found for replay",
			{ mediaId: "img-1" },
		);
		expect(contents[0]!.parts).toEqual([{ text: GENERATED_IMAGE_MARKDOWN }]);
	});

	it("warns and keeps going when the read throws", async () => {
		const contents: GeminiContent[] = [
			{ role: "model", parts: [{ text: GENERATED_IMAGE_MARKDOWN }] },
		];
		const { warn, logger } = fakeLogger();
		await geminiParts.replayGeneratedImages?.(
			contents,
			{
				readImageBase64: async () => {
					throw new Error("EACCES");
				},
			},
			logger,
		);
		expect(warn).toHaveBeenCalledWith(
			"generated image replay failed",
			{ mediaId: "img-1" },
			expect.any(Error),
		);
	});

	it("keeps `functionCall` parts trailing (text → image → functionCall)", async () => {
		const contents: GeminiContent[] = [
			{
				role: "model",
				parts: [
					{ text: GENERATED_IMAGE_MARKDOWN },
					{ functionCall: { name: "read_file", args: { path: "a.txt" } } },
				],
			},
		];
		await geminiParts.replayGeneratedImages?.(contents, {
			readImageBase64: async () => ({
				base64: REPLAY_BASE64,
				mediaType: "image/png",
			}),
		});
		expect(contents[0]!.parts).toEqual([
			{ text: GENERATED_IMAGE_MARKDOWN },
			{ inlineData: { mimeType: "image/png", data: REPLAY_BASE64 } },
			{ functionCall: { name: "read_file", args: { path: "a.txt" } } },
		]);
	});

	it("never touches user or function contents", async () => {
		const contents: GeminiContent[] = [
			{ role: "user", parts: [{ text: GENERATED_IMAGE_MARKDOWN }] },
			{
				role: "function",
				parts: [
					{
						functionResponse: {
							name: "read_file",
							response: { result: GENERATED_IMAGE_MARKDOWN },
						},
					},
				],
			},
		];
		const readImageBase64 = vi.fn(async () => ({
			base64: REPLAY_BASE64,
			mediaType: "image/png",
		}));
		await geminiParts.replayGeneratedImages?.(contents, { readImageBase64 });
		expect(readImageBase64).not.toHaveBeenCalled();
	});

	it("dedupes the two markdown coordinates of the same image", async () => {
		const contents: GeminiContent[] = [
			{ role: "model", parts: [{ text: GENERATED_IMAGE_MARKDOWN }] },
		];
		const readImageBase64 = vi.fn(async () => ({
			base64: REPLAY_BASE64,
			mediaType: "image/png",
		}));
		await geminiParts.replayGeneratedImages?.(contents, { readImageBase64 });
		// `mediaId:img-1` 与 `media://img-1.png` 是同一张图,只读一次。
		expect(readImageBase64).toHaveBeenCalledTimes(1);
	});
});
