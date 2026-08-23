/**
 * **PDF 文件块**(设计稿 §5.1 文件/PDF 行,P3-1)。
 *
 * 一句话:chat-completions 这条线上,认 `file` 块的家把 PDF 真的放进请求体,
 * 不认的家继续留一行可见文本 —— 而「认不认」是**方言的一个开关**
 * (`filePdf`),不是 codec 里的 `if (providerId === …)`。
 *
 * 三件事各有各的门:
 *  1. 块本身(`{type:'file',file:{filename,file_data}}`)—— 直接问 codec;
 *  2. 开关关着的家仍旧 `Undeliverable` 且留 warning —— 同上;
 *  3. OpenRouter 的 `plugins: file-parser` —— 走**生产入口**发一次真请求,
 *     断言它长在**顶层请求体**上。这条必须端到端:标记是 codec 在
 *     `user()` 里记的,请求体是 `extraBody` 写的,中间隔着模板方法的顺序
 *     (先 `buildBody` 再 `extraBody`),只测 codec 证明不了它。
 */
import { describe, expect, it } from "vitest";
import type { AgentContentPart, AgentMessage } from "@onething/core/agent-loop";
import { getLogger } from "../../../../logging/index.js";
import {
	LedgerModelProfileResolver,
	RequestBodyBuilder,
	TurnContext,
	listDialects,
	type PartCodec,
	type PartDelivery,
} from "../../base/index.js";
import {
	captureWireRequest,
	sseResponse,
	SYSTEM_MESSAGE,
} from "../../__tests__/wire-snapshots/snapshot-harness.js";
import type { OpenAIChatUserContentPart } from "../openai-chat-messages.js";

const PDF_PART: AgentContentPart = {
	type: "file",
	data: "JVBERi0xLjcKJcOkw7zDtsOfCg==",
	mediaType: "application/pdf",
	filename: "spec.pdf",
};

/** 文件名缺席时的兜底(`document.pdf`),顺带钉住带参数的媒体类型也认。 */
const PDF_PART_NO_FILENAME: AgentContentPart = {
	type: "file",
	data: "JVBERi0xLjcKJcOkw7zDtsOfCg==",
	mediaType: "application/pdf; qualifier=archival",
};

const BINARY_PART: AgentContentPart = {
	type: "file",
	data: "AAECAwQ=",
	mediaType: "application/octet-stream",
	filename: "blob.bin",
};

const PDF_USER_MESSAGE: AgentMessage = {
	role: "user",
	content: [{ type: "text", text: "读一下这份 PDF。" }, PDF_PART],
};

const MINIMAL_STREAM = `data: ${JSON.stringify({
	choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
})}\n\ndata: [DONE]\n\n`;

/** 已登记方言的 codec —— 与生产走的是同一只对象(配方里那只)。 */
function codecOf(dialectId: string): PartCodec {
	const dialect = listDialects().find((entry) => entry.id === dialectId);
	if (!dialect?.parts) throw new Error(`dialect has no codec: ${dialectId}`);
	return dialect.parts;
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
		getLogger("test.pdf-file-block"),
	);
}

function deliveredPart(
	delivery: PartDelivery<unknown>,
): OpenAIChatUserContentPart {
	expect(delivery.kind, JSON.stringify(delivery)).toBe("delivered");
	return (delivery as { part: OpenAIChatUserContentPart }).part;
}

describe("openai-chat — PDF 文件块", () => {
	it("openai:PDF 落成 file 块,filename 与 data URI 都对", async () => {
		const turn = await turnContextFor("openai", "gpt-5.5");
		const part = deliveredPart(codecOf("openai").user(PDF_PART, turn));

		expect(part).toEqual({
			type: "file",
			file: {
				filename: "spec.pdf",
				file_data: "data:application/pdf;base64,JVBERi0xLjcKJcOkw7zDtsOfCg==",
			},
		});
		expect(turn.warnings).toEqual([]);
	});

	it("openai:没有 filename 就叫 document.pdf,带参数的媒体类型照样认", async () => {
		const turn = await turnContextFor("openai", "gpt-5.5");
		const part = deliveredPart(
			codecOf("openai").user(PDF_PART_NO_FILENAME, turn),
		);

		expect(part).toEqual({
			type: "file",
			file: {
				filename: "document.pdf",
				file_data: "data:application/pdf;base64,JVBERi0xLjcKJcOkw7zDtsOfCg==",
			},
		});
	});

	it("openai:非 PDF 的二进制仍旧 Undeliverable,并留一条 warning", async () => {
		const turn = await turnContextFor("openai", "gpt-5.5");
		const delivery = codecOf("openai").user(BINARY_PART, turn);

		expect(delivery.kind).toBe("undeliverable");
		expect(
			delivery.kind === "undeliverable" ? delivery.note.toText() : "",
		).toContain('[Attachment "blob.bin" (application/octet-stream)');
		expect(turn.warnings.map((warning) => warning.kind)).toEqual([
			"part-undeliverable",
		]);
	});

	it("deepseek:开关没开,PDF 仍旧 Undeliverable", async () => {
		const turn = await turnContextFor("deepseek", "deepseek-v4-vision-exp");
		const delivery = codecOf("deepseek").user(PDF_PART, turn);

		expect(delivery.kind).toBe("undeliverable");
		expect(turn.notes.size).toBe(0);
	});
});

describe("openrouter — file 块 + file-parser 插件", () => {
	it("投了 PDF 就挂顶层 plugins", async () => {
		const dump = await captureWireRequest({
			providerId: "openrouter",
			config: { apiKey: "sk-openrouter-fixture", model: "openai/gpt-5.5" },
			request: {
				model: "openai/gpt-5.5",
				turn: 1,
				messages: [SYSTEM_MESSAGE, PDF_USER_MESSAGE],
			},
			respond: () => sseResponse(MINIMAL_STREAM),
		});
		const body = dump.requestBody as {
			plugins?: unknown;
			messages: Array<{ role: string; content: unknown }>;
		};

		expect(body.plugins).toEqual([
			{ id: "file-parser", pdf: { engine: "native" } },
		]);
		expect(body.messages[1]!.content).toEqual([
			{ type: "text", text: "读一下这份 PDF。" },
			{
				type: "file",
				file: {
					filename: "spec.pdf",
					file_data: "data:application/pdf;base64,JVBERi0xLjcKJcOkw7zDtsOfCg==",
				},
			},
		]);
	});

	it("这一回合没有 PDF 就一个字节都不多发", async () => {
		const dump = await captureWireRequest({
			providerId: "openrouter",
			config: { apiKey: "sk-openrouter-fixture", model: "openai/gpt-5.5" },
			request: {
				model: "openai/gpt-5.5",
				turn: 1,
				messages: [SYSTEM_MESSAGE, { role: "user", content: "在吗?" }],
			},
			respond: () => sseResponse(MINIMAL_STREAM),
		});

		expect(dump.requestBody).not.toHaveProperty("plugins");
	});
});
