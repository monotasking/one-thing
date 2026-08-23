/**
 * **文件输入 = 目录 ∧ 线路**(P4-1,拍板 #12)。
 *
 * 两个条件都要,少一个都不许声明 `file-input`:
 *  - **目录**(账本的 `fileInput`,`resolveOnethingModelCapabilities`)——
 *    这个**模型**收得下文件吗。证据是目录条目自己的 `inputModalities`:含
 *    `'pdf'`/`'file'` = 收;有这张表但不含 = **不收**(条目枚举的就是它吃什么,
 *    这里的缺席是回答,不是沉默);表缺席 = 账本没话说。
 *  - **线路**(这条方言的传输声明,`OpenAIChatTransportFlags.file` / 各线自己的
 *    传输常量)—— 这只 codec 投得出 `{type:'file'}` 块吗。
 *
 * 账本沉默时退回线路自己的声明(= P4-1 之前的默认行为);账本明说不收,就算线路
 * 发得出去也不声明。两半在 `ModelProfile.toAgentModelCapabilities` 里合一。
 *
 * 为什么要拆:在这之前 `file` 是 `vision` 的搭车项 —— 账本说模型看得懂图,
 * `getModelCapabilities()` 就顺手声明 `file-input` + `file` 模态。于是六家
 * openai-chat 端点(deepseek / qwen / grok / grok-oauth / github-copilot /
 * custom-openai)对上游说「PDF 我收得下」,而它们的 codec 一个 `file` 块都投不
 * 出去:core 的 `degradeUnsupportedAgentContentParts` 因此不降级,PDF 一路走到
 * codec,只能留一行 `[Attachment … could not be delivered …]`。那六格就是
 * `delivery-invariant.test.ts` 里曾经的 `KNOWN_VIOLATIONS`(现已清空)。
 *
 * 这份用例钉住两端:谁声明、谁不声明,以及不声明的那一端 core 会给出什么 ——
 * 一句人话占位,而不是一段谎。
 */
import { describe, expect, it } from "vitest";
import {
	agentMessagesFromHistory,
	type AgentModelCapabilities,
} from "@onething/core/agent-loop";
import {
	createAgentProviderFromRuntime,
	type AgentProviderRuntimeConfig,
} from "../../factory.js";

/** 凭据只为让工厂肯造 —— 这份用例一个字节都不发出去。 */
const KEY: AgentProviderRuntimeConfig = { apiKey: "file-input-declaration-fixture" };

/** 目录条目:models.dev 的 `modalities.input` 落到 entry 上就是这张表。 */
function catalog(
	model: string,
	inputModalities: string[],
): AgentProviderRuntimeConfig {
	return { ...KEY, models: { [model]: { inputModalities } } };
}

async function capabilitiesOf(
	providerId: string,
	model: string,
	config: AgentProviderRuntimeConfig = KEY,
): Promise<AgentModelCapabilities> {
	const provider = createAgentProviderFromRuntime(providerId, config);
	if (!provider?.getModelCapabilities) {
		throw new Error(`provider missing getModelCapabilities: ${providerId}`);
	}
	return provider.getModelCapabilities(model);
}

function declaresFile(capabilities: AgentModelCapabilities): boolean {
	return (
		capabilities.capabilities.includes("file-input") ||
		capabilities.inputModalities.includes("file")
	);
}

/** 目录说收 ∧ 线路投得出 —— 声明 `file-input` 是诚实的。 */
const BOTH_HALVES: Array<{
	providerId: string;
	model: string;
	why: string;
}> = [
	{ providerId: "openai", model: "gpt-5.5", why: "chat-completions 认 file 内容块" },
	{
		providerId: "openrouter",
		model: "anthropic/claude-sonnet-5",
		why: "网关按 OpenAI 形状转发 file 块(另挂 file-parser)",
	},
	{ providerId: "claude", model: "claude-sonnet-5", why: "anthropic document 块" },
	{ providerId: "gemini", model: "gemini-3-pro", why: "inlineData 收 application/pdf" },
	{ providerId: "codex", model: "gpt-5.5", why: "responses input_file" },
	// xAI 的两条通路 P4-4 换到 openai-responses 之后**真的投得出 PDF**:
	// `input_file` 是那条线的通道,chat-completions 上没有。这两行从
	// `WIRE_CANNOT` 挪过来 —— 换线把一句谎变成了一句真话。
	{ providerId: "grok", model: "grok-4.6", why: "responses input_file" },
	{ providerId: "grok-oauth", model: "grok-4.6", why: "responses input_file" },
];

