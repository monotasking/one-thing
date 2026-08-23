/**
 * **tool 结果里的图**(设计稿 §5.1 tool 结果模态行,P3-5b)。
 *
 * 一句话:OpenRouter 的文档允许 `role:'tool'` 的 `content` 是内容块数组并在
 * 其中收 `image_url`,OpenAI 官方只允许字符串 —— 于是这条线上「tool 结果收不
 * 收图」是**方言的一个开关**(`toolResultMultimodal`),不是 codec 里的
 * `if (providerId === …)`。
 *
 * 四件事各有各的门:
 *  1. **开关开着的家** —— 含图的 tool 结果落成数组,图是 `image_url` 的 data URL;
 *  2. **形状守恒** —— 同一家的**纯文本**结果仍是字符串(既有 fixture 因此
 *     一个字节都不变),非图片二进制仍旧 `Undeliverable` 并留可见文本 + warning;
 *  3. **开关关着的家** —— openai 的 tool 结果图仍旧 `Undeliverable` + warning;
 *  4. **能力那一半** —— core 的 `agentSupportsToolResultModality` 对 openrouter
 *     的 tool 结果图不再降级,对 openai 仍然降级。「能力说行」与「线协议做得到」
 *     是同一句话的两半(投递契约,§2.3),所以两半在同一份用例里断。
 */
import { describe, expect, it } from "vitest";
import type { AgentContentPart, AgentMessage } from "@onething/core/agent-loop";
import {
	agentSupportsToolResultModality,
	agentToolMessageContentForCapabilities,
} from "@onething/core/agent-loop";
import { getLogger } from "../../../../logging/index.js";
import {
	LedgerModelProfileResolver,
	RequestBodyBuilder,
	TurnContext,
	listDialects,
	type PartCodec,
} from "../../base/index.js";
import { createAgentProviderFromRuntime } from "../../factory.js";
import type {
	OpenAIChatCodec,
	OpenAIChatMessage,
} from "../openai-chat-messages.js";

const OPENROUTER_MODEL = "anthropic/claude-sonnet-5";
const OPENAI_MODEL = "gpt-5.5";

const IMAGE_PART: AgentContentPart = {
	type: "image",
	image: "iVBORw0KGgoAAAANSUhEUg==",
	mediaType: "image/png",
};

const BINARY_PART: AgentContentPart = {
	type: "file",
	data: "AAECAwQ=",
	mediaType: "application/octet-stream",
	filename: "blob.bin",
};

function toolMessage(content: AgentMessage["content"]): AgentMessage {
	return { role: "tool", toolCallId: "call_shot", content };
}

/** 已登记方言的 codec —— 与生产走的是同一只对象(配方里那只)。 */
function codecOf(dialectId: string): OpenAIChatCodec {
	const dialect = listDialects().find((entry) => entry.id === dialectId);
	if (!dialect?.parts) throw new Error(`dialect has no codec: ${dialectId}`);
	return dialect.parts as PartCodec as OpenAIChatCodec;
}

async function turnContextFor(
	providerId: string,
	model: string,
): Promise<TurnContext> {
	const profile = await new LedgerModelProfileResolver({}).resolve(
		providerId,
		model,
	);
	return new TurnContext(
		{ turn: 1, model, messages: [] },
		profile,
		new RequestBodyBuilder(),
		getLogger("test.openrouter-tool-result-image"),
	);
}

async function capabilitiesOf(providerId: string, model: string) {
	const provider = createAgentProviderFromRuntime(providerId, {
		apiKey: `sk-${providerId}-fixture`,
	});
	return provider!.getModelCapabilities!(model);
}

function wireToolMessage(message: OpenAIChatMessage) {
	expect(message.role).toBe("tool");
	return message as Extract<OpenAIChatMessage, { role: "tool" }>;
}

