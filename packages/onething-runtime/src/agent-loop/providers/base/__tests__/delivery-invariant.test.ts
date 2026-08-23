/**
 * **投递契约的不变式**(设计稿 §2.3 / §9 P2 门)。
 *
 * 一句话:**能力说收得下的模态,那条线协议的 codec 就必须真的把它放进请求体。**
 * 能力(`getModelCapabilities().inputModalities` / `.toolResultModalities`)与
 * 序列化(`PartCodec.user()` / `.toolResult()`)从 P2-a 起问的是**同一个**
 * `ModelProfile`;这份用例是那句话的门 —— 一边说能看图、另一边把图换成一行
 * `[Attachment …]` 文本,在这里是红的。
 *
 * 覆盖面是**已登记的全部方言**(四条线,16 份配方),元测试守着表不许漏。
 * 只断言 `image` / `file` 两种模态:`text` 无条件可投递,`audio` / `video`
 * 只有 gemini 声明,没有第二条线可对照(设计稿说的「不在声明内的模态不做断言」
 * 反过来也成立 —— 声明了但只有一家有的,留到 P3 一起看)。
 *
 * 声明里**没有**这一模态的组合直接跳过(不是绿也不是红):core 的
 * `degradeUnsupportedAgentContentParts` 在上游就把它降级掉了,轮不到 codec。
 * 今天被这一条跳过的有:kimi / kimi-code / zhipu / deepseek 非 vision 族的
 * 全部图像用例(账本不给它们 vision),以及 openai-chat 十一家的 toolResult
 * ——`openAIChatTransportCapabilities()` 不声明 `toolResultModalities`,于是
 * 默认只有 text。要覆盖它们得先改账本/传输声明,那是行为变更。
 *
 * **今天已经违反的那些**在 `KNOWN_VIOLATIONS` 里逐条记名,用 `it.fails` 钉住:
 * 它们不是本期要改的行为(P2-a 行为不变),但从此不能再多一条,也不能悄悄修好
 * 而不更新这张表。修一条 = 从表里删一行。
 */
import { describe, expect, it } from "vitest";
import type { AgentContentPart, AgentInputModality } from "@onething/core/agent-loop";
import { getLogger } from "../../../../logging/index.js";
import {
	LedgerModelProfileResolver,
	RequestBodyBuilder,
	TurnContext,
	listDialects,
	type Dialect,
	type PartCodec,
	type WireId,
} from "../index.js";
import {
	createAgentProviderFromRuntime,
	type AgentProviderRuntimeConfig,
} from "../../factory.js";
import {
	OpenAIChatPartCodec,
	anthropicParts,
	geminiParts,
	responsesParts,
} from "../../wires/index.js";

/** 方言不给 codec 时,那条 wire 的默认 codec —— 与 `HttpAgentProvider.parts` 同源。 */
const DEFAULT_CODEC: Record<WireId, PartCodec> = {
	"openai-chat": new OpenAIChatPartCodec(),
	"openai-responses": responsesParts,
	"anthropic-messages": anthropicParts,
	"gemini-generateContent": geminiParts,
};

const IMAGE_PART: AgentContentPart = {
	type: "image",
	image: "iVBORw0KGgoAAAANSUhEUg==",
	mediaType: "image/png",
};

const FILE_PART: AgentContentPart = {
	type: "file",
	data: "JVBERi0xLjcKJcOkw7zDtsOfCg==",
	mediaType: "application/pdf",
	filename: "spec.pdf",
};

const PART: Record<"image" | "file", AgentContentPart> = {
	image: IMAGE_PART,
	file: FILE_PART,
};

interface DialectCase {
	/** 已登记的方言 id。 */
	dialect: string;
	/** 生产入口用的 provider id(`custom-*` 一份配方服务任意多个 id)。 */
	providerId: string;
	model: string;
	config: AgentProviderRuntimeConfig;
}

/** 凭据只是为了让工厂肯造 —— 这份用例一个字节都不发出去。 */
const KEY = { apiKey: "delivery-invariant-fixture" };

const CASES: DialectCase[] = [
	{ dialect: "openai", providerId: "openai", model: "gpt-4o", config: KEY },
	{
		dialect: "deepseek",
		providerId: "deepseek",
		model: "deepseek-v4-vision-exp",
		config: KEY,
	},
	{ dialect: "kimi", providerId: "kimi", model: "kimi-k2.5", config: KEY },
	{
		dialect: "kimi-code",
		providerId: "kimi-code",
		model: "kimi-k2.7-code",
		config: KEY,
	},
	{ dialect: "zhipu", providerId: "zhipu", model: "glm-4.5v", config: KEY },
	{ dialect: "qwen", providerId: "qwen", model: "qwen3.5-vl-plus", config: KEY },
	{ dialect: "grok", providerId: "grok", model: "grok-4.5", config: KEY },
	{
		dialect: "grok-oauth",
		providerId: "grok-oauth",
		model: "grok-4.5",
		config: KEY,
	},
	{
		dialect: "openrouter",
		providerId: "openrouter",
		model: "anthropic/claude-sonnet-5",
		config: KEY,
	},
	{
		dialect: "github-copilot",
		providerId: "github-copilot",
		model: "gpt-4o",
		config: KEY,
	},
	{
		dialect: "custom-openai",
		providerId: "custom-delivery-openai",
		model: "some-openai-compatible",
		config: KEY,
	},
	{ dialect: "claude", providerId: "claude", model: "claude-sonnet-5", config: KEY },
	{
		dialect: "claude-code",
		providerId: "claude-code",
		model: "claude-sonnet-5",
		config: KEY,
	},
	{
		dialect: "custom-anthropic",
		providerId: "custom-delivery-anthropic",
		model: "claude-sonnet-5",
		config: { ...KEY, apiType: "anthropic" },
	},
	{ dialect: "gemini", providerId: "gemini", model: "gemini-3-pro", config: KEY },
	{ dialect: "codex", providerId: "codex", model: "gpt-5.5", config: KEY },
];

