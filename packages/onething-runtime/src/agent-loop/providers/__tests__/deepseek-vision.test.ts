/**
 * DeepSeek 图像输入(P0b-A 的 A2,设计稿 §11「方案三 = P0b 的一项」)。
 *
 * 两侧各一条,合起来才叫「能发图」:
 *  1. **账本侧** —— `deepseek-*-vision-exp` 的 `vision` 为真,于是
 *     `getModelCapabilities()` 的 `inputModalities` 含 `image`;
 *  2. **线上侧** —— user 消息序列化成内容块数组,图落 `image_url`,
 *     data URL 带 mediaType;进不了请求体的附件(PDF)留成**可见文本**,
 *     不再像退役的 `DeepSeekPartCodec` 那样静默消失。
 *
 * 全程走生产入口 `createAgentProviderFromRuntime`(覆盖层也在里面)。
 */
import { describe, expect, it } from "vitest";
import type {
	AgentMessage,
	AgentTurnStreamEvent,
} from "@onething/core/agent-loop";
import { createAgentProviderFromRuntime } from "../factory.js";

const VISION_MODEL = "deepseek-v4-flash-vision-exp";

const VISION_LEDGER = {
	apiKey: "sk-deepseek-fixture",
	models: {
		[VISION_MODEL]: {
			supportsVision: true,
			supportsTools: true,
			supportsReasoning: true,
		},
	},
};

const MULTIMODAL_USER: AgentMessage = {
	role: "user",
	content: [
		{ type: "text", text: "这张截图说明了什么？" },
		{ type: "image", image: "iVBORw0KGgoAAAANSUhEUg==", mediaType: "image/png" },
		{
			type: "file",
			data: "JVBERi0xLjcKJcOkw7zDtsOfCg==",
			mediaType: "application/pdf",
			filename: "spec.pdf",
		},
	],
};

const MINIMAL_STREAM = `data: ${JSON.stringify({
	choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
})}\n\ndata: [DONE]\n\n`;

interface OpenAIChatUserPart {
	type: string;
	text?: string;
	image_url?: { url: string };
}

async function captureWireBody(
	message: AgentMessage,
): Promise<Record<string, unknown>> {
	const bodies: Record<string, unknown>[] = [];
	const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
		bodies.push(JSON.parse(String(init?.body ?? "null")));
		return new Response(MINIMAL_STREAM, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}) as typeof globalThis.fetch;

	const provider = createAgentProviderFromRuntime(
		"deepseek",
		{ ...VISION_LEDGER, model: VISION_MODEL },
		{ fetchImpl },
	);
	if (!provider?.streamTurn) throw new Error("deepseek provider has no streamTurn");

	const events: AgentTurnStreamEvent[] = [];
	for await (const event of provider.streamTurn({
		messages: [message],
		model: VISION_MODEL,
		turn: 1,
	})) {
		events.push(event);
	}
	expect(bodies).toHaveLength(1);
	return bodies[0]!;
}

describe("deepseek vision", () => {
	it("账本说 vision → getModelCapabilities 声明 image 输入", async () => {
		const provider = createAgentProviderFromRuntime(
			"deepseek",
			{ ...VISION_LEDGER, model: VISION_MODEL },
			{},
		);
		const capabilities = await provider!.getModelCapabilities!(VISION_MODEL);
		expect(capabilities.inputModalities).toContain("image");
		expect(capabilities.capabilities).toContain("vision-input");
	});

	it("账本没说 vision 的模型仍然只有文本输入", async () => {
		const provider = createAgentProviderFromRuntime(
			"deepseek",
			{ apiKey: "sk-deepseek-fixture", model: "deepseek-chat" },
			{},
		);
		const capabilities = await provider!.getModelCapabilities!("deepseek-chat");
		expect(capabilities.inputModalities).not.toContain("image");
	});

	it("user 文本 + 图 → content 数组含 image_url,data URL 带 mediaType", async () => {
		const body = await captureWireBody(MULTIMODAL_USER);
		const messages = body.messages as Array<{
			role: string;
			content: string | OpenAIChatUserPart[];
		}>;
		const user = messages[0]!;
		expect(user.role).toBe("user");
		expect(Array.isArray(user.content)).toBe(true);

		const parts = user.content as OpenAIChatUserPart[];
		expect(parts.map((part) => part.type)).toEqual(["text", "image_url", "text"]);
		expect(parts[1]!.image_url?.url).toBe(
			"data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
		);
		// PDF 进不了 chat-completions:留可见文本,不静默丢。
		expect(parts[2]!.text).toContain("spec.pdf");
		expect(parts[2]!.text).toContain("could not be delivered");
	});

	it("纯文本的 user 消息仍是字符串(线上字节不变)", async () => {
		const body = await captureWireBody({ role: "user", content: "读一下 a.txt。" });
		const messages = body.messages as Array<{ content: unknown }>;
		expect(messages[0]!.content).toBe("读一下 a.txt。");
	});
});