describe("openrouter — tool 结果里的图", () => {
	it("含图的 tool 结果落成内容块数组", async () => {
		const turn = await turnContextFor("openrouter", OPENROUTER_MODEL);
		const message = wireToolMessage(
			codecOf("openrouter").toWireMessage(
				toolMessage([{ type: "text", text: "已截图。" }, IMAGE_PART]),
				turn,
			),
		);

		expect(message.content).toEqual([
			{ type: "text", text: "已截图。" },
			{
				type: "image_url",
				image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==" },
			},
		]);
		expect(turn.warnings).toEqual([]);
	});

	it("纯文本结果仍然是字符串 —— 开关不改与它无关的字节", async () => {
		const turn = await turnContextFor("openrouter", OPENROUTER_MODEL);
		const fromParts = wireToolMessage(
			codecOf("openrouter").toWireMessage(
				toolMessage([{ type: "text", text: "hello from a.txt" }]),
				turn,
			),
		);
		const fromString = wireToolMessage(
			codecOf("openrouter").toWireMessage(
				toolMessage("hello from a.txt"),
				turn,
			),
		);

		expect(fromParts.content).toBe("hello from a.txt");
		expect(fromString.content).toBe("hello from a.txt");
	});

	it("非图片的二进制仍旧 Undeliverable —— 留可见文本 + warning", async () => {
		const turn = await turnContextFor("openrouter", OPENROUTER_MODEL);
		const delivery = codecOf("openrouter").toolResult(BINARY_PART, turn);

		expect(delivery.kind).toBe("undeliverable");
		expect(turn.warnings.map((warning) => warning.kind)).toEqual([
			"part-undeliverable",
		]);

		// 同一块混在含图的结果里 = 数组里的一行可见文本,不静默丢。
		const message = wireToolMessage(
			codecOf("openrouter").toWireMessage(
				toolMessage([IMAGE_PART, BINARY_PART]),
				turn,
			),
		);
		expect(message.content).toEqual([
			{
				type: "image_url",
				image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==" },
			},
			{
				type: "text",
				text: '[Attachment "blob.bin" (application/octet-stream) could not be delivered: this model does not accept this file type.]',
			},
		]);
	});
});

describe("openai — tool 结果只收文本(行为不变)", () => {
	it("图仍旧 Undeliverable 并留一条 warning", async () => {
		const turn = await turnContextFor("openai", OPENAI_MODEL);
		const delivery = codecOf("openai").toolResult(IMAGE_PART, turn);

		expect(delivery.kind).toBe("undeliverable");
		expect(
			delivery.kind === "undeliverable" ? delivery.note.reason : "",
		).toBe("tool-result-text-only");
		expect(turn.warnings.map((warning) => warning.kind)).toEqual([
			"part-undeliverable",
		]);
	});

	it("含图的 tool 消息压成一行文本摘要,不是数组", async () => {
		const turn = await turnContextFor("openai", OPENAI_MODEL);
		const message = wireToolMessage(
			codecOf("openai").toWireMessage(
				toolMessage([{ type: "text", text: "已截图。" }, IMAGE_PART]),
				turn,
			),
		);

		expect(typeof message.content).toBe("string");
		expect(message.content).toContain("已截图。");
		expect(message.content).toContain("[Image:");
	});
});

describe("能力那一半 —— core 对 tool 结果图的降级判据", () => {
	it("openrouter 声明 image,core 不再降级", async () => {
		const capabilities = await capabilitiesOf("openrouter", OPENROUTER_MODEL);

		expect(capabilities.toolResultModalities).toEqual(["text", "image"]);
		expect(capabilities.supportsStructuredToolResults).toBe(true);
		expect(agentSupportsToolResultModality(capabilities, "image")).toBe(true);
		// tool 消息里没有 `file` 块,声明里也就没有那一行。
		expect(agentSupportsToolResultModality(capabilities, "file")).toBe(false);

		// 于是重建历史时那张图留成结构块,而不是被压成 `[Image: …]` 文本。
		expect(
			agentToolMessageContentForCapabilities(
				[{ type: "text", text: "已截图。" }, IMAGE_PART],
				capabilities,
			),
		).toEqual([{ type: "text", text: "已截图。" }, IMAGE_PART]);
	});

	it("openai 不声明,core 照旧降级成文本", async () => {
		const capabilities = await capabilitiesOf("openai", OPENAI_MODEL);

		expect(capabilities.toolResultModalities).toBeUndefined();
		expect(agentSupportsToolResultModality(capabilities, "image")).toBe(false);
		expect(
			agentToolMessageContentForCapabilities(
				[{ type: "text", text: "已截图。" }, IMAGE_PART],
				capabilities,
			),
		).toBe("已截图。\n[Image: image/png data omitted: 24 chars]");
	});
});