/**
 * 今天就违反不变式的组合 —— `<dialect>/<surface>/<modality>`。
 *
 * 全部一个成因:**这些 openai-chat 方言今天投不出 PDF 块,而「有 vision」
 * 在账本里同时点亮 `image` 与 `file`**(`ModelProfile.inputModalities` 那一行:
 * `vision ? ['text','image','file'] : ['text']`)。于是 codec 只能把 PDF 留成
 * 一行可见文本(`Undeliverable`,不静默丢)。
 *
 * P3-1(PDF 文件块)删掉了其中两行 —— `openai` 与 `openrouter` 从此投真块
 * (`{type:'file',file:{filename,file_data}}`,OpenRouter 另挂 `file-parser`
 * 插件)。**剩下的六条各有各的理由,不是没做**:
 *  - `custom-openai` —— 用户自建端点,能力未知。发一个可能 400 的块比留一行
 *    可见文本坏;要开就得让用户自己声明,那是设置面的行为变更。
 *  - `github-copilot` / `grok` / `grok-oauth` / `deepseek` / `qwen` ——
 *    这几家的 chat-completions 端点没有可移植的 PDF 块(既不认 OpenAI 的
 *    `file`,也没有自己的等价物)。
 *
 * 另一条修法仍然挂着(设计稿 §10 待拍板 #12):把 `file` 从「vision ⇒ 三模态」
 * 里拆出来单记一行能力 —— 那时这六家的 `getModelCapabilities` 不再声明 `file`,
 * core 会把 PDF 降级成可见占位,这几行随之消失。是账本的行为变更,要拍板。
 */
const KNOWN_VIOLATIONS = new Set([
	"deepseek/user/file",
	"qwen/user/file",
	"grok/user/file",
	"grok-oauth/user/file",
	"github-copilot/user/file",
	"custom-openai/user/file",
]);

function dialectOf(id: string): Dialect {
	const dialect = listDialects().find((entry) => entry.id === id);
	if (!dialect) throw new Error(`dialect not registered: ${id}`);
	return dialect;
}

async function turnContextFor(testCase: DialectCase): Promise<TurnContext> {
	const profile = await new LedgerModelProfileResolver(testCase.config).resolve(
		testCase.providerId,
		testCase.model,
	);
	return new TurnContext(
		{ turn: 1, model: testCase.model, messages: [] },
		profile,
		new RequestBodyBuilder(),
		getLogger("test.delivery-invariant"),
	);
}

function declaredModalities(
	declared: AgentInputModality[] | undefined,
): Array<"image" | "file"> {
	const set = new Set(declared ?? ["text"]);
	return (["image", "file"] as const).filter((modality) => set.has(modality));
}

describe("投递契约:能力声明的模态必须真的进得了请求体", () => {
	it("每份已登记的方言都在表里(元测试)", () => {
		expect(CASES.map((entry) => entry.dialect).sort()).toEqual(
			listDialects()
				.map((entry) => entry.id)
				.sort(),
		);
	});

	for (const testCase of CASES) {
		const dialect = dialectOf(testCase.dialect);
		const codec = dialect.parts ?? DEFAULT_CODEC[dialect.wire];

		describe(testCase.dialect, () => {
			for (const surface of ["user", "toolResult"] as const) {
				for (const modality of ["image", "file"] as const) {
					const key = `${testCase.dialect}/${surface}/${modality}`;
					const runner = KNOWN_VIOLATIONS.has(key) ? it.fails : it;
					runner(`${surface} 收得下声明的 ${modality}`, async () => {
						const provider = createAgentProviderFromRuntime(
							testCase.providerId,
							testCase.config,
						);
						const capabilities = await provider!.getModelCapabilities!(
							testCase.model,
						);
						const declared =
							surface === "user"
								? declaredModalities(capabilities.inputModalities)
								: declaredModalities(capabilities.toolResultModalities);
						// 没声明这一模态 = 这条不变式对它不适用(core 的
						// `degradeUnsupportedAgentContentParts` 在上游就把它降级了)。
						if (!declared.includes(modality)) return;

						const turn = await turnContextFor(testCase);
						const delivery =
							surface === "user"
								? codec.user(PART[modality], turn)
								: codec.toolResult(PART[modality], turn);
						expect(delivery.kind, `${key} → ${JSON.stringify(delivery)}`).toBe(
							"delivered",
						);
					});
				}
			}
		});
	}
});
