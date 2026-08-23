/**
 * Kimi 的「先上传再抽取」文件通道(P4-6,`dialects/kimi-attachments.ts`)。
 *
 * 官方口径(platform.kimi.com/docs/guide/use-kimi-api-for-file-based-qa,
 * /docs/api/files-upload,/docs/api/files-content):
 *  - `POST /v1/files`,`multipart/form-data`,字段 `file` + `purpose=file-extract`;
 *  - `GET /v1/files/{id}/content` → 纯文本(`text/plain`);
 *  - **把文件内容放进 prompt 作 `role:'system'` 的一条,不要放 `file_id`**;
 *    多文件 = 多条 system,每个文件单独一条;
 *  - 单用户 1000 个文件 / 10G 的配额,官方最佳实践是抽完即删
 *    (`DELETE /v1/files/{id}`)。
 *
 * 这份用例守四件事:调用序列与请求形状、失败退回可见留痕、同回合去重、
 * 以及**谁不走这条通道**(图仍是 `image_url`,表外格式一个字节都不上传)。
 */
import { describe, expect, it, vi } from "vitest";
import type { AgentContentPart, AgentMessage } from "@onething/core/agent-loop";
import { getLogger } from "../../../../logging/index.js";
import {
	LedgerModelProfileResolver,
	RequestBodyBuilder,
	TurnContext,
	type TurnTransport,
} from "../../base/index.js";
import { kimiFileExtractChannel } from "../kimi-attachments.js";

const BASE_URL = "https://api.moonshot.cn/v1";
const FILE_ID = "file-unit-1";
const EXTRACTED = "抽取出来的正文。";

const PDF_PART: AgentContentPart = {
	type: "file",
	data: "JVBERi0xLjcKJcOkw7zDtsOfCg==",
	mediaType: "application/pdf",
	filename: "spec.pdf",
};

const IMAGE_PART: AgentContentPart = {
	type: "image",
	image: "iVBORw0KGgoAAAANSUhEUg==",
	mediaType: "image/png",
};

const ZIP_PART: AgentContentPart = {
	type: "file",
	data: "UEsDBBQAAAAA",
	mediaType: "application/zip",
	filename: "bundle.zip",
};

interface Call {
	url: string;
	method: string;
	init: RequestInit | undefined;
}