/**
 * 线路投不出 PDF 的几家 —— 目录说什么都不声明。它们全是 P4-1 之前的说谎者:
 * 账本给了 vision,于是 `file` 搭车上了车。
 */
const WIRE_CANNOT: Array<{ providerId: string; model: string }> = [
	{ providerId: "deepseek", model: "deepseek-v4-flash-vision-exp" },
	{ providerId: "qwen", model: "qwen3.5-vl-plus" },
	{ providerId: "github-copilot", model: "gpt-4o" },
];

describe("文件输入的声明面:目录 ∧ 线路(拍板 #12)", () => {
	for (const { providerId, model, why } of BOTH_HALVES) {
		it(`${providerId}/${model} 目录含 pdf + 线路投得出 ⇒ 声明 —— ${why}`, async () => {
			const capabilities = await capabilitiesOf(
				providerId,
				model,
				catalog(model, ["text", "image", "pdf"]),
			);
			expect(capabilities.capabilities).toContain("file-input");
			expect(capabilities.inputModalities).toContain("file");
		});
	}

	for (const { providerId, model } of WIRE_CANNOT) {
		it(`${providerId}/${model} 线路投不出 ⇒ 目录说收也不声明`, async () => {
			const capabilities = await capabilitiesOf(
				providerId,
				model,
				catalog(model, ["text", "image", "pdf"]),
			);
			expect(declaresFile(capabilities)).toBe(false);
		});
	}

	it("gpt-5.5 经 openai 声明 file,同一个模型经 github-copilot 不声明", async () => {
		const model = "gpt-5.5";
		const config = catalog(model, ["text", "image", "pdf"]);
		expect(declaresFile(await capabilitiesOf("openai", model, config))).toBe(true);
		expect(declaresFile(await capabilitiesOf("github-copilot", model, config))).toBe(
			false,
		);
	});

	it("deepseek-v4-flash-vision-exp:目录无 pdf ⇒ 不声明 file,但声明 image", async () => {
		const model = "deepseek-v4-flash-vision-exp";
		const capabilities = await capabilitiesOf(
			"deepseek",
			model,
			catalog(model, ["text", "image"]),
		);
		expect(capabilities.inputModalities).toContain("image");
		expect(capabilities.capabilities).toContain("vision-input");
		expect(declaresFile(capabilities)).toBe(false);
	});

	it("目录说不收 ⇒ 线路发得出去也不声明(claude + ['text','image'])", async () => {
		const model = "claude-sonnet-5";
		const capabilities = await capabilitiesOf(
			"claude",
			model,
			catalog(model, ["text", "image"]),
		);
		expect(declaresFile(capabilities)).toBe(false);
		// 图还在 —— 拆开的是 file,不是 vision。
		expect(capabilities.inputModalities).toContain("image");
	});

	it("目录缺席 ⇒ 按线路自己的声明(账本沉默不等于否决)", async () => {
		expect(declaresFile(await capabilitiesOf("claude", "claude-sonnet-5"))).toBe(true);
		expect(declaresFile(await capabilitiesOf("gemini", "gemini-3-pro"))).toBe(true);
		expect(declaresFile(await capabilitiesOf("codex", "gpt-5.5"))).toBe(true);
		expect(declaresFile(await capabilitiesOf("openai", "gpt-4o"))).toBe(true);
		// 这条线上另外十家的传输声明里没有 file —— 目录缺席也补不出来。
		expect(declaresFile(await capabilitiesOf("qwen", "qwen3.5-vl-plus"))).toBe(false);
		expect(
			declaresFile(
				await capabilitiesOf("deepseek", "deepseek-v4-flash-vision-exp"),
			),
		).toBe(false);
	});

	/**
	 * **抽取通道是第三种答案**(P4-6)。
	 *
	 * kimi / kimi-code 的 chat-completions 上没有 `file` 内容块,但它们有旁路:
	 * 先 `POST /v1/files`(`purpose=file-extract`)再把抽出来的**文本**以一条
	 * `role:'system'` 放进 prompt。模型自始至终只见到文本,所以「这个模型的目录
	 * 里有没有 pdf」不是判据 —— 配方的 `fileViaExtraction` 让账本对这条线没有
	 * 否决权。
	 *
	 * 这一条很要紧:models.dev 给 Kimi 的 `modalities.input` 只有 text(/image),
	 * 而目录**压过**规则表(`resolveCapability` 的顺序:override → registry →
	 * rules → default)。不拆这一条的话文件永远进不来 —— core 会在上游把 PDF
	 * 降级成 `[File: x.pdf]` 占位,通道拿不到字节。
	 */
	for (const providerId of ["kimi", "kimi-code"] as const) {
		it(`${providerId} 靠抽取通道收文件 ⇒ 目录不含 pdf 也声明`, async () => {
			const model = providerId === "kimi" ? "kimi-k2.6" : "kimi-k2.7-code";
			const capabilities = await capabilitiesOf(
				providerId,
				model,
				catalog(model, ["text", "image"]),
			);
			expect(capabilities.capabilities).toContain("file-input");
			expect(capabilities.inputModalities).toContain("file");
		});

		it(`${providerId} 目录含 pdf ⇒ 同样声明(两条路同解)`, async () => {
			const model = providerId === "kimi" ? "kimi-k2.6" : "kimi-k2.7-code";
			const capabilities = await capabilitiesOf(
				providerId,
				model,
				catalog(model, ["text", "image", "pdf"]),
			);
			expect(declaresFile(capabilities)).toBe(true);
		});

		it(`${providerId} 目录缺席 ⇒ 仍然声明(线路自己就收得下)`, async () => {
			const model = providerId === "kimi" ? "kimi-k2.6" : "kimi-k2.7-code";
			expect(declaresFile(await capabilitiesOf(providerId, model))).toBe(true);
		});
	}

	/**
	 * 抽取通道拿掉的是**账本**的否决权,不是用户的:显式 override 仍然一票否决
	 * (那是人按的开关,不是目录的猜测)。
	 */
	it("用户 override 关得掉 kimi 的文件输入", async () => {
		const capabilities = await capabilitiesOf("kimi", "kimi-k2.6", {
			...KEY,
			modelCapabilitiesByModel: { "kimi-k2.6": { fileInput: false } },
		});
		expect(declaresFile(capabilities)).toBe(false);
	});

	it("custom-openai(用户自建端点)不声明 file", async () => {
		const capabilities = await capabilitiesOf(
			"custom-file-input-probe",
			"some-openai-compatible",
		);
		expect(declaresFile(capabilities)).toBe(false);
	});

	it("用户 override 能单独关掉文件输入", async () => {
		const capabilities = await capabilitiesOf("claude", "claude-sonnet-5", {
			...KEY,
			modelCapabilitiesByModel: { "claude-sonnet-5": { fileInput: false } },
		});
		expect(declaresFile(capabilities)).toBe(false);
		expect(capabilities.inputModalities).toContain("image");
	});

	it("账本关掉 vision 不牵连 file —— 两条能力互不搭车", async () => {
		const capabilities = await capabilitiesOf("claude", "claude-sonnet-5", {
			...KEY,
			modelCapabilitiesByModel: { "claude-sonnet-5": { vision: false } },
		});
		expect(capabilities.inputModalities).not.toContain("image");
		expect(capabilities.capabilities).not.toContain("vision-input");
		expect(capabilities.capabilities).toContain("file-input");
		expect(capabilities.inputModalities).toContain("file");
	});
});