/** 三跳都答上的桩;`fail` 指名让哪一跳返回 500。 */
function transportStub(options: { fail?: "upload" | "content" } = {}): {
	transport: TurnTransport;
	calls: Call[];
} {
	const calls: Call[] = [];
	const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, method: init?.method ?? "GET", init });
		if (url.endsWith("/files") && init?.method === "POST") {
			if (options.fail === "upload") return new Response("nope", { status: 500 });
			return new Response(JSON.stringify({ id: FILE_ID, status: "ready" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		if (url.endsWith(`/files/${FILE_ID}/content`)) {
			if (options.fail === "content") return new Response("nope", { status: 404 });
			return new Response(EXTRACTED, {
				status: 200,
				headers: { "content-type": "text/plain" },
			});
		}
		if (url.endsWith(`/files/${FILE_ID}`) && init?.method === "DELETE") {
			return new Response(null, { status: 204 });
		}
		throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
	}) as unknown as typeof globalThis.fetch;

	return {
		calls,
		transport: {
			baseUrl: BASE_URL,
			fetchImpl,
			headers: async () => ({
				"Content-Type": "application/json",
				Authorization: "Bearer sk-kimi-unit",
			}),
		},
	};
}

async function turnFor(
	messages: AgentMessage[],
	transport?: TurnTransport,
): Promise<TurnContext> {
	const profile = await new LedgerModelProfileResolver({}).resolve(
		"kimi",
		"kimi-k2.6",
	);
	return new TurnContext(
		{ turn: 1, model: "kimi-k2.6", messages },
		profile,
		new RequestBodyBuilder(),
		getLogger("test.kimi-file-extract"),
		transport,
	);
}

function userWith(...parts: AgentContentPart[]): AgentMessage {
	return { role: "user", content: parts };
}

describe("KimiFileExtractChannel.handles —— 谁归这条通道管", () => {
	it("非图片的文件块,格式在官方那张表上", () => {
		expect(kimiFileExtractChannel.handles(PDF_PART)).toBe(true);
		expect(
			kimiFileExtractChannel.handles({
				type: "file",
				data: "eA==",
				mediaType: "application/octet-stream",
				filename: "notes.md",
			}),
		).toBe(true);
	});

	it("图不走这条通道 —— 它归 codec 的 image_url", () => {
		expect(kimiFileExtractChannel.handles(IMAGE_PART)).toBe(false);
		expect(
			kimiFileExtractChannel.handles({
				type: "file",
				data: "eA==",
				mediaType: "image/png",
				filename: "shot.png",
			}),
		).toBe(false);
	});

	it("表外的格式不上传 —— 传上去也抽不出东西,只会白占配额", () => {
		expect(kimiFileExtractChannel.handles(ZIP_PART)).toBe(false);
	});

	it("文本块不归它管", () => {
		expect(kimiFileExtractChannel.handles({ type: "text", text: "hi" })).toBe(false);
	});
});

describe("KimiFileExtractChannel.prepare —— 上传 → 抽取 → 插 system → 删除", () => {
	it("三跳的顺序与请求形状", async () => {
		const { transport, calls } = transportStub();
		const turn = await turnFor(
			[
				{ role: "system", content: "你是 Kimi。" },
				userWith({ type: "text", text: "读一下这份规格" }, PDF_PART),
			],
			transport,
		);
		await kimiFileExtractChannel.prepare(turn);

		// 顺序:先 POST /files,再 GET content。DELETE 是抽完之后的清理
		// (`finally` 里不 await,所以只断言前两跳的次序)。
		expect(calls[0]!.method).toBe("POST");
		expect(calls[0]!.url).toBe(`${BASE_URL}/files`);
		expect(calls[1]!.method).toBe("GET");
		expect(calls[1]!.url).toBe(`${BASE_URL}/files/${FILE_ID}/content`);

		// 上传是 multipart:`purpose=file-extract` + 字段名 `file`,
		// 且**不能**带 `Content-Type` —— boundary 要让 fetch 自己写。
		const form = calls[0]!.init!.body as FormData;
		expect(form).toBeInstanceOf(FormData);
		expect(form.get("purpose")).toBe("file-extract");
		const uploaded = form.get("file") as File;
		expect(uploaded.name).toBe("spec.pdf");
		expect(uploaded.type).toBe("application/pdf");
		const uploadHeaders = calls[0]!.init!.headers as Record<string, string>;
		expect(uploadHeaders.Authorization).toBe("Bearer sk-kimi-unit");
		expect(Object.keys(uploadHeaders)).not.toContain("Content-Type");
	});

	it("抽取文本以一条 system 落在提问的 user 之前,原块从 user 里消失", async () => {
		const { transport } = transportStub();
		const turn = await turnFor(
			[
				{ role: "system", content: "你是 Kimi。" },
				userWith({ type: "text", text: "读一下这份规格" }, PDF_PART),
			],
			transport,
		);
		await kimiFileExtractChannel.prepare(turn);

		expect(turn.messages).toEqual([
			{ role: "system", content: "你是 Kimi。" },
			{ role: "system", content: `File: spec.pdf\n${EXTRACTED}` },
			{ role: "user", content: [{ type: "text", text: "读一下这份规格" }] },
		]);
		// 上游的历史本体一个字都不动。
		expect(turn.request.messages[1]!.content).toEqual([
			{ type: "text", text: "读一下这份规格" },
			PDF_PART,
		]);
	});

	it("多文件 = 多条 system,每个文件单独一条(官方写法)", async () => {
		const { transport } = transportStub();
		const second: AgentContentPart = {
			type: "file",
			data: "b3RoZXI=",
			mediaType: "text/markdown",
			filename: "notes.md",
		};
		const turn = await turnFor(
			[userWith({ type: "text", text: "对比一下" }, PDF_PART, second)],
			transport,
		);
		await kimiFileExtractChannel.prepare(turn);

		const systems = turn.messages.filter((message) => message.role === "system");
		expect(systems).toHaveLength(2);
		expect(systems[0]!.content).toBe(`File: spec.pdf\n${EXTRACTED}`);
		expect(systems[1]!.content).toBe(`File: notes.md\n${EXTRACTED}`);
	});

	it("同一回合内按内容去重 —— 同一份文件引用两次只上传一次", async () => {
		const { transport, calls } = transportStub();
		const turn = await turnFor(
			[
				userWith({ type: "text", text: "第一次" }, PDF_PART),
				{ role: "assistant", content: "好的。" },
				userWith({ type: "text", text: "再看一次" }, { ...PDF_PART }),
			],
			transport,
		);
		await kimiFileExtractChannel.prepare(turn);

		const uploads = calls.filter((call) => call.method === "POST");
		expect(uploads).toHaveLength(1);
		// 但两条 user 各自都拿到了自己那条 system。
		expect(
			turn.messages.filter((message) => message.role === "system"),
		).toHaveLength(2);
	});

	it("图与表外格式不进通道,原样留在 user 消息里", async () => {
		const { transport, calls } = transportStub();
		const turn = await turnFor(
			[userWith({ type: "text", text: "看看" }, IMAGE_PART, ZIP_PART)],
			transport,
		);
		await kimiFileExtractChannel.prepare(turn);

		expect(calls).toHaveLength(0);
		expect(turn.messages).toHaveLength(1);
		expect(turn.messages[0]!.content).toEqual([
			{ type: "text", text: "看看" },
			IMAGE_PART,
			ZIP_PART,
		]);
	});
});

describe("KimiFileExtractChannel —— 失败退回可见留痕,不抛", () => {
	for (const step of ["upload", "content"] as const) {
		it(`${step} 失败 ⇒ 块留在原地 + attachment-extract-failed`, async () => {
			const { transport } = transportStub({ fail: step });
			const turn = await turnFor(
				[userWith({ type: "text", text: "读一下" }, PDF_PART)],
				transport,
			);
			await expect(kimiFileExtractChannel.prepare(turn)).resolves.toBeUndefined();

			// 没有 system 被插进去,PDF 块原样留下 —— codec 会把它落成
			// `[Attachment …]` 可见文本(投递契约,§2.3)。
			expect(turn.messages.some((message) => message.role === "system")).toBe(false);
			expect(turn.messages[0]!.content).toEqual([
				{ type: "text", text: "读一下" },
				PDF_PART,
			]);
			expect(turn.warnings.map((warning) => warning.kind)).toContain(
				"attachment-extract-failed",
			);
		});
	}

	it("没有副请求通道(transport 缺席)⇒ 同样是留痕降级", async () => {
		const turn = await turnFor([userWith(PDF_PART)]);
		await kimiFileExtractChannel.prepare(turn);

		expect(turn.messages[0]!.content).toEqual([PDF_PART]);
		expect(turn.warnings.map((warning) => warning.kind)).toContain(
			"attachment-extract-failed",
		);
	});

	it("没有附件的回合零副请求", async () => {
		const { transport, calls } = transportStub();
		const turn = await turnFor(
			[{ role: "user", content: "就聊天。" }],
			transport,
		);
		await kimiFileExtractChannel.prepare(turn);

		expect(calls).toHaveLength(0);
		expect(turn.messages).toEqual(turn.request.messages);
	});
});