describe("不声明的那一端:core 给可见占位,而不是让 codec 编一段谎", () => {
	const PDF_MESSAGE = [
		{
			role: "user" as const,
			content: [
				{ type: "text", text: "读一下这份规格" },
				{
					type: "file",
					data: "JVBERi0xLjcKJcOkw7zDtsOfCg==",
					mediaType: "application/pdf",
					filename: "spec.pdf",
				},
			],
		},
	];

	it("deepseek(账本有 vision、线投不出 PDF)→ [File: spec.pdf]", async () => {
		const capabilities = await capabilitiesOf(
			"deepseek",
			"deepseek-v4-flash-vision-exp",
		);
		const [message] = agentMessagesFromHistory(PDF_MESSAGE, capabilities);

		expect(message?.content).toEqual([
			{ type: "text", text: "读一下这份规格" },
			{ type: "text", text: "[File: spec.pdf]" },
		]);
	});

	it("openai(目录说收 + 线投得出)→ 文件块原样递给 codec", async () => {
		const capabilities = await capabilitiesOf(
			"openai",
			"gpt-5.5",
			catalog("gpt-5.5", ["text", "image", "pdf"]),
		);
		const [message] = agentMessagesFromHistory(PDF_MESSAGE, capabilities);
		const parts = message?.content;

		expect(Array.isArray(parts)).toBe(true);
		expect((parts as Array<{ type: string }>)[1]?.type).toBe("file");
	});
});
